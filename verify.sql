-- verify.sql — read-only sanity checks for catalog.duckdb.
--
-- Run manually after a sync:   duckdb catalog.duckdb < verify.sql
--
-- Nothing here writes to the database. Each query is commented with what
-- a healthy result looks like.


-- ===========================================================================
-- 1. Row count per snapshot_date, for every table.
--    Healthy: plugins ~60k, themes a few thousand, patterns a few thousand,
--    each stats table a few dozen rows. Counts should be stable (or slowly
--    growing) day over day — a sudden drop means a broken extract.
-- ===========================================================================
SELECT 'plugin_snapshots'         AS table_name, snapshot_date, COUNT(*) AS rows
  FROM plugin_snapshots          GROUP BY snapshot_date
UNION ALL
SELECT 'theme_snapshots',         snapshot_date, COUNT(*)
  FROM theme_snapshots           GROUP BY snapshot_date
UNION ALL
SELECT 'pattern_snapshots',       snapshot_date, COUNT(*)
  FROM pattern_snapshots         GROUP BY snapshot_date
UNION ALL
SELECT 'wordpress_stats_snapshots', snapshot_date, COUNT(*)
  FROM wordpress_stats_snapshots GROUP BY snapshot_date
UNION ALL
SELECT 'php_stats_snapshots',     snapshot_date, COUNT(*)
  FROM php_stats_snapshots       GROUP BY snapshot_date
UNION ALL
SELECT 'mysql_stats_snapshots',   snapshot_date, COUNT(*)
  FROM mysql_stats_snapshots     GROUP BY snapshot_date
UNION ALL
SELECT 'locale_stats_snapshots',  snapshot_date, COUNT(*)
  FROM locale_stats_snapshots    GROUP BY snapshot_date
ORDER BY table_name, snapshot_date;


-- ===========================================================================
-- 2. Top 10 plugins by active_installs (latest snapshot).
--    Healthy: familiar names at the top (woocommerce, akismet, etc.) with
--    large bucketed install figures. NOTE: active_installs is bucketed by
--    WordPress.org, not exact.
-- ===========================================================================
SELECT slug, name, active_installs, downloaded, rating
  FROM plugin_snapshots
 WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM plugin_snapshots)
 ORDER BY active_installs DESC NULLS LAST
 LIMIT 10;


-- ===========================================================================
-- 3. Top 10 themes by downloads (latest snapshot).
--    Healthy: well-known themes with large download counts and non-null
--    ratings. Themes have no active_installs, so downloads is the proxy.
-- ===========================================================================
SELECT slug, name, downloaded, rating, num_ratings
  FROM theme_snapshots
 WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM theme_snapshots)
 ORDER BY downloaded DESC NULLS LAST
 LIMIT 10;


-- ===========================================================================
-- 4. Top 10 themes by rating (latest snapshot, tie-broken by num_ratings).
--    Healthy: ratings on a 0–100 scale, top themes near 100 with a
--    meaningful number of ratings.
-- ===========================================================================
SELECT slug, name, rating, num_ratings, downloaded
  FROM theme_snapshots
 WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM theme_snapshots)
 ORDER BY rating DESC NULLS LAST, num_ratings DESC NULLS LAST
 LIMIT 10;


-- ===========================================================================
-- 5. Patterns sample (latest snapshot).
--    Patterns have no popularity metric (no downloads / rating), so there
--    is nothing to rank by — this is just a 10-row spot check.
--    Healthy: non-null id and a human-readable title on every row.
-- ===========================================================================
SELECT id, title
  FROM pattern_snapshots
 WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM pattern_snapshots)
 ORDER BY id
 LIMIT 10;


-- ===========================================================================
-- 6. Day-over-day delta for plugins — biggest install movers.
--    Returns nothing until at least two snapshots exist. Healthy once it
--    does: mostly small deltas with no implausible swings. A row with a
--    huge negative delta usually means a plugin left the directory.
-- ===========================================================================
WITH plugin_dates AS (
    SELECT snapshot_date,
           ROW_NUMBER() OVER (ORDER BY snapshot_date DESC) AS rn
      FROM (SELECT DISTINCT snapshot_date FROM plugin_snapshots) d
)
SELECT cur.slug,
       cur.name,
       prev.active_installs AS prev_active_installs,
       cur.active_installs  AS cur_active_installs,
       cur.active_installs - prev.active_installs AS delta_active_installs
  FROM plugin_snapshots cur
  JOIN plugin_snapshots prev ON cur.slug = prev.slug
 WHERE cur.snapshot_date  = (SELECT snapshot_date FROM plugin_dates WHERE rn = 1)
   AND prev.snapshot_date = (SELECT snapshot_date FROM plugin_dates WHERE rn = 2)
   AND cur.active_installs <> prev.active_installs
 ORDER BY ABS(cur.active_installs - prev.active_installs) DESC
 LIMIT 20;


-- ===========================================================================
-- 7. Day-over-day delta for themes — biggest download movers.
--    Returns nothing until at least two snapshots exist. Healthy once it
--    does: downloads only ever increase, so deltas should be >= 0.
-- ===========================================================================
WITH theme_dates AS (
    SELECT snapshot_date,
           ROW_NUMBER() OVER (ORDER BY snapshot_date DESC) AS rn
      FROM (SELECT DISTINCT snapshot_date FROM theme_snapshots) d
)
SELECT cur.slug,
       cur.name,
       prev.downloaded AS prev_downloaded,
       cur.downloaded  AS cur_downloaded,
       cur.downloaded - prev.downloaded AS delta_downloaded
  FROM theme_snapshots cur
  JOIN theme_snapshots prev ON cur.slug = prev.slug
 WHERE cur.snapshot_date  = (SELECT snapshot_date FROM theme_dates WHERE rn = 1)
   AND prev.snapshot_date = (SELECT snapshot_date FROM theme_dates WHERE rn = 2)
   AND cur.downloaded <> prev.downloaded
 ORDER BY ABS(cur.downloaded - prev.downloaded) DESC
 LIMIT 20;


-- ===========================================================================
-- 8. Data-quality counts — null keys and zero/missing metrics (latest
--    snapshot of each catalog table).
--    Healthy: null_key = 0 everywhere. A handful of zero-metric rows is
--    normal (brand-new or unrated items). A large share is suspicious.
-- ===========================================================================
SELECT 'plugin_snapshots' AS table_name,
       COUNT(*)                                                  AS rows,
       COUNT(*) FILTER (WHERE slug IS NULL)                       AS null_key,
       COUNT(*) FILTER (WHERE active_installs IS NULL
                           OR active_installs = 0)                AS zero_metric
  FROM plugin_snapshots
 WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM plugin_snapshots)
UNION ALL
SELECT 'theme_snapshots',
       COUNT(*),
       COUNT(*) FILTER (WHERE slug IS NULL),
       COUNT(*) FILTER (WHERE downloaded IS NULL OR downloaded = 0)
  FROM theme_snapshots
 WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM theme_snapshots)
UNION ALL
SELECT 'pattern_snapshots',
       COUNT(*),
       COUNT(*) FILTER (WHERE id IS NULL),
       COUNT(*) FILTER (WHERE title IS NULL OR title = '')
  FROM pattern_snapshots
 WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM pattern_snapshots);


-- ===========================================================================
-- 9. Current ecosystem stats — each of the four distributions, latest
--    snapshot, ordered by share.
--    Healthy: percent values are positive and sum to roughly 100 within
--    each table. The top versions/locales should look plausible.
-- ===========================================================================
SELECT 'wordpress' AS dataset, version AS bucket, count, percent
  FROM wordpress_stats_snapshots
 WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM wordpress_stats_snapshots)
UNION ALL
SELECT 'php', version, count, percent
  FROM php_stats_snapshots
 WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM php_stats_snapshots)
UNION ALL
SELECT 'mysql', version, count, percent
  FROM mysql_stats_snapshots
 WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM mysql_stats_snapshots)
UNION ALL
SELECT 'locale', locale, count, percent
  FROM locale_stats_snapshots
 WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM locale_stats_snapshots)
 ORDER BY dataset, percent DESC NULLS LAST;
