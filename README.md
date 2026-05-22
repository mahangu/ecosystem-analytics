# ecosystem-analytics

A zero-cost daily data pipeline that snapshots the **WordPress.org catalog
and ecosystem metadata** into a DuckDB file kept inside this repository.

Every day a GitHub Actions job runs the
[`tap-wordpress-org`](https://github.com/Automattic/tap-wordpress-org)
Singer tap, extracts seven streams, loads them into `catalog.duckdb` as
dated, append-only snapshots, and commits the updated database back to the
repo. There is no database server and no hosting bill — **the repo is the
storage.**

## How it works

```
GitHub Actions (cron 06:00 UTC)
  └─ meltano invoke tap-wordpress-org > output/tap-output.jsonl   # extract
      └─ scripts/load_snapshot.py                                # → catalog.duckdb
          └─ git commit catalog.duckdb                           # stored in the repo
```

The tap is consumed as a pinned dependency
(`git+https://github.com/Automattic/tap-wordpress-org.git@0.1.0`). It is
**never forked or modified.**

### Streams

Seven streams are synced — three catalog streams and four small
whole-ecosystem distributions:

| Stream            | Table                        | Grain                  |
|-------------------|------------------------------|------------------------|
| `plugins`         | `plugin_snapshots`           | one row per plugin     |
| `themes`          | `theme_snapshots`            | one row per theme      |
| `patterns`        | `pattern_snapshots`          | one row per pattern    |
| `wordpress_stats` | `wordpress_stats_snapshots`  | one row per WP version |
| `php_stats`       | `php_stats_snapshots`        | one row per PHP version|
| `mysql_stats`     | `mysql_stats_snapshots`      | one row per MySQL ver. |
| `locale_stats`    | `locale_stats_snapshots`     | one row per locale     |

The tap's eighth stream, `events`, is **intentionally excluded** — it is
location-based event listings, not catalog or ecosystem metadata.

**Known gap:** the `patterns` stream currently lands 0 rows. The tap's
record JSONPath does not match the pattern directory API's response shape
— a bug present in every tap release — so the pipeline warns and
continues with an empty `pattern_snapshots` until the tap is fixed or
patterns are sourced separately.

### Full extract, every day

The tap is run with `meltano invoke`, which carries no Singer state, so
every run is a complete extract. This is deliberate: the tap defaults
`plugins`/`themes` to incremental replication keyed on `last_updated`, but
installs, downloads and ratings drift *without* `last_updated` changing —
an incremental sync would silently miss exactly the metrics this pipeline
exists to track. No Singer loader is used; `load_snapshot.py` reads the
tap's raw Singer output directly.

### Append-only and idempotent

Each table is append-only and every row is stamped with a `snapshot_date`.
`load_snapshot.py` deletes any existing rows for the snapshot date before
inserting, so a retried CI job *replaces* that day's snapshot rather than
duplicating it.

## Running locally

Requires Python 3.11.

```bash
pip install meltano duckdb

# Install the tap into the Meltano project.
meltano install

# Extract the seven streams to a raw Singer JSONL file.
mkdir -p output
meltano invoke tap-wordpress-org > output/tap-output.jsonl

# Load the JSONL into catalog.duckdb, stamped with today's UTC date.
python scripts/load_snapshot.py --input output --db catalog.duckdb

# Optionally load under a specific date:
python scripts/load_snapshot.py --input output --db catalog.duckdb --date 2026-05-22
```

`load_snapshot.py` exits non-zero (failing the run) if the `plugins` or
`themes` stream produced zero records. The four stats streams and
`patterns` can legitimately be small, so they only print a warning.

### Sanity checks

After a sync, run the read-only checks in `verify.sql`:

```bash
duckdb catalog.duckdb < verify.sql
```

It reports per-snapshot row counts, top plugins/themes, day-over-day
deltas (once two snapshots exist), data-quality counts, and the current
ecosystem stats distributions.

### First run

The daily job is also wired to `workflow_dispatch` — trigger it manually
from the Actions tab to capture the first snapshot immediately instead of
waiting for the 06:00 UTC cron.

## Dashboard

An interactive dashboard compares plugin and theme metrics — installs,
downloads, ratings — over time across the accumulating daily snapshots. It
is a static site (`docs/index.html`, `docs/app.js`, `docs/style.css`)
served on GitHub Pages.

`scripts/export_dashboard.py` reads `catalog.duckdb` and writes the static
JSON files the dashboard loads into `docs/data/`. That directory is
gitignored — it is **generated in CI at deploy time and never committed**.

The [`pages.yml`](.github/workflows/pages.yml) workflow regenerates
`docs/data/` and deploys the whole `docs/` folder. It runs on every push
that touches `docs/` and after each daily sync, so a fresh snapshot
redeploys the dashboard automatically.

GitHub Pages must use **"GitHub Actions"** as its source. The workflow's
`configure-pages` step (`enablement: true`) sets this up automatically on
the first run; if Pages does not come up, check that
**Settings → Pages → Source** is set to GitHub Actions.

## Schemas

Every table additionally has a `snapshot_date DATE` column and an index on
`(<key>, snapshot_date)`. Every table also keeps a `raw` JSON column
holding the complete original record — no field is ever lost, and the
extracted columns can be adjusted later without re-fetching.

### `plugin_snapshots` — key `(slug, snapshot_date)`

| Column            | Type    | Notes |
|-------------------|---------|-------|
| `slug`            | VARCHAR | |
| `name`            | VARCHAR | |
| `active_installs` | BIGINT  | **bucketed** by WordPress.org, not exact |
| `downloaded`      | BIGINT  | |
| `rating`          | DOUBLE  | 0–100 scale |
| `num_ratings`     | BIGINT  | |
| `requires`        | VARCHAR | minimum WP version |
| `tested`          | VARCHAR | tested-up-to WP version |
| `requires_php`    | VARCHAR | |
| `last_updated`    | VARCHAR | |
| `added`           | VARCHAR | |
| `author`          | VARCHAR | HTML author string |
| `ratings`         | JSON    | star → count breakdown |
| `raw`             | JSON    | complete original record |

### `theme_snapshots` — key `(slug, snapshot_date)`

| Column              | Type    | Notes |
|---------------------|---------|-------|
| `slug`              | VARCHAR | |
| `name`              | VARCHAR | |
| `version`           | VARCHAR | |
| `downloaded`        | BIGINT  | not exposed by the themes browse API — always null |
| `rating`            | DOUBLE  | 0–100 scale |
| `num_ratings`       | BIGINT  | popularity proxy (themes have no download count) |
| `requires`          | VARCHAR | |
| `requires_php`      | VARCHAR | |
| `last_updated`      | VARCHAR | not exposed by the themes browse API — always null |
| `last_updated_time` | VARCHAR | not exposed by the themes browse API — always null |
| `preview_url`       | VARCHAR | |
| `screenshot_url`    | VARCHAR | |
| `homepage`          | VARCHAR | |
| `parent`            | JSON    | not exposed by the themes browse API — always null |
| `author`            | JSON    | author object |
| `raw`               | JSON    | complete original record |

The WordPress.org themes *browse* API does not return `downloaded`,
`last_updated`/`last_updated_time`, or `parent`, so those columns are
always null. They are kept in the schema in case the tap starts
populating them; `num_ratings` is the usable popularity signal for themes.

### `pattern_snapshots` — key `(id, snapshot_date)`

| Column    | Type    | Notes |
|-----------|---------|-------|
| `id`      | BIGINT  | |
| `title`   | VARCHAR | |
| `content` | VARCHAR | block markup |
| `raw`     | JSON    | complete original record — safety net for the variable pattern shape |

### `wordpress_stats_snapshots` / `php_stats_snapshots` / `mysql_stats_snapshots` — key `(version, snapshot_date)`

| Column    | Type    | Notes |
|-----------|---------|-------|
| `version` | VARCHAR | |
| `count`   | BIGINT  | may be empty — see `raw` |
| `percent` | DOUBLE  | share of the ecosystem |
| `raw`     | JSON    | complete original record |

### `locale_stats_snapshots` — key `(locale, snapshot_date)`

| Column    | Type    | Notes |
|-----------|---------|-------|
| `locale`  | VARCHAR | |
| `count`   | BIGINT  | may be empty — see `raw` |
| `percent` | DOUBLE  | share of the ecosystem |
| `raw`     | JSON    | complete original record |

## Caveats

- **`active_installs` is bucketed.** WordPress.org reports plugin installs
  in buckets (e.g. `1,000,000+`), not exact figures. Treat the number as a
  bucket boundary, not a precise count.

- **History is unrecoverable.** WordPress.org exposes only *current*
  values — there is no historical API and no backfill. Any day the
  pipeline does not run is a gap that can never be filled. **Start running
  it immediately**; that is the one part of this project that cannot be
  redone later.

- **`events` is intentionally excluded.** It is location-based event
  listings (meetups, WordCamps), not catalog or ecosystem metadata, so it
  is not synced.

- **Repo-as-storage grows.** `catalog.duckdb` gets bigger every day and
  bloats git history. This is fine for the first few months. After that,
  move the database to GitHub Releases or a storage bucket and have the
  workflow upload there instead of committing.

## Migrating to Postgres

The schema deliberately uses only standard SQL types and no DuckDB-only
functions, so the data moves to Postgres with no rewrite. From a DuckDB
session:

```sql
INSTALL postgres;
LOAD postgres;
ATTACH 'postgresql://user:pass@host:5432/dbname' AS pg (TYPE postgres);

CREATE TABLE pg.plugin_snapshots          AS SELECT * FROM plugin_snapshots;
CREATE TABLE pg.theme_snapshots           AS SELECT * FROM theme_snapshots;
CREATE TABLE pg.pattern_snapshots         AS SELECT * FROM pattern_snapshots;
CREATE TABLE pg.wordpress_stats_snapshots AS SELECT * FROM wordpress_stats_snapshots;
CREATE TABLE pg.php_stats_snapshots       AS SELECT * FROM php_stats_snapshots;
CREATE TABLE pg.mysql_stats_snapshots     AS SELECT * FROM mysql_stats_snapshots;
CREATE TABLE pg.locale_stats_snapshots    AS SELECT * FROM locale_stats_snapshots;
```

This works against Postgres on any host.
