#!/usr/bin/env python3
"""Export dashboard data files from the DuckDB catalog.

Reads ``catalog.duckdb`` and writes a set of static JSON files that the
``docs/`` dashboard fetches directly: a search index, sharded per-entity
time series, and ecosystem-stats trends. The heavy ``raw`` JSON columns
are never exported -- only the metric fields the dashboard charts.

Output is rebuilt from scratch on every run and is NOT committed to git
(see .gitignore); the Pages workflow regenerates and deploys it.

Layout written under ``--out`` (default ``docs/data``):
    index.json        {generated, snapshots[], shards, counts,
                       plugins[[slug,name,shard]], themes[[slug,name,shard]]}
    p/<shard>.json     {slug: [[date, active_installs, downloaded,
                                rating, num_ratings], ...]}
    h/<shard>.json     {slug: [[date, rating, num_ratings], ...]}
    stats.json        {wordpress|php|mysql|locale: [{d, dist[[label,pct]]}]}

Themes carry no ``downloaded`` (all NULL at source) and no
``active_installs`` column, so their series omit both.

Usage:
    python scripts/export_dashboard.py --db catalog.duckdb --out docs/data
"""
from __future__ import annotations

import argparse
import json
import shutil
import zlib
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import duckdb


def jdump(path: Path, obj) -> None:
    """Write ``obj`` as compact JSON."""
    path.write_text(json.dumps(obj, separators=(",", ":")), encoding="utf-8")


def export(db_path: str, out_dir: str, shards: int):
    con = duckdb.connect(db_path, read_only=True)
    out = Path(out_dir)
    # Rebuild from scratch so renamed/removed shards never linger.
    if out.exists():
        shutil.rmtree(out)
    (out / "p").mkdir(parents=True)
    (out / "h").mkdir(parents=True)

    def shard_of(slug: str) -> int:
        return zlib.crc32(slug.encode("utf-8")) % shards

    index = {"plugins": [], "themes": []}

    # ---- plugins: per-entity series + index entries ---------------------
    plugin_series: dict[str, list] = defaultdict(list)
    for slug, date, ai, dl, rating, nr in con.execute(
        "SELECT slug, snapshot_date, active_installs, downloaded, rating, "
        "num_ratings FROM plugin_snapshots ORDER BY slug, snapshot_date"
    ).fetchall():
        plugin_series[slug].append([date.isoformat(), ai, dl, rating, nr])
    plugin_names = dict(con.execute(
        "SELECT slug, arg_max(name, snapshot_date) "
        "FROM plugin_snapshots GROUP BY slug"
    ).fetchall())

    plugin_shards: dict[int, dict] = defaultdict(dict)
    for slug, series in plugin_series.items():
        sh = shard_of(slug)
        plugin_shards[sh][slug] = series
        index["plugins"].append([slug, plugin_names.get(slug, slug), sh])
    for sh in range(shards):
        jdump(out / "p" / f"{sh}.json", plugin_shards.get(sh, {}))

    # ---- themes: per-entity series + index entries ----------------------
    theme_series: dict[str, list] = defaultdict(list)
    for slug, date, rating, nr in con.execute(
        "SELECT slug, snapshot_date, rating, num_ratings "
        "FROM theme_snapshots ORDER BY slug, snapshot_date"
    ).fetchall():
        theme_series[slug].append([date.isoformat(), rating, nr])
    theme_names = dict(con.execute(
        "SELECT slug, arg_max(name, snapshot_date) "
        "FROM theme_snapshots GROUP BY slug"
    ).fetchall())

    theme_shards: dict[int, dict] = defaultdict(dict)
    for slug, series in theme_series.items():
        sh = shard_of(slug)
        theme_shards[sh][slug] = series
        index["themes"].append([slug, theme_names.get(slug, slug), sh])
    for sh in range(shards):
        jdump(out / "h" / f"{sh}.json", theme_shards.get(sh, {}))

    index["plugins"].sort(key=lambda e: e[0])
    index["themes"].sort(key=lambda e: e[0])

    snapshots = sorted({
        d.isoformat() for (d,) in con.execute(
            "SELECT DISTINCT snapshot_date FROM plugin_snapshots "
            "UNION SELECT DISTINCT snapshot_date FROM theme_snapshots"
        ).fetchall()
    })
    index["generated"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    index["snapshots"] = snapshots
    index["shards"] = shards
    index["counts"] = {
        "plugins": len(index["plugins"]),
        "themes": len(index["themes"]),
    }
    jdump(out / "index.json", index)

    # ---- ecosystem stats trends -----------------------------------------
    stats = {}
    stat_tables = {
        "wordpress": ("wordpress_stats_snapshots", "version"),
        "php": ("php_stats_snapshots", "version"),
        "mysql": ("mysql_stats_snapshots", "version"),
        "locale": ("locale_stats_snapshots", "locale"),
    }
    for key, (table, label_col) in stat_tables.items():
        by_date: dict[str, list] = defaultdict(list)
        for date, label, pct in con.execute(
            f"SELECT snapshot_date, {label_col}, percent FROM {table} "
            "ORDER BY snapshot_date, percent DESC"
        ).fetchall():
            by_date[date.isoformat()].append([label, pct])
        stats[key] = [{"d": d, "dist": by_date[d]} for d in sorted(by_date)]
    jdump(out / "stats.json", stats)

    con.close()
    return index, stats


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Export dashboard JSON from the DuckDB catalog.")
    ap.add_argument("--db", default="catalog.duckdb")
    ap.add_argument("--out", default="docs/data")
    ap.add_argument("--shards", type=int, default=64)
    args = ap.parse_args()

    index, stats = export(args.db, args.out, args.shards)
    print(f"Exported {index['counts']['plugins']} plugins, "
          f"{index['counts']['themes']} themes, "
          f"{len(index['snapshots'])} snapshot(s) -> {args.out}/")
    for key, series in stats.items():
        latest = series[-1]["dist"] if series else []
        print(f"  stats.{key}: {len(latest)} entries in latest snapshot")


if __name__ == "__main__":
    main()
