/* WordPress Ecosystem Analytics dashboard.
   Vanilla JS, no build step. Data is loaded from relative paths under data/. */
(function () {
  'use strict';

  // ----- Metric definitions -------------------------------------------------
  // Plugin point: [date, active_installs, downloaded, rating, num_ratings]
  // Theme point:  [date, rating, num_ratings]
  var METRICS = {
    plugins: [
      { key: 'ai', label: 'Active installs', idx: 1 },
      { key: 'dl', label: 'Downloads', idx: 2 },
      { key: 'rt', label: 'Rating', idx: 3, rating: true },
      { key: 'nr', label: 'Num ratings', idx: 4 }
    ],
    themes: [
      { key: 'rt', label: 'Rating', idx: 1, rating: true },
      { key: 'nr', label: 'Num ratings', idx: 2 }
    ]
  };

  var PALETTE = [
    '#2f6fed', '#e8590c', '#2b8a3e', '#9c36b5', '#0c8599',
    '#e03131', '#5c7cfa', '#f08c00', '#1098ad', '#d6336c'
  ];

  // ----- Application state --------------------------------------------------
  var state = {
    view: 'compare',          // 'compare' | 'ecosystem'
    type: 'plugins',          // 'plugins' | 'themes'
    metric: 'ai',             // metric key valid for current type
    selected: []              // array of slugs
  };

  var index = null;           // parsed index.json
  var stats = null;           // parsed stats.json (lazy)
  var shardCache = {};        // "p/12" -> { slug: [points] }  (in-memory cache)
  var nameMap = { plugins: {}, themes: {} };  // slug -> { name, shard }

  var compareChart = null;
  var ecoCharts = {};         // id -> echarts instance
  var ecoLoaded = false;
  var debounceTimer = null;
  var activeResultIdx = -1;
  var compareReqToken = 0;    // bumped per refresh; stale fetches are dropped

  // ----- DOM references -----------------------------------------------------
  var $ = function (id) { return document.getElementById(id); };
  var els = {};

  // ----- Number formatting --------------------------------------------------
  function compact(n) {
    if (n === null || n === undefined || isNaN(n)) return '-';
    var abs = Math.abs(n);
    if (abs >= 1e9) return trim(n / 1e9) + 'B';
    if (abs >= 1e6) return trim(n / 1e6) + 'M';
    if (abs >= 1e3) return trim(n / 1e3) + 'K';
    return String(n);
  }
  function trim(x) {
    // up to 1 decimal, drop trailing .0
    var s = x.toFixed(1);
    return s.replace(/\.0$/, '');
  }
  function fmtRating(n) {
    if (n === null || n === undefined || isNaN(n)) return '-';
    return (n / 20).toFixed(2) + ' / 5';
  }
  function fmtFull(n) {
    if (n === null || n === undefined || isNaN(n)) return '-';
    return Number(n).toLocaleString('en-US');
  }

  // ----- URL state ----------------------------------------------------------
  function readUrl() {
    var q = new URLSearchParams(window.location.search);
    var v = q.get('v');
    var type = q.get('type');
    var m = q.get('m');
    var ids = q.get('ids');

    if (v === 'compare' || v === 'ecosystem') state.view = v;
    if (type === 'plugins' || type === 'themes') state.type = type;

    var validKeys = METRICS[state.type].map(function (x) { return x.key; });
    if (m && validKeys.indexOf(m) !== -1) {
      state.metric = m;
    } else {
      state.metric = validKeys[0];
    }

    if (ids) {
      state.selected = ids.split(',')
        .map(function (s) { return s.trim(); })
        .filter(function (s) { return s.length > 0; });
    }
  }

  function writeUrl() {
    var q = new URLSearchParams();
    q.set('v', state.view);
    q.set('type', state.type);
    q.set('m', state.metric);
    if (state.selected.length) q.set('ids', state.selected.join(','));
    var url = window.location.pathname + '?' + q.toString();
    window.history.replaceState(null, '', url);
  }

  // ----- Data loading -------------------------------------------------------
  function loadIndex() {
    return fetch('data/index.json').then(function (r) {
      if (!r.ok) throw new Error('index.json ' + r.status);
      return r.json();
    }).then(function (data) {
      index = data;
      buildNameMap('plugins', data.plugins);
      buildNameMap('themes', data.themes);
    });
  }

  function buildNameMap(type, list) {
    var map = nameMap[type];
    for (var i = 0; i < list.length; i++) {
      var e = list[i]; // [slug, name, shard]
      map[e[0]] = { name: e[1], shard: e[2] };
    }
  }

  // Fetch (and cache) a shard file. Returns a promise of { slug: points }.
  function loadShard(type, shard) {
    var dir = type === 'plugins' ? 'p' : 'h';
    var cacheKey = dir + '/' + shard;
    if (shardCache[cacheKey]) {
      return Promise.resolve(shardCache[cacheKey]);
    }
    return fetch('data/' + cacheKey + '.json').then(function (r) {
      if (!r.ok) throw new Error(cacheKey + ' ' + r.status);
      return r.json();
    }).then(function (data) {
      shardCache[cacheKey] = data;
      return data;
    });
  }

  // Resolve a single entity's time series for the active type.
  function loadSeries(type, slug) {
    var meta = nameMap[type][slug];
    if (!meta) return Promise.resolve(null);
    return loadShard(type, meta.shard).then(function (shardData) {
      return shardData[slug] || [];
    });
  }

  function loadStats() {
    return fetch('data/stats.json').then(function (r) {
      if (!r.ok) throw new Error('stats.json ' + r.status);
      return r.json();
    }).then(function (data) { stats = data; });
  }

  // ----- View switching -----------------------------------------------------
  function setView(view) {
    state.view = view;
    var tabs = els.tabs.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('active', tabs[i].dataset.view === view);
    }
    $('view-compare').hidden = view !== 'compare';
    $('view-ecosystem').hidden = view !== 'ecosystem';
    writeUrl();

    if (view === 'compare') {
      // (Re)draw now that the container is visible and laid out. This also
      // covers opening the page directly on the ecosystem view, where the
      // compare chart was never built.
      refreshCompareChart();
    } else {
      ensureEcosystem();
    }
  }

  // ----- Compare: metric dropdown ------------------------------------------
  function rebuildMetricSelect() {
    var sel = els.metricSelect;
    sel.textContent = '';
    var defs = METRICS[state.type];
    var validKeys = defs.map(function (d) { return d.key; });
    if (validKeys.indexOf(state.metric) === -1) state.metric = validKeys[0];
    for (var i = 0; i < defs.length; i++) {
      var opt = document.createElement('option');
      opt.value = defs[i].key;
      opt.textContent = defs[i].label;          // static labels, safe
      sel.appendChild(opt);
    }
    sel.value = state.metric;
  }

  function currentMetricDef() {
    var defs = METRICS[state.type];
    for (var i = 0; i < defs.length; i++) {
      if (defs[i].key === state.metric) return defs[i];
    }
    return defs[0];
  }

  // ----- Compare: type toggle ----------------------------------------------
  function setType(type) {
    if (type === state.type) return;
    state.type = type;
    state.selected = [];             // entities are type-specific
    var btns = els.typeToggle.querySelectorAll('.type-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].dataset.type === type);
    }
    rebuildMetricSelect();
    closeResults();
    els.searchInput.value = '';
    renderChips();
    writeUrl();
    refreshCompareChart();
  }

  // ----- Compare: search / autocomplete ------------------------------------
  function runSearch(query) {
    if (!index) return;             // index.json not loaded yet
    var q = query.trim().toLowerCase();
    if (!q) { closeResults(); return; }
    var list = index[state.type];   // [[slug,name,shard],...]
    var matches = [];
    for (var i = 0; i < list.length && matches.length < 25; i++) {
      var slug = list[i][0], name = list[i][1];
      if (slug.toLowerCase().indexOf(q) !== -1 ||
          name.toLowerCase().indexOf(q) !== -1) {
        matches.push(list[i]);
      }
    }
    renderResults(matches);
  }

  function renderResults(matches) {
    var ul = els.searchResults;
    ul.textContent = '';
    activeResultIdx = -1;
    if (!matches.length) {
      var empty = document.createElement('li');
      empty.className = 'search-empty';
      empty.textContent = 'No matches';
      ul.appendChild(empty);
      ul.hidden = false;
      els.searchInput.setAttribute('aria-expanded', 'true');
      return;
    }
    for (var i = 0; i < matches.length; i++) {
      var m = matches[i];
      var li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.id = 'sr-opt-' + i;
      li.dataset.slug = m[0];

      var nameEl = document.createElement('span');
      nameEl.className = 'result-name';
      nameEl.textContent = m[1];          // untrusted name -> textContent

      var slugEl = document.createElement('span');
      slugEl.className = 'result-slug';
      slugEl.textContent = m[0];          // untrusted slug -> textContent

      li.appendChild(nameEl);
      li.appendChild(slugEl);
      (function (slug) {
        li.addEventListener('mousedown', function (ev) {
          ev.preventDefault();            // keep focus, fire before blur
          addEntity(slug);
        });
      })(m[0]);
      ul.appendChild(li);
    }
    ul.hidden = false;
    els.searchInput.setAttribute('aria-expanded', 'true');
  }

  function closeResults() {
    els.searchResults.hidden = true;
    els.searchResults.textContent = '';
    activeResultIdx = -1;
    els.searchInput.setAttribute('aria-expanded', 'false');
    els.searchInput.removeAttribute('aria-activedescendant');
  }

  function moveActiveResult(delta) {
    var items = els.searchResults.querySelectorAll('li[data-slug]');
    if (!items.length) return;
    if (activeResultIdx >= 0 && items[activeResultIdx]) {
      items[activeResultIdx].classList.remove('active');
    }
    activeResultIdx += delta;
    if (activeResultIdx < 0) activeResultIdx = items.length - 1;
    if (activeResultIdx >= items.length) activeResultIdx = 0;
    items[activeResultIdx].classList.add('active');
    items[activeResultIdx].scrollIntoView({ block: 'nearest' });
    els.searchInput.setAttribute('aria-activedescendant',
      items[activeResultIdx].id);
  }

  function chooseActiveResult() {
    var items = els.searchResults.querySelectorAll('li[data-slug]');
    if (activeResultIdx >= 0 && items[activeResultIdx]) {
      addEntity(items[activeResultIdx].dataset.slug);
    } else if (items.length === 1) {
      addEntity(items[0].dataset.slug);
    }
  }

  // ----- Compare: chips -----------------------------------------------------
  function addEntity(slug) {
    if (!nameMap[state.type][slug]) return;       // unknown slug
    if (state.selected.indexOf(slug) !== -1) {    // ignore duplicates
      els.searchInput.value = '';
      closeResults();
      return;
    }
    state.selected.push(slug);
    els.searchInput.value = '';
    closeResults();
    renderChips();
    writeUrl();
    refreshCompareChart();
  }

  function removeEntity(slug) {
    var i = state.selected.indexOf(slug);
    if (i === -1) return;
    state.selected.splice(i, 1);
    renderChips();
    writeUrl();
    refreshCompareChart();
  }

  function renderChips() {
    var box = els.chips;
    box.textContent = '';
    for (var i = 0; i < state.selected.length; i++) {
      var slug = state.selected[i];
      var meta = nameMap[state.type][slug];
      var label = meta ? meta.name : slug;
      var color = PALETTE[i % PALETTE.length];

      var chip = document.createElement('span');
      chip.className = 'chip';

      var dot = document.createElement('span');
      dot.className = 'chip-dot';
      dot.style.background = color;

      var text = document.createElement('span');
      text.className = 'chip-label';
      text.textContent = label;           // untrusted name -> textContent
      text.title = slug;

      var btn = document.createElement('button');
      btn.className = 'chip-remove';
      btn.type = 'button';
      btn.textContent = '×';
      btn.setAttribute('aria-label', 'Remove');
      (function (s) {
        btn.addEventListener('click', function () { removeEntity(s); });
      })(slug);

      chip.appendChild(dot);
      chip.appendChild(text);
      chip.appendChild(btn);
      box.appendChild(chip);
    }
  }

  // ----- Compare: status helper --------------------------------------------
  function setCompareStatus(msg) {
    els.compareStatus.textContent = msg || '';
  }

  // ----- Compare: chart -----------------------------------------------------
  function ensureCompareChart() {
    if (!compareChart) {
      compareChart = echarts.init(els.compareChart);
    }
    return compareChart;
  }

  function refreshCompareChart() {
    updateSnapshotHint();
    var token = ++compareReqToken;   // invalidates any in-flight request

    if (!state.selected.length) {
      if (compareChart) compareChart.clear();
      setCompareStatus('Search for a ' +
        (state.type === 'plugins' ? 'plugin' : 'theme') +
        ' above to start comparing.');
      return;
    }

    setCompareStatus('Loading data...');
    var type = state.type;
    var metricDef = currentMetricDef();
    var slugs = state.selected.slice();

    Promise.all(slugs.map(function (s) {
      return loadSeries(type, s);
    })).then(function (allSeries) {
      // Drop results from a superseded request -- the selection, metric
      // or type changed (or the chart was cleared) while this was in
      // flight, so a slower fetch must not clobber the current chart.
      if (token !== compareReqToken) return;
      setCompareStatus('');
      drawCompareChart(slugs, allSeries, metricDef);
    }).catch(function (err) {
      if (token !== compareReqToken) return;
      setCompareStatus('Failed to load data: ' + err.message);
    });
  }

  function drawCompareChart(slugs, allSeries, metricDef) {
    var chart = ensureCompareChart();
    var isRating = !!metricDef.rating;

    var series = [];
    var legendData = [];      // legend names; ECharts renders these as text, safe
    for (var i = 0; i < slugs.length; i++) {
      var slug = slugs[i];
      var meta = nameMap[state.type][slug];
      var name = meta ? meta.name : slug;
      var points = allSeries[i] || [];
      var data = points.map(function (p) {
        return [p[0], p[metricDef.idx]];
      });
      legendData.push(name);
      series.push({
        name: name,
        type: 'line',
        showSymbol: true,        // critical: single-point series must show
        symbolSize: 7,
        smooth: false,
        emphasis: { focus: 'series' },
        data: data
      });
    }

    var option = {
      color: PALETTE,
      tooltip: {
        trigger: 'axis',
        formatter: function (params) {
          // Non-HTML callbacks would still be escaped; but ECharts tooltip
          // renders the returned string as HTML, so escape every name.
          if (!params.length) return '';
          var date = params[0].axisValueLabel || params[0].axisValue;
          var lines = [esc(String(date))];
          for (var k = 0; k < params.length; k++) {
            var p = params[k];
            var val = (p.value && p.value.length > 1) ? p.value[1] : null;
            var shown = isRating ? fmtRating(val) : fmtFull(val);
            lines.push(
              p.marker + esc(p.seriesName) +
              ': <strong>' + esc(shown) + '</strong>'
            );
          }
          return lines.join('<br>');
        }
      },
      legend: {
        type: 'scroll',
        top: 0,
        data: legendData
      },
      grid: { left: 56, right: 24, top: 48, bottom: 78 },
      xAxis: {
        type: 'time',
        axisLabel: { hideOverlap: true }
      },
      yAxis: {
        type: 'value',
        name: metricDef.label,
        nameTextStyle: { color: '#8b94a0', align: 'left' },
        min: isRating ? 0 : null,
        max: isRating ? 100 : null,
        axisLabel: {
          formatter: function (v) {
            return isRating ? (v / 20).toFixed(1) : compact(v);
          }
        }
      },
      dataZoom: [
        { type: 'slider', bottom: 12, height: 22 },
        { type: 'inside' }
      ],
      series: series
    };

    chart.setOption(option, true);
    chart.resize();
  }

  function updateSnapshotHint() {
    var single = !index || !index.snapshots || index.snapshots.length < 2;
    els.snapshotHint.hidden = !(single && state.view === 'compare');
    if (single) {
      els.snapshotHint.textContent =
        'Only one snapshot exists so far - each line shows as a single point. ' +
        'Trends will appear as daily snapshots accumulate.';
    }
  }

  // ----- Ecosystem view -----------------------------------------------------
  function ensureEcosystem() {
    if (ecoLoaded) {
      resizeEcoCharts();
      return;
    }
    els.ecosystemStatus.textContent = 'Loading ecosystem stats...';
    loadStats().then(function () {
      els.ecosystemStatus.textContent = '';
      ecoLoaded = true;
      drawEcoChart('chart-wordpress', stats.wordpress, 0);
      drawEcoChart('chart-php', stats.php, 0);
      drawEcoChart('chart-mysql', stats.mysql, 0);
      drawEcoChart('chart-locale', stats.locale, 15);
    }).catch(function (err) {
      els.ecosystemStatus.textContent =
        'Failed to load ecosystem stats: ' + err.message;
    });
  }

  // entries: [{ d: date, dist: [[label, percent], ...] }, ...]
  // topN: 0 => all labels, otherwise keep top N by most-recent percent.
  function drawEcoChart(elId, entries, topN) {
    var el = $(elId);
    if (!el || !entries || !entries.length) return;

    // Collect every label across all dates.
    var labels = {};
    for (var i = 0; i < entries.length; i++) {
      var dist = entries[i].dist;
      for (var j = 0; j < dist.length; j++) {
        labels[dist[j][0]] = true;
      }
    }
    var labelList = Object.keys(labels);

    if (topN > 0 && labelList.length > topN) {
      var recent = entries[entries.length - 1].dist;
      var recentPct = {};
      for (var r = 0; r < recent.length; r++) {
        recentPct[recent[r][0]] = recent[r][1];
      }
      labelList.sort(function (a, b) {
        return (recentPct[b] || 0) - (recentPct[a] || 0);
      });
      labelList = labelList.slice(0, topN);
    } else {
      labelList.sort();
    }

    var series = [];
    for (var s = 0; s < labelList.length; s++) {
      var label = labelList[s];
      var data = [];
      for (var e = 0; e < entries.length; e++) {
        var dist = entries[e].dist;
        var pct = null;
        for (var d = 0; d < dist.length; d++) {
          if (dist[d][0] === label) { pct = dist[d][1]; break; }
        }
        if (pct !== null) data.push([entries[e].d, pct]);
      }
      series.push({
        name: label,
        type: 'line',
        showSymbol: true,
        symbolSize: 6,
        emphasis: { focus: 'series' },
        data: data
      });
    }

    var chart = ecoCharts[elId];
    if (!chart) {
      chart = echarts.init(el);
      ecoCharts[elId] = chart;
    }

    chart.setOption({
      tooltip: {
        trigger: 'axis',
        formatter: function (params) {
          if (!params.length) return '';
          var date = params[0].axisValueLabel || params[0].axisValue;
          // Sort descending by value for readability.
          var rows = params.slice().sort(function (a, b) {
            return (b.value[1] || 0) - (a.value[1] || 0);
          });
          var lines = [esc(String(date))];
          for (var k = 0; k < rows.length; k++) {
            var p = rows[k];
            var v = (p.value && p.value.length > 1) ? p.value[1] : 0;
            lines.push(
              p.marker + esc(p.seriesName) +
              ': <strong>' + esc(v.toFixed(1)) + '%</strong>'
            );
          }
          return lines.join('<br>');
        }
      },
      legend: { type: 'scroll', top: 0, data: labelList },
      grid: { left: 48, right: 18, top: 40, bottom: 36 },
      xAxis: { type: 'time', axisLabel: { hideOverlap: true } },
      yAxis: {
        type: 'value',
        axisLabel: { formatter: '{value}%' }
      },
      series: series
    }, true);
    chart.resize();
  }

  function resizeEcoCharts() {
    for (var id in ecoCharts) {
      if (ecoCharts.hasOwnProperty(id)) ecoCharts[id].resize();
    }
  }

  // ----- HTML escaping (for ECharts HTML tooltip strings) -------------------
  function esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ----- Resize handling ----------------------------------------------------
  function handleResize() {
    if (compareChart) compareChart.resize();
    resizeEcoCharts();
  }

  // ----- Init ---------------------------------------------------------------
  function bindEvents() {
    // Tabs
    els.tabs.addEventListener('click', function (ev) {
      var btn = ev.target.closest('.tab');
      if (btn) setView(btn.dataset.view);
    });

    // Type toggle
    els.typeToggle.addEventListener('click', function (ev) {
      var btn = ev.target.closest('.type-btn');
      if (btn) setType(btn.dataset.type);
    });

    // Metric dropdown
    els.metricSelect.addEventListener('change', function () {
      state.metric = els.metricSelect.value;
      writeUrl();
      refreshCompareChart();
    });

    // Search input (debounced)
    els.searchInput.addEventListener('input', function () {
      var val = els.searchInput.value;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function () {
        runSearch(val);
      }, 150);
    });

    els.searchInput.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        if (els.searchResults.hidden) runSearch(els.searchInput.value);
        else moveActiveResult(1);
      } else if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        moveActiveResult(-1);
      } else if (ev.key === 'Enter') {
        if (!els.searchResults.hidden) {
          ev.preventDefault();
          chooseActiveResult();
        }
      } else if (ev.key === 'Escape') {
        closeResults();
      }
    });

    els.searchInput.addEventListener('blur', function () {
      // Delay so a result mousedown can register first.
      setTimeout(closeResults, 120);
    });

    document.addEventListener('click', function (ev) {
      if (!ev.target.closest('.search-wrap')) closeResults();
    });

    window.addEventListener('resize', handleResize);
  }

  function applyInitialState() {
    // Type toggle active state
    var tBtns = els.typeToggle.querySelectorAll('.type-btn');
    for (var i = 0; i < tBtns.length; i++) {
      tBtns[i].classList.toggle('active',
        tBtns[i].dataset.type === state.type);
    }
    rebuildMetricSelect();
    els.metricSelect.value = state.metric;
    renderChips();
    setView(state.view);     // sets tabs + url, and draws the active view
  }

  function init() {
    els = {
      tabs: $('tabs'),
      typeToggle: $('type-toggle'),
      searchInput: $('search-input'),
      searchResults: $('search-results'),
      metricSelect: $('metric-select'),
      chips: $('chips'),
      snapshotHint: $('snapshot-hint'),
      compareStatus: $('compare-status'),
      compareChart: $('compare-chart'),
      ecosystemStatus: $('ecosystem-status'),
      footerMeta: $('footer-meta')
    };

    readUrl();
    bindEvents();
    setCompareStatus('Loading index...');

    loadIndex().then(function () {
      // index could change metric validity per type; re-validate.
      var validKeys = METRICS[state.type].map(function (x) { return x.key; });
      if (validKeys.indexOf(state.metric) === -1) {
        state.metric = validKeys[0];
      }
      var counts = index.counts || {};
      var nPlugins = counts.plugins != null
        ? counts.plugins.toLocaleString('en-US') : '?';
      var nThemes = counts.themes != null
        ? counts.themes.toLocaleString('en-US') : '?';
      els.footerMeta.textContent =
        'Data generated ' + (index.generated || '-') + '  -  ' +
        nPlugins + ' plugins, ' + nThemes + ' themes.';
      applyInitialState();
    }).catch(function (err) {
      setCompareStatus('Failed to load index.json: ' + err.message);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
