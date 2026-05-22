#!/usr/bin/env python3
"""Load WordPress.org ecosystem JSONL snapshots into DuckDB.

Reads the JSONL emitted by ``meltano run tap-wordpress-org target-jsonl``
and writes seven append-only, date-stamped snapshot tables into a DuckDB
database file.

The job is idempotent: re-running it for the same snapshot date deletes
that date's existing rows before inserting, so a retried CI job replaces
rather than duplicates a snapshot.

SQL is kept standard/portable -- no DuckDB-only functions -- so the
tables can later be moved to Postgres unchanged (see README.md). The only
DuckDB-specific dependency is the Python ``duckdb`` driver used here.

Usage:
    python scripts/load_snapshot.py --input output --db catalog.duckdb [--date YYYY-MM-DD]
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone

import duckdb


# --------------------------------------------------------------------------
# Value coercion helpers.
#
# Every field is also preserved verbatim in each table's `raw` JSON column,
# so these helpers can fail soft (return None) without ever losing data --
# the extracted columns are a convenience, `raw` is the source of truth.
# --------------------------------------------------------------------------

def text(value):
    """Return a scalar as a string; serialise dicts/lists to JSON text."""
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, (dict, list)):
        return json.dumps(value, separators=(",", ":"), sort_keys=True)
    return str(value)


def to_int(value):
    """Best-effort integer conversion; None when not parseable."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        cleaned = value.strip().replace(",", "").replace("+", "")
        if not cleaned:
            return None
        try:
            return int(cleaned)
        except ValueError:
            try:
                return int(float(cleaned))
            except ValueError:
                return None
    return None


def to_float(value):
    """Best-effort float conversion; None when not parseable."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        cleaned = value.strip().replace(",", "").replace("%", "")
        if not cleaned:
            return None
        try:
            return float(cleaned)
        except ValueError:
            return None
    return None


def jsonify(value):
    """Serialise a value to a JSON string for a JSON-typed column."""
    if value is None:
        return None
    return json.dumps(value, separators=(",", ":"), sort_keys=True)


# --------------------------------------------------------------------------
# Stream -> table definitions.
#
# Each column is (name, sql_type, is_json, extractor). The extractor
# receives the full record dict. A `snapshot_date DATE` column is appended
# to every table automatically and is part of every table's index key.
# --------------------------------------------------------------------------

STREAMS = {
    # Catalog: one row per plugin. active_installs is BUCKETED by
    # WordPress.org (e.g. 1,000,000+), not an exact count.
    "plugins": {
        "table": "plugin_snapshots",
        "key": "slug",
        "columns": [
            ("slug", "VARCHAR", False, lambda r: text(r.get("slug"))),
            ("name", "VARCHAR", False, lambda r: text(r.get("name"))),
            ("active_installs", "BIGINT", False, lambda r: to_int(r.get("active_installs"))),
            ("downloaded", "BIGINT", False, lambda r: to_int(r.get("downloaded"))),
            ("rating", "DOUBLE", False, lambda r: to_float(r.get("rating"))),
            ("num_ratings", "BIGINT", False, lambda r: to_int(r.get("num_ratings"))),
            ("requires", "VARCHAR", False, lambda r: text(r.get("requires"))),
            ("tested", "VARCHAR", False, lambda r: text(r.get("tested"))),
            ("requires_php", "VARCHAR", False, lambda r: text(r.get("requires_php"))),
            ("last_updated", "VARCHAR", False, lambda r: text(r.get("last_updated"))),
            ("added", "VARCHAR", False, lambda r: text(r.get("added"))),
            ("author", "VARCHAR", False, lambda r: text(r.get("author"))),
            ("ratings", "JSON", True, lambda r: jsonify(r.get("ratings"))),
            ("raw", "JSON", True, jsonify),
        ],
    },
    # Catalog: one row per theme. Themes have no active_installs, and
    # `author` / `parent` arrive as objects -- stored as JSON.
    "themes": {
        "table": "theme_snapshots",
        "key": "slug",
        "columns": [
            ("slug", "VARCHAR", False, lambda r: text(r.get("slug"))),
            ("name", "VARCHAR", False, lambda r: text(r.get("name"))),
            ("version", "VARCHAR", False, lambda r: text(r.get("version"))),
            ("downloaded", "BIGINT", False, lambda r: to_int(r.get("downloaded"))),
            ("rating", "DOUBLE", False, lambda r: to_float(r.get("rating"))),
            ("num_ratings", "BIGINT", False, lambda r: to_int(r.get("num_ratings"))),
            ("requires", "VARCHAR", False, lambda r: text(r.get("requires"))),
            ("requires_php", "VARCHAR", False, lambda r: text(r.get("requires_php"))),
            ("last_updated", "VARCHAR", False, lambda r: text(r.get("last_updated"))),
            ("last_updated_time", "VARCHAR", False, lambda r: text(r.get("last_updated_time"))),
            ("preview_url", "VARCHAR", False, lambda r: text(r.get("preview_url"))),
            ("screenshot_url", "VARCHAR", False, lambda r: text(r.get("screenshot_url"))),
            ("homepage", "VARCHAR", False, lambda r: text(r.get("homepage"))),
            ("parent", "JSON", True, lambda r: jsonify(r.get("parent"))),
            ("author", "JSON", True, lambda r: jsonify(r.get("author"))),
            ("raw", "JSON", True, jsonify),
        ],
    },
    # Catalog: one row per block pattern. The pattern record shape varies,
    # so only the stable scalar fields are extracted -- `raw` is the
    # safety net that captures everything else.
    "patterns": {
        "table": "pattern_snapshots",
        "key": "id",
        "columns": [
            ("id", "BIGINT", False, lambda r: to_int(r.get("id"))),
            ("title", "VARCHAR", False, lambda r: text(r.get("title"))),
            ("content", "VARCHAR", False, lambda r: text(r.get("content"))),
            ("raw", "JSON", True, jsonify),
        ],
    },
    # Ecosystem stats: small whole-ecosystem version distributions.
    "wordpress_stats": {
        "table": "wordpress_stats_snapshots",
        "key": "version",
        "columns": [
            ("version", "VARCHAR", False, lambda r: text(r.get("version"))),
            ("count", "BIGINT", False, lambda r: to_int(r.get("count"))),
            ("percent", "DOUBLE", False, lambda r: to_float(r.get("percent"))),
            ("raw", "JSON", True, jsonify),
        ],
    },
    "php_stats": {
        "table": "php_stats_snapshots",
        "key": "version",
        "columns": [
            ("version", "VARCHAR", False, lambda r: text(r.get("version"))),
            ("count", "BIGINT", False, lambda r: to_int(r.get("count"))),
            ("percent", "DOUBLE", False, lambda r: to_float(r.get("percent"))),
            ("raw", "JSON", True, jsonify),
        ],
    },
    "mysql_stats": {
        "table": "mysql_stats_snapshots",
        "key": "version",
        "columns": [
            ("version", "VARCHAR", False, lambda r: text(r.get("version"))),
            ("count", "BIGINT", False, lambda r: to_int(r.get("count"))),
            ("percent", "DOUBLE", False, lambda r: to_float(r.get("percent"))),
            ("raw", "JSON", True, jsonify),
        ],
    },
    "locale_stats": {
        "table": "locale_stats_snapshots",
        "key": "locale",
        "columns": [
            ("locale", "VARCHAR", False, lambda r: text(r.get("locale"))),
            ("count", "BIGINT", False, lambda r: to_int(r.get("count"))),
            ("percent", "DOUBLE", False, lambda r: to_float(r.get("percent"))),
            ("raw", "JSON", True, jsonify),
        ],
    },
}

# Plugins and themes must always return data -- an empty result means the
# extract is broken. Patterns and the four stats streams can legitimately
# be small, so they only warn.
REQUIRED_STREAMS = ("plugins", "themes")


# --------------------------------------------------------------------------
# JSONL reading.
# --------------------------------------------------------------------------

def stream_from_filename(path):
    """Derive a stream name from a target-jsonl output filename."""
    stem = os.path.splitext(os.path.basename(path))[0]
    # Strip a trailing target-jsonl timestamp suffix if one is present.
    return re.sub(r"-\d{8}T\d{6}$", "", stem)


def iter_records(input_dir):
    """Yield (stream_name, record_dict) for every record under input_dir.

    Handles both target-jsonl output (one bare record per line, stream
    inferred from the filename) and raw Singer message streams (each line
    a wrapper carrying its own `stream` field).
    """
    files = sorted(glob.glob(os.path.join(input_dir, "*.jsonl")))
    if not files:
        raise SystemExit(f"ERROR: no .jsonl files found in '{input_dir}'.")

    for path in files:
        file_stream = stream_from_filename(path)
        with open(path, "r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                obj = json.loads(line)
                if not isinstance(obj, dict):
                    continue
                msg_type = obj.get("type")
                if msg_type == "RECORD":
                    yield obj.get("stream", file_stream), obj.get("record", {})
                elif msg_type in ("SCHEMA", "STATE", "ACTIVATE_VERSION"):
                    continue  # Singer control message -- not data.
                elif "record" in obj and "stream" in obj:
                    yield obj["stream"], obj["record"]
                else:
                    # A bare record -- the stream comes from the filename.
                    yield file_stream, obj


# --------------------------------------------------------------------------
# Loading.
# --------------------------------------------------------------------------

def create_table(con, spec):
    """Create a snapshot table and its (key, snapshot_date) index."""
    table = spec["table"]
    cols = ",\n    ".join(f"{name} {sql_type}" for name, sql_type, _, _ in spec["columns"])
    con.execute(
        f"CREATE TABLE IF NOT EXISTS {table} (\n    {cols},\n    snapshot_date DATE\n)"
    )
    con.execute(
        f"CREATE INDEX IF NOT EXISTS idx_{table} "
        f"ON {table} ({spec['key']}, snapshot_date)"
    )


def load_stream(con, spec, records, snapshot_date):
    """Idempotently replace one stream's rows for the given snapshot date."""
    table = spec["table"]
    columns = spec["columns"]

    # Idempotency: clear any existing rows for this date first, so a
    # retried job replaces the snapshot rather than duplicating it.
    con.execute(f"DELETE FROM {table} WHERE snapshot_date = ?", [snapshot_date])

    col_names = [name for name, _, _, _ in columns] + ["snapshot_date"]
    placeholders = ["CAST(? AS JSON)" if is_json else "?"
                    for _, _, is_json, _ in columns] + ["?"]
    insert_sql = (
        f"INSERT INTO {table} ({', '.join(col_names)}) "
        f"VALUES ({', '.join(placeholders)})"
    )

    rows = [
        [extractor(record) for _, _, _, extractor in columns] + [snapshot_date]
        for record in records
    ]
    if rows:
        con.executemany(insert_sql, rows)
    return len(rows)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", default="output",
                        help="Directory containing the tap's JSONL output.")
    parser.add_argument("--db", default="catalog.duckdb",
                        help="Path to the DuckDB database file.")
    parser.add_argument("--date", default=None,
                        help="Snapshot date as YYYY-MM-DD (default: today UTC).")
    args = parser.parse_args()

    if args.date:
        snapshot_date = datetime.strptime(args.date, "%Y-%m-%d").date()
    else:
        snapshot_date = datetime.now(timezone.utc).date()

    # Group every record by stream before touching the database.
    records_by_stream = defaultdict(list)
    for stream, record in iter_records(args.input):
        if stream in STREAMS:
            records_by_stream[stream].append(record)
        else:
            print(f"WARNING: ignoring records for unknown stream '{stream}'.",
                  file=sys.stderr)

    # Fail loudly BEFORE writing anything if a required stream is empty.
    for stream in REQUIRED_STREAMS:
        if not records_by_stream.get(stream):
            raise SystemExit(
                f"ERROR: required stream '{stream}' produced zero records -- "
                f"the extract looks broken. Refusing to commit this snapshot."
            )

    # Optional streams only warn when empty.
    for stream in STREAMS:
        if stream not in REQUIRED_STREAMS and not records_by_stream.get(stream):
            print(f"WARNING: stream '{stream}' produced zero records.",
                  file=sys.stderr)

    print(f"Loading snapshot for {snapshot_date} into {args.db}")
    con = duckdb.connect(args.db)
    try:
        con.execute("BEGIN TRANSACTION")
        for stream, spec in STREAMS.items():
            create_table(con, spec)
            count = load_stream(con, spec, records_by_stream.get(stream, []),
                                snapshot_date)
            print(f"  {spec['table']:<26} {count:>8,} rows")
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise
    finally:
        con.close()

    print("Snapshot load complete.")


if __name__ == "__main__":
    main()
