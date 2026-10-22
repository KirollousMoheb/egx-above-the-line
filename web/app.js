/* Above the Line: breadth front page, filters, cards/table, and the full-chart sheet. */
(function () {
  'use strict';

  /* ------------------------------------------------------------ helpers */

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Builds DOM with text nodes only: names come from external data, never innerHTML.
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'style') el.style.cssText = v;
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
    }
    return el;
  }
  function svg(tag, attrs) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }

  async function getJSON(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return r.json();
  }

  const store = {
    get(k, d) { try { const v = localStorage.getItem('atl.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('atl.' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  const fmt = {
    price(v) {
      if (v == null) return '—';
      const p = Math.abs(v) < 10 ? 3 : 2;
      return v.toLocaleString('en-US', { minimumFractionDigits: p, maximumFractionDigits: p });
    },
    pct(v, d = 1) {
      if (v == null || Number.isNaN(v)) return '—';
      const r = Math.abs(v).toFixed(d);
      return (Number(r) === 0 ? '' : v > 0 ? '+' : '−') + r + '%';
    },
    compact(v) {
      if (v == null) return '—';
      const a = Math.abs(v);
      if (a >= 1e9) return (v / 1e9).toFixed(a >= 1e10 ? 1 : 2) + 'B';
      if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 1 : 2) + 'M';
      if (a >= 1e3) return (v / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'K';
      return String(Math.round(v));
    },
    date(iso) { const [y, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; },
    dateShort(iso) { const [, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS[m - 1]}`; },
    longDate(iso) {
      const t = new Date(iso + 'T12:00:00Z');
      return `${DAYS[t.getUTCDay()]}, ${t.getUTCDate()} ${MONTHS_LONG[t.getUTCMonth()]} ${t.getUTCFullYear()}`;
    },
    sessions(n, plus = '') { return n === 1 && !plus ? '1 session' : `${n.toLocaleString('en-US')}${plus} sessions`; },
    ago(n) { return n === 0 ? 'in the latest session' : n === 1 ? '1 session ago' : `${n} sessions ago`; },
  };

  function direction(v) { return v == null || Math.abs(v) < 0.005 ? 'flat' : v > 0 ? 'up' : 'down'; }
  function deltaEl(v, digits = 2) {
    const cls = direction(v);
    const arrow = cls === 'up' ? '▲ ' : cls === 'down' ? '▼ ' : '';
    return h('span', { class: 'delta ' + cls, text: v == null ? '—' : arrow + Math.abs(v).toFixed(digits) + '%' });
  }
  function signedEl(v, digits = 1, tag = 'span') {
    return h(tag, { class: 'delta ' + direction(v), text: fmt.pct(v, digits) });
  }

  /* ------------------------------------------------------------ configuration */

  const THIN = 1e6;      // average daily traded value (EGP) below which a stock is flagged thin
  const GAUGE_MAX = 40;  // % distance that fills half a gauge

  const DEFAULTS = { index: 'ALL', trend: 'any', signal: 'any', sector: 'all', liq: '0', sort: 'd200', dir: 'desc', view: 'cards', watch: false };
  const SCOPE_LABEL = { ALL: 'All EGX', EGX30: 'EGX30', EGX70: 'EGX70 EWI', EGX100: 'EGX100 EWI', OTHER: 'Outside EGX100' };
  const TRENDS = {
    any: () => true,
    a200: (s) => s.a200 === true,
    a50: (s) => s.a50 === true,
    both: (s) => s.a200 === true && s.a50 === true,
    b200: (s) => s.a200 === false,
  };
  const TREND_TITLE = { any: '', a200: 'above the 200-day', a50: 'above the 50-day', both: 'above both averages', b200: 'below the 200-day' };
  const SIGNALS = [
    ['any', 'Any signal', () => true],
    ['fresh', 'Broke above the 200-day (last 10 sessions)', (s) => s.streak > 0 && s.streak <= 10],
    ['lost', 'Fell below the 200-day (last 10 sessions)', (s) => s.streak < 0 && s.streak >= -10],
    ['golden', 'Golden cross (last 30 sessions)', (s) => s.cross && s.cross.type === 'golden' && s.cross.ago <= 30],
    ['death', 'Death cross (last 30 sessions)', (s) => s.cross && s.cross.type === 'death' && s.cross.ago <= 30],
    ['stack', 'Uptrend stack: price > 50d > 200d, 200d rising', (s) => s.a50 === true && s.sma50 > s.sma200 && s.slope200 > 0],
    ['pullback', 'Pullback: 0–5% above a rising 200-day', (s) => s.a200 === true && s.d200 <= 5 && s.slope200 > 0],
    ['high', 'Within 5% of the 52-week high', (s) => s.fromHi != null && s.fromHi >= -5],
    ['stretched', 'Stretched: 30%+ above the 200-day', (s) => s.d200 != null && s.d200 >= 30],
  ];
  const SIGNAL_TEST = Object.fromEntries(SIGNALS.map(([k, , f]) => [k, f]));
  const LIQ = [['0', 'Any'], ['1000000', '≥ 1M EGP a day'], ['5000000', '≥ 5M EGP a day'], ['20000000', '≥ 20M EGP a day'], ['100000000', '≥ 100M EGP a day']];
  const SORTS = [
    ['d200', 'Distance from 200-day', (s) => s.d200, 'desc'],
    ['d50', 'Distance from 50-day', (s) => s.d50, 'desc'],
    ['chg', "Today's change", (s) => s.chg, 'desc'],
    ['p1m', '1-month return', (s) => s.perf['1M'], 'desc'],
    ['ytd', 'Year-to-date return', (s) => s.perf.YTD, 'desc'],
    ['streak', 'Sessions above the 200-day', (s) => s.streak, 'desc'],
    ['slope', '200-day slope', (s) => s.slope200, 'desc'],
    ['cross', 'Most recent 50/200 cross', (s) => (s.cross ? s.cross.ago : null), 'asc'],
    ['rsi', 'RSI (14)', (s) => s.rsi, 'desc'],
    ['val', 'Average traded value', (s) => s.val20, 'desc'],
    ['mcap', 'Market cap', (s) => s.mcap, 'desc'],
    ['name', 'Ticker A–Z', (s) => s.t, 'asc'],
  ];
  const SORT = Object.fromEntries(SORTS.map(([k, label, get, dir]) => [k, { label, get, dir }]));

  /* ------------------------------------------------------------ state */

  let DATA = null;
  let SERVER = false;
  let list = [];
  let query = '';
  let breadthChart = null;
  let priceChart = null;
  let current = null;
  let lastFocus = null;
  let polling = false;
  const byId = new Map();
  const cardCache = new Map();
  const candleCache = new Map();
  const F = Object.assign({}, DEFAULTS, store.get('filters', {}));
  const SHEET = Object.assign({ range: '1Y', s50: true, s200: true, vol: true, cross: true, px: false, log: false }, store.get('sheet', {}));
  const watch = new Set(store.get('watch', []));
  const pageTitle = document.title;

  function saveFilters() { store.set('filters', F); writeUrl(); }

  // Filters live in the query string too, so any view can be bookmarked or shared: ?index=EGX30&trend=a200
  const VALID = {
    index: (v) => v in SCOPE_LABEL, trend: (v) => v in TRENDS, signal: (v) => v in SIGNAL_TEST,
    liq: (v) => LIQ.some(([x]) => x === v), sort: (v) => v in SORT, dir: (v) => v === 'asc' || v === 'desc',
    view: (v) => v === 'cards' || v === 'table', sector: () => true,
  };
  function readUrl() {
    const p = new URLSearchParams(location.search);
    for (const [k, ok] of Object.entries(VALID)) if (p.has(k) && ok(p.get(k))) F[k] = p.get(k);
    if (p.has('watch')) F.watch = p.get('watch') === '1';
    if (p.has('q')) query = p.get('q').trim().toLowerCase();
  }
  function writeUrl() {
    const p = new URLSearchParams();
    for (const k of Object.keys(DEFAULTS)) if (F[k] !== DEFAULTS[k]) p.set(k, k === 'watch' ? '1' : F[k]);
    if (query) p.set('q', query);
    const qs = p.toString();
    history.replaceState(history.state, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
  }
  function isDefault() { return ['index', 'trend', 'signal', 'sector', 'liq', 'watch'].every((k) => F[k] === DEFAULTS[k]) && !query; }

  /* ------------------------------------------------------------ data */

  async function loadData() {
    let m;
    try { m = await getJSON('data/market.json'); } catch (e) { return false; }
    DATA = m;
    byId.clear();
    cardCache.clear();
    candleCache.clear();
    for (const s of m.stocks) byId.set(s.id, s);
    for (const i of m.indices) byId.set(i.id, Object.assign({}, i, { isIndex: true, idx: [], perf: i.perf || {} }));
    for (const id of [...watch]) if (!byId.has(id)) watch.delete(id);

    $('#firstRun').hidden = true;
    for (const id of ['#front', '#controls', '#main', '#foot']) $(id).hidden = false;
    fillSectorOptions();
    renderMast();
    renderFront();
    renderList();
    renderFoot();
    if (current && byId.has(current)) openSheet(current, { push: false });
    return true;
  }

  /* ------------------------------------------------------------ masthead & footer */

  function renderMast() {
    const meta = DATA.meta;
    // Centre: today's date in Cairo, like a newspaper. Right: which session the prices are from,
    // because EGX trades Sunday to Thursday and on other days the latest prices are older.
    const now = new Date();
    const cairoToday = now.toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
    const cairoDay = now.toLocaleDateString('en-US', { timeZone: 'Africa/Cairo', weekday: 'long' });
    const today = fmt.longDate(cairoToday);
    $('#dateline').replaceChildren(
      h('span', { class: 'd-long', text: today }),
      h('span', { class: 'd-short', text: `${today.slice(0, 3)} ${fmt.dateShort(cairoToday)}` }),
      cairoDay === 'Friday' || cairoDay === 'Saturday' ? h('span', { class: 'd-long', text: ' · market closed' }) : null);
    const session = fmt.longDate(meta.asOf);
    const fresh = $('#freshness');
    fresh.textContent = meta.asOf === cairoToday ? `Updated ${updatedAt()}` : `Prices of ${session.slice(0, 3)} ${fmt.dateShort(meta.asOf)}`;
    fresh.title = `Prices from the EGX session of ${session}, downloaded at ${updatedAt()}.`
      + (SERVER ? '' : ' Updates hourly 10:00–15:00 Cairo time, Sunday to Thursday.');
  }

  // meta.generated is a UTC timestamp (the hosted build runs in UTC); show it in the reader's own time.
  function updatedAt() {
    const t = new Date(DATA.meta.generated);
    const time = t.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return t.toDateString() === new Date().toDateString() ? time : `${time}, ${t.getDate()} ${MONTHS[t.getMonth()]}`;
  }

  function renderFoot() {
    const meta = DATA.meta;
    $('#membershipNote').textContent = `${meta.membership.source}`;
    const notes = [];
    for (const w of meta.warnings || []) notes.push(w);
    const errs = Object.keys(meta.errors || {});
    if (errs.length) notes.push(`Downloads failed for ${errs.length} symbol(s); the previous data was kept where available: ${errs.join(', ')}.`);
    const stale = DATA.stocks.filter((s) => s.stale).map((s) => s.t);
    if (stale.length) notes.push(`Showing older data for: ${stale.join(', ')}.`);
    if ((meta.inactive || []).length) notes.push(`Left out because they haven't traded for 30+ days: ${meta.inactive.join(', ')}.`);
    $('#notes').hidden = !notes.length;
    $('#notes').replaceChildren(...notes.map((n) => h('p', { text: n })));
  }

  /* ------------------------------------------------------------ front page: breadth */

  function inIndex(s, k) { return k === 'ALL' || (k === 'OTHER' ? !s.idx.includes('EGX100') : s.idx.includes(k)); }

  function renderFront() {
    const scope = DATA.stocks.filter((s) => inIndex(s, F.index));
    const ranked = scope.filter((s) => s.a200 != null);
    const above = ranked.filter((s) => s.a200).length;
    $('#scopeLabel').textContent = SCOPE_LABEL[F.index];
    $('#heroPct').textContent = ranked.length ? Math.round((100 * above) / ranked.length) : '—';
    $('#heroCount').textContent = `${above} of ${ranked.length} stocks`;
    renderFacts(scope);

    const g = DATA.breadth.groups[F.index];
    if (!breadthChart) breadthChart = new Charts.BreadthChart($('#breadthChart'), $('#breadthReadout'));
    if (g) breadthChart.setData(DATA.breadth.dates, g.a200, g.a50, g.n);
    renderTiles();
  }

  function renderFacts(scope) {
    scope = scope || DATA.stocks.filter((s) => inIndex(s, F.index));
    const with50 = scope.filter((s) => s.a50 != null);
    const count = (test) => scope.filter(test).length;
    const pctOf = (n, d) => (d ? Math.round((100 * n) / d) + '%' : '');
    const rows = [
      ['Above the 50-day', count((s) => s.a50 === true), pctOf(count((s) => s.a50 === true), with50.length), () => toggleFilter('trend', 'a50'), F.trend === 'a50'],
      ['Above both averages', count(TRENDS.both), '', () => toggleFilter('trend', 'both'), F.trend === 'both'],
      ['Broke above the 200-day, last 10 sessions', count(SIGNAL_TEST.fresh), '', () => toggleFilter('signal', 'fresh'), F.signal === 'fresh'],
      ['Fell below the 200-day, last 10 sessions', count(SIGNAL_TEST.lost), '', () => toggleFilter('signal', 'lost'), F.signal === 'lost'],
      ['Golden crosses, last 30 sessions', count(SIGNAL_TEST.golden), '', () => toggleFilter('signal', 'golden'), F.signal === 'golden'],
      ['Death crosses, last 30 sessions', count(SIGNAL_TEST.death), '', () => toggleFilter('signal', 'death'), F.signal === 'death'],
    ];
    $('#facts').replaceChildren(...rows.map(([label, n, pct, onclick, on]) =>
      h('button', { type: 'button', class: 'fact-row', 'aria-pressed': String(on), onclick, title: on ? 'Click to clear this filter' : 'Show these stocks' },
        h('span', { text: label }), h('b', null, String(n), pct ? h('small', { text: pct }) : null))));
  }

  function toggleFilter(key, value) {
    F[key] = F[key] === value ? DEFAULTS[key] : value;
    saveFilters();
    renderFacts();
    renderList();
    $('#controls').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderTiles() {
    $('#indexTiles').replaceChildren(...DATA.indices.map((i) =>
      h('button', { type: 'button', class: 'tile', onclick: () => openSheet(i.id), 'aria-label': `${i.name}: open chart` },
        h('div', { class: 'tile-top' }, h('span', { class: 'tile-name', text: i.name }), h('span', { class: 'tile-val', text: fmt.price(i.close) })),
        h('div', { class: 'tile-sub' }, deltaEl(i.chg), h('span', null, 'vs 200d ', signedEl(i.d200, 1)), h('span', null, 'vs 50d ', signedEl(i.d50, 1))),
        sparkline(i.spark))));
  }

  /* ------------------------------------------------------------ sparkline */

  function sparkline(sp) {
    const wrap = h('div', { class: 'spark-wrap' });
    const c = sp.c, n = c.length;
    if (n < 2) { wrap.append(h('div', { class: 'spark-none', text: 'Not enough history' })); return wrap; }
    let lo = Infinity, hi = -Infinity;
    for (const arr of [sp.c, sp.s50, sp.s200]) for (const v of arr) if (v != null) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (hi - lo < 1e-9) { hi += Math.abs(hi) * 0.01 || 1; lo -= Math.abs(lo) * 0.01 || 1; }
    const pad = (hi - lo) * 0.08;
    lo -= pad; hi += pad;
    const x = (i) => (i / (n - 1)) * 100;
    const y = (v) => 100 - ((v - lo) / (hi - lo)) * 100;
    const path = (arr) => {
      let d = '', pen = false;
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i];
        if (v == null) { pen = false; continue; }
        d += (pen ? 'L' : 'M') + x(i).toFixed(2) + ' ' + y(v).toFixed(2);
        pen = true;
      }
      return d;
    };
    const el = svg('svg', { class: 'spark', viewBox: '0 0 100 100', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    for (const [arr, cls] of [[sp.s200, 'l-200'], [sp.s50, 'l-50'], [sp.c, 'l-c']]) {
      const d = path(arr);
      if (d) el.append(svg('path', { d, class: cls }));
    }
    wrap.append(el, h('span', { class: 'spark-dot', style: `left:${x(n - 1)}%;top:${y(c[n - 1]).toFixed(2)}%` }));
    return wrap;
  }

  /* ------------------------------------------------------------ the list */

  function matches(s) {
    if (!inIndex(s, F.index)) return false;
    if (!(TRENDS[F.trend] || TRENDS.any)(s)) return false;
    if (!(SIGNAL_TEST[F.signal] || SIGNAL_TEST.any)(s)) return false;
    if (F.sector !== 'all' && (s.sector || 'Other') !== F.sector) return false;
    if (s.val20 < Number(F.liq)) return false;
    if (F.watch && !watch.has(s.id)) return false;
    if (query && !s.t.toLowerCase().includes(query) && !(s.name || '').toLowerCase().includes(query) && !s.id.toLowerCase().includes(query)) return false;
    return true;
  }

  function sortList(arr) {
    const def = SORT[F.sort] || SORT.d200;
    const dir = F.dir === 'asc' ? 1 : -1;
    return arr.slice().sort((a, b) => {
      const va = def.get(a), vb = def.get(b);
      if (va == null || vb == null) return va == null && vb == null ? a.t.localeCompare(b.t) : va == null ? 1 : -1;
      if (typeof va === 'string') return dir * va.localeCompare(vb);
      return dir * (va - vb) || a.t.localeCompare(b.t);
    });
  }

  function renderList() {
    list = sortList(DATA.stocks.filter(matches));
    $('#count').textContent = `${list.length} of ${DATA.stocks.length} stocks`;
    $('#listTitle').textContent = SCOPE_LABEL[F.index] + (TREND_TITLE[F.trend] ? ', ' + TREND_TITLE[F.trend] : '');
    const cards = F.view === 'cards';
    $('#empty').hidden = list.length > 0;
    $('#grid').hidden = !cards || !list.length;
    $('#tableWrap').hidden = cards || !list.length;
    if (cards) {
      const frag = document.createDocumentFragment();
      for (const s of list) {
        let el = cardCache.get(s.id);
        if (!el) { el = card(s); cardCache.set(s.id, el); }
        frag.append(el);
      }
      $('#grid').replaceChildren(frag);
    } else {
      renderTable();
    }
    syncControls();
    updateSheetNav();
  }

  function tags(s) {
    const t = s.idx.filter((x) => x !== 'EGX100').map((x) => h('span', { class: 'tag', text: x }));
    if (s.a200 == null) t.push(h('span', { class: 'tag muted', text: 'NEW' }));
    if (s.val20 < THIN) t.push(h('span', { class: 'tag muted', text: 'THIN', title: 'Average daily traded value under 1M EGP' }));
    return h('span', { class: 'tags' }, t);
  }

  function starBtn(s) {
    const on = watch.has(s.id);
    return h('button', {
      type: 'button', class: 'star', dataset: { star: s.id }, 'aria-pressed': String(on),
      'aria-label': `${on ? 'Remove' : 'Add'} ${s.t} ${on ? 'from' : 'to'} watchlist`, text: on ? '★' : '☆',
    });
  }

  function gauge(label, v) {
    const g = h('span', { class: 'gauge' });
    if (v != null) {
      const w = (Math.min(Math.abs(v), GAUGE_MAX) / GAUGE_MAX) * 50;
      g.append(h('i', { class: (v >= 0 ? 'up' : 'down') + (Math.abs(v) > GAUGE_MAX ? ' over' : ''), style: `width:${w.toFixed(1)}%` }));
    }
    return h('div', { class: 'dist' }, h('span', { class: 'lbl', text: label }), g, h('span', { class: 'val', text: fmt.pct(v) }));
  }

  function note(s) {
    if (s.a200 == null) return [`Listed ${fmt.sessions(s.bars)} ago: no 200-day average yet.`];
    const parts = [];
    if (s.cross && s.cross.ago <= 30) {
      parts.push(h('span', { class: 'sig', text: s.cross.type === 'golden' ? '▲ Golden cross' : '▼ Death cross' }), ` ${fmt.ago(s.cross.ago)}. `);
    }
    const k = Math.abs(s.streak);
    const capped = k >= s.bars - 199 ? '+' : '';
    if (s.streak > 0 && s.streak <= 10) parts.push(h('span', { class: 'sig', text: '↗ Broke above the 200-day' }), ` ${fmt.ago(k - 1)}.`);
    else if (s.streak < 0 && s.streak >= -10) parts.push(h('span', { class: 'sig', text: '↘ Fell below the 200-day' }), ` ${fmt.ago(k - 1)}.`);
    else parts.push(`${s.streak > 0 ? 'Above' : 'Below'} the 200-day for ${fmt.sessions(k, capped)}.`);
    return parts;
  }

  function card(s) {
    return h('article', { class: 'card' + (s.val20 < THIN ? ' thin' : ''), tabindex: '0', dataset: { id: s.id }, 'aria-label': `${s.t}, ${s.name}. Open chart` },
      h('div', { class: 'c-top' }, h('span', { class: 'c-tk', text: s.t }), tags(s), starBtn(s)),
      h('p', { class: 'c-name', text: s.name, title: s.name }),
      h('div', { class: 'c-price' },
        h('span', { class: 'c-close', text: fmt.price(s.close) }), deltaEl(s.chg),
        s.last < DATA.meta.asOf ? h('span', { class: 'c-date', text: 'last ' + fmt.dateShort(s.last), title: 'No trade since this date' }) : null),
      sparkline(s.spark),
      gauge('200d', s.d200),
      gauge('50d', s.d50),
      h('p', { class: 'c-note' }, note(s)));
  }

  const COLS = [
    { label: '', cls: 'l', cell: (s) => starBtn(s) },
    { k: 'name', label: 'Ticker', cls: 'l tk', cell: (s) => s.t },
    { label: 'Company', cls: 'l nm', cell: (s) => s.name },
    { label: 'Close', cell: (s) => fmt.price(s.close) },
    { k: 'chg', label: 'Day', cell: (s) => deltaEl(s.chg) },
    { k: 'd50', label: 'vs 50d', cell: (s) => signedEl(s.d50) },
    { k: 'd200', label: 'vs 200d', cell: (s) => signedEl(s.d200) },
    { k: 'slope', label: '200d slope', cell: (s) => fmt.pct(s.slope200) },
    { k: 'streak', label: 'Streak', cell: (s) => (s.streak > 0 ? '+' : s.streak < 0 ? '−' : '') + Math.abs(s.streak) },
    { k: 'cross', label: 'Last cross', cell: (s) => (s.cross ? `${s.cross.type === 'golden' ? 'Golden' : 'Death'} · ${s.cross.ago}` : '—') },
    { k: 'rsi', label: 'RSI', cell: (s) => (s.rsi == null ? '—' : s.rsi.toFixed(0)) },
    { k: 'p1m', label: '1M', cell: (s) => signedEl(s.perf['1M']) },
    { k: 'ytd', label: 'YTD', cell: (s) => signedEl(s.perf.YTD) },
    { k: 'val', label: 'Avg value', cell: (s) => fmt.compact(s.val20) },
    { k: 'mcap', label: 'Mkt cap', cell: (s) => fmt.compact(s.mcap) },
    { label: 'Index', cls: 'l', cell: (s) => s.idx.filter((x) => x !== 'EGX100').join(' ') || '—' },
  ];

  function renderTable() {
    const head = h('tr', null, COLS.map((c) => {
      const th = h('th', { class: c.cls || '', scope: 'col' });
      if (c.k) {
        th.append(h('button', { type: 'button', text: c.label, onclick: () => sortBy(c.k) }));
        if (F.sort === c.k) th.setAttribute('aria-sort', F.dir === 'asc' ? 'ascending' : 'descending');
      } else th.textContent = c.label;
      return th;
    }));
    const body = h('tbody');
    for (const s of list) body.append(h('tr', { dataset: { id: s.id }, tabindex: '0' }, COLS.map((c) => h('td', { class: c.cls || '' }, c.cell(s)))));
    $('#table').replaceChildren(h('thead', null, head), body);
  }

  function sortBy(k) {
    if (F.sort === k) F.dir = F.dir === 'asc' ? 'desc' : 'asc';
    else { F.sort = k; F.dir = SORT[k].dir; }
    saveFilters();
    renderList();
  }

  function toggleWatch(id) {
    if (watch.has(id)) watch.delete(id); else watch.add(id);
    store.set('watch', [...watch]);
    const on = watch.has(id);
    const s = byId.get(id);
    const stars = $$(`[data-star="${CSS.escape(id)}"]`);
    const cached = cardCache.get(id);
    if (cached) stars.push(...$$('.star', cached));
    for (const b of stars) {
      b.setAttribute('aria-pressed', String(on));
      b.textContent = on ? '★' : '☆';
      b.setAttribute('aria-label', `${on ? 'Remove' : 'Add'} ${s.t} ${on ? 'from' : 'to'} watchlist`);
    }
    if (current === id) syncSheetStar();
    if (F.watch) renderList(); else syncControls();
  }

  /* ------------------------------------------------------------ controls */

  function buildControls() {
    $('#fSignal').replaceChildren(...SIGNALS.map(([k, label]) => h('option', { value: k, text: label })));
    $('#fLiq').replaceChildren(...LIQ.map(([v, label]) => h('option', { value: v, text: label })));
    $('#fSort').replaceChildren(...SORTS.map(([k, label]) => h('option', { value: k, text: label })));
  }

  function fillSectorOptions() {
    const counts = new Map();
    for (const s of DATA.stocks) { const k = s.sector || 'Other'; counts.set(k, (counts.get(k) || 0) + 1); }
    const sectors = [...counts].sort((a, b) => a[0].localeCompare(b[0]));
    $('#fSector').replaceChildren(h('option', { value: 'all', text: 'All sectors' }), ...sectors.map(([k, n]) => h('option', { value: k, text: `${k} (${n})` })));
    if (F.sector !== 'all' && !counts.has(F.sector)) F.sector = 'all';
  }

  function syncControls() {
    for (const seg of $$('.controls .seg')) {
      for (const b of $$('button', seg)) b.setAttribute('aria-pressed', String(b.dataset.v === F[seg.dataset.key]));
    }
    $('#fSignal').value = F.signal;
    $('#fSector').value = F.sector;
    $('#fLiq').value = F.liq;
    $('#fSort').value = F.sort;
    $('#fSignal').closest('.sel').classList.toggle('active', F.signal !== 'any');
    $('#fSector').closest('.sel').classList.toggle('active', F.sector !== 'all');
    $('#fLiq').closest('.sel').classList.toggle('active', F.liq !== '0');
    $('#dirBtn').textContent = F.dir === 'asc' ? '↑ Low first' : '↓ High first';
    $('#watchBtn').setAttribute('aria-pressed', String(F.watch));
    $('#watchCount').textContent = watch.size ? `(${watch.size})` : '';
    $('#resetBtn').hidden = isDefault();
  }

  function setFilter(key, value) {
    F[key] = value;
    saveFilters();
    if (key === 'index') renderFront(); else renderFacts();
    renderList();
  }

  function resetFilters() {
    for (const k of ['index', 'trend', 'signal', 'sector', 'liq', 'watch']) F[k] = DEFAULTS[k];
    query = '';
    $('#q').value = '';
    saveFilters();
    renderFront();
    renderList();
  }

  function bindControls() {
    for (const seg of $$('.controls .seg')) {
      seg.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-v]');
        if (b) setFilter(seg.dataset.key, b.dataset.v);
      });
    }
    $('#fSignal').addEventListener('change', (e) => setFilter('signal', e.target.value));
    $('#fSector').addEventListener('change', (e) => setFilter('sector', e.target.value));
    $('#fLiq').addEventListener('change', (e) => setFilter('liq', e.target.value));
    $('#fSort').addEventListener('change', (e) => { F.sort = e.target.value; F.dir = SORT[F.sort].dir; saveFilters(); renderList(); });
    $('#dirBtn').addEventListener('click', () => { F.dir = F.dir === 'asc' ? 'desc' : 'asc'; saveFilters(); renderList(); });
    $('#watchBtn').addEventListener('click', () => setFilter('watch', !F.watch));
    $('#q').addEventListener('input', (e) => { query = e.target.value.trim().toLowerCase(); writeUrl(); renderList(); });
    $('#csvBtn').addEventListener('click', exportCsv);
    $('#resetBtn').addEventListener('click', resetFilters);
    $('#emptyReset').addEventListener('click', resetFilters);
    $('#refreshBtn').addEventListener('click', refresh);

    const openFrom = (e) => {
      const star = e.target.closest('[data-star]');
      if (star) { e.stopPropagation(); toggleWatch(star.dataset.star); return; }
      const row = e.target.closest('[data-id]');
      if (row) openSheet(row.dataset.id);
    };
    for (const host of [$('#grid'), $('#table')]) {
      host.addEventListener('click', openFrom);
      host.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.matches('[data-id]')) openSheet(e.target.dataset.id);
      });
    }
  }

  function exportCsv() {
    const head = ['ticker', 'name', 'indices', 'sector', 'close', 'change_pct', 'sma50', 'sma200', 'vs_sma50_pct', 'vs_sma200_pct',
      'sma200_slope_20d_pct', 'sessions_on_side_of_sma200', 'last_cross', 'last_cross_date', 'rsi14', 'return_1m_pct', 'return_ytd_pct',
      'avg_value_20d_egp', 'last_trade'];
    const rows = list.map((s) => [s.t, s.name, s.idx.join(' '), s.sector || '', s.close, s.chg, s.sma50, s.sma200, s.d50, s.d200,
      s.slope200, s.streak, s.cross ? s.cross.type : '', s.cross ? s.cross.date : '', s.rsi, s.perf['1M'], s.perf.YTD, s.val20, s.last]);
    const esc = (v) => { if (v == null) return ''; const t = String(v); return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
    const csv = [head, ...rows].map((r) => r.map(esc).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    const a = h('a', { href: url, download: `egx-above-the-line-${DATA.meta.asOf}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  /* ------------------------------------------------------------ the sheet */

  async function candles(id) {
    if (candleCache.has(id)) return candleCache.get(id);
    const c = await getJSON(`data/candles/${encodeURIComponent(id)}.json`);
    candleCache.set(id, c);
    return c;
  }

  function setInert(on) {
    for (const id of ['.mast', '#firstRun', '#front', '#controls', '#main', '#foot']) $(id).inert = on;
  }

  async function openSheet(id, { push = true } = {}) {
    const s = byId.get(id);
    if (!s) return;
    const sheet = $('#sheet');
    const wasOpen = !sheet.hidden;
    if (!wasOpen) lastFocus = document.activeElement;
    current = id;
    sheet.hidden = false;
    document.body.classList.add('sheet-open');
    setInert(true);
    if (push) {
      const url = '#/' + encodeURIComponent(id);
      if (wasOpen) history.replaceState({ sheet: id }, '', url); else history.pushState({ sheet: id }, '', url);
    }
    document.title = `${s.t} · ${pageTitle}`;
    fillSheetHead(s);
    fillFacts(s);
    updateSheetNav();
    if (!priceChart) {
      priceChart = new Charts.PriceChart($('#bigChart'), $('#legend'));
      for (const k of ['s50', 's200', 'vol', 'cross', 'px', 'log']) priceChart.show[k] = SHEET[k];
      priceChart.range = SHEET.range;
    }
    syncSheetControls();
    if (!wasOpen && push) $('#sBack').focus();

    const msg = $('#chartMsg');
    let c;
    try { c = await candles(s.id); } catch (e) {
      if (current === id) { msg.hidden = false; msg.textContent = 'Could not load this chart. Try Refresh data.'; }
      return;
    }
    if (current !== id) return;
    msg.hidden = true;
    priceChart.setData(c, s);
    fillSessionTable(c);
  }

  function closeSheet({ fromPop = false } = {}) {
    const sheet = $('#sheet');
    if (sheet.hidden) return;
    sheet.hidden = true;
    document.body.classList.remove('sheet-open');
    setInert(false);
    current = null;
    document.title = pageTitle;
    if (!fromPop) {
      if (history.state && history.state.sheet) history.back();
      else history.replaceState(null, '', location.pathname + location.search);
    }
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  }

  function routeFromHash() {
    const m = location.hash.match(/^#\/(.+)$/);
    const id = m ? decodeURIComponent(m[1]) : null;
    if (id && byId.has(id)) openSheet(id, { push: false });
    else closeSheet({ fromPop: true });
  }

  function navIds() {
    const s = byId.get(current);
    if (!s) return [];
    return s.isIndex ? DATA.indices.map((i) => i.id) : list.map((x) => x.id);
  }

  function updateSheetNav() {
    if (!current) return;
    const ids = navIds();
    const i = ids.indexOf(current);
    $('#sPos').textContent = i >= 0 ? `${i + 1} / ${ids.length}` : 'not in the current list';
    $('#sPrev').disabled = i <= 0;
    $('#sNext').disabled = i < 0 || i >= ids.length - 1;
  }

  function step(d) {
    const ids = navIds();
    const i = ids.indexOf(current);
    if (i >= 0 && ids[i + d]) openSheet(ids[i + d]);
  }

  function syncSheetStar() {
    const on = watch.has(current);
    const b = $('#sStar');
    b.setAttribute('aria-pressed', String(on));
    b.textContent = on ? '★ On watchlist' : '☆ Add to watchlist';
  }

  function fillSheetHead(s) {
    $('#sKicker').textContent = s.isIndex ? 'Index · Egyptian Exchange'
      : [s.idx.filter((x) => x !== 'EGX100').join(' · '), s.sector, s.industry].filter(Boolean).join(' · ');
    $('#sTicker').textContent = s.t;
    $('#sName').textContent = s.name;
    $('#sClose').textContent = fmt.price(s.close);
    $('#sChg').replaceWith(Object.assign(deltaEl(s.chg), { id: 'sChg' }));
    $('#sDate').textContent = 'close ' + fmt.date(s.last);
    $('#sStar').hidden = !!s.isIndex;
    if (!s.isIndex) syncSheetStar();
    $('#sTv').href = 'https://www.tradingview.com/chart/?symbol=' + encodeURIComponent(s.sym);
  }

  function dl(rows) {
    return h('dl', null, rows.filter(Boolean).map(([k, v]) => [h('dt', { text: k }), h('dd', null, v)]));
  }
  function fact(title, ...body) {
    return h('section', { class: 'fact' }, h('h3', null, title), body);
  }

  function fillFacts(s) {
    const out = [];
    const k = Math.abs(s.streak);
    out.push(fact([h('i', { class: 'key s200' }), 'Against the 200-day'],
      s.sma200 == null ? h('p', { text: `Only ${fmt.sessions(s.bars)} of history, so no 200-day average yet.` }) : dl([
        ['200-day average', fmt.price(s.sma200)],
        ['Price vs the average', signedEl(s.d200, 2)],
        ['Direction, last 20 sessions', s.slope200 == null ? '—' : [s.slope200 > 0 ? 'Rising ' : s.slope200 < 0 ? 'Falling ' : 'Flat ', signedEl(s.slope200, 2)]],
        [s.streak > 0 ? 'Above it for' : 'Below it for', fmt.sessions(k, k >= s.bars - 199 ? '+' : '')],
        s.since ? ['Since', fmt.date(s.since)] : null,
      ])));
    out.push(fact([h('i', { class: 'key s50' }), 'Against the 50-day'],
      s.sma50 == null ? h('p', { text: 'Not enough history for a 50-day average.' }) : dl([
        ['50-day average', fmt.price(s.sma50)],
        ['Price vs the average', signedEl(s.d50, 2)],
        s.sma200 != null ? ['50-day vs 200-day', [s.sma50 > s.sma200 ? 'Above ' : 'Below ', signedEl((s.sma50 / s.sma200 - 1) * 100, 1)]] : null,
      ])));
    out.push(fact('Crosses',
      dl([
        ['Last 50/200 cross', s.cross ? (s.cross.type === 'golden' ? '▲ Golden cross' : '▼ Death cross') : 'None in 5 years'],
        s.cross ? ['When', `${fmt.date(s.cross.date)}, ${fmt.ago(s.cross.ago)}`] : null,
      ]),
      h('p', { text: 'A golden cross is the 50-day rising through the 200-day; a death cross is the reverse.' })));
    if (s.hi52 != null && s.lo52 != null) {
      const pos = s.hi52 > s.lo52 ? Math.max(0, Math.min(100, ((s.close - s.lo52) / (s.hi52 - s.lo52)) * 100)) : 50;
      out.push(fact('52-week range',
        h('div', { class: 'range52', role: 'img', 'aria-label': `52-week range ${fmt.price(s.lo52)} to ${fmt.price(s.hi52)}, last close ${fmt.price(s.close)}` },
          h('i', { style: `left:${pos.toFixed(1)}%` })),
        h('div', { class: 'range52-ends' }, h('span', { text: fmt.price(s.lo52) }), h('span', { text: fmt.price(s.hi52) })),
        dl([['From the high', signedEl(s.fromHi, 1)]])));
    }
    const p = s.perf || {};
    out.push(fact('Momentum',
      dl([['RSI (14)', s.rsi == null ? '—' : `${s.rsi.toFixed(0)}${s.rsi >= 70 ? ', overbought' : s.rsi <= 30 ? ', oversold' : ''}`]]),
      h('div', { class: 'perf-grid' }, ['1W', '1M', '3M', '6M', 'YTD', '1Y'].map((key) =>
        h('div', null, h('span', { text: key }), signedEl(p[key], 1, 'b'))))));
    if (!s.isIndex) {
      out.push(fact('Trading', dl([
        ['Avg daily value, 20 sessions', fmt.compact(s.val20) + ' EGP'],
        ['Last session volume', fmt.compact(s.vol) + ' shares'],
        s.mcap ? ['Market cap', fmt.compact(s.mcap) + ' EGP'] : null,
        ['History loaded', fmt.sessions(s.bars)],
      ])));
    }
    $('#sFacts').replaceChildren(...out);
  }

  function fillSessionTable(c) {
    const s50 = Charts.sma(c.c, 50), s200 = Charts.sma(c.c, 200);
    const head = h('tr', null, ['Date', 'Open', 'High', 'Low', 'Close', 'Change', 'Volume', '50-day', '200-day'].map((t, i) => h('th', { class: i ? '' : 'l', scope: 'col', text: t })));
    const body = h('tbody');
    for (let i = c.d.length - 1; i >= Math.max(0, c.d.length - 30); i--) {
      const chg = i > 0 ? (c.c[i] / c.c[i - 1] - 1) * 100 : null;
      body.append(h('tr', null,
        h('td', { class: 'l', text: fmt.date(c.d[i]) }), h('td', { text: fmt.price(c.o[i]) }), h('td', { text: fmt.price(c.h[i]) }),
        h('td', { text: fmt.price(c.l[i]) }), h('td', { text: fmt.price(c.c[i]) }), h('td', null, deltaEl(chg)),
        h('td', { text: fmt.compact(c.v[i]) }), h('td', { text: fmt.price(s50[i]) }), h('td', { text: fmt.price(s200[i]) })));
    }
    $('#sTable').replaceChildren(h('thead', null, head), body);
  }

  function syncSheetControls() {
    for (const b of $$('#sRange button')) b.setAttribute('aria-pressed', String(b.dataset.v === SHEET.range));
    for (const b of $$('#sToggles .tog')) b.setAttribute('aria-pressed', String(!!SHEET[b.dataset.t]));
  }

  function bindSheet() {
    $('#sBack').addEventListener('click', () => closeSheet());
    $('#sPrev').addEventListener('click', () => step(-1));
    $('#sNext').addEventListener('click', () => step(1));
    $('#sStar').addEventListener('click', () => { if (current) toggleWatch(current); });
    $('#sRange').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      SHEET.range = b.dataset.v;
      store.set('sheet', SHEET);
      syncSheetControls();
      if (priceChart) priceChart.setRange(SHEET.range);
    });
    $('#sToggles').addEventListener('click', (e) => {
      const b = e.target.closest('.tog');
      if (!b) return;
      const t = b.dataset.t;
      SHEET[t] = !SHEET[t];
      store.set('sheet', SHEET);
      syncSheetControls();
      if (priceChart) priceChart.set(t, SHEET[t]);
    });
    window.addEventListener('popstate', routeFromHash);
  }

  function bindKeys() {
    document.addEventListener('keydown', (e) => {
      const inField = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
      if (!$('#sheet').hidden) {
        if (e.key === 'Escape') { e.preventDefault(); closeSheet(); }
        else if (!inField && e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
        else if (!inField && e.key === 'ArrowRight') { e.preventDefault(); step(1); }
        return;
      }
      if (e.key === '/' && !inField) { e.preventDefault(); $('#q').focus(); }
      else if (e.key === 'Escape' && e.target === $('#q') && query) { $('#q').value = ''; query = ''; writeUrl(); renderList(); }
    });
  }

  /* ------------------------------------------------------------ theme */

  function theme() {
    return document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }

  function bindTheme() {
    const btn = $('#themeBtn');
    const label = () => { btn.textContent = theme() === 'dark' ? 'Day edition' : 'Night edition'; };
    const retheme = () => { if (breadthChart) breadthChart.retheme(); if (priceChart) priceChart.retheme(); };
    label();
    btn.addEventListener('click', () => {
      const next = theme() === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      store.set('theme', next);
      label();
      retheme();
    });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (!document.documentElement.dataset.theme) { label(); retheme(); }
    });
  }

  /* ------------------------------------------------------------ refresh */

  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, 5000);
  }

  async function refresh() {
    let r = null;
    try { r = await fetch('api/refresh', { method: 'POST', headers: { 'X-Requested-By': 'above-the-line' } }); } catch (e) { /* no server */ }
    if (!r || !r.ok) { toast('Refreshing needs the local server. Start it with: python server.py'); return; }
    poll();
  }

  function showProgress(st) {
    const share = st.total ? st.done / st.total : st.phase === 'Listing EGX stocks' ? 0.02 : /Computing|Measuring|Done/.test(st.phase) ? 0.98 : 0;
    $('#progressBar').style.width = Math.round(share * 100) + '%';
    $('#progressLabel').textContent = st.total ? `${st.phase} ${st.done}/${st.total}` : st.phase;
    $('#freshness').textContent = 'Refreshing…';
  }

  async function poll() {
    if (polling) return;
    polling = true;
    $('#refreshBtn').disabled = true;
    $('#progress').hidden = false;
    for (;;) {
      let st;
      try { st = await getJSON('api/status'); } catch (e) { toast('Lost contact with the local server.'); break; }
      showProgress(st);
      if (!st.running) {
        if (st.error) {
          toast('Refresh failed: ' + st.error);
          if (DATA) renderMast();
          else $('#firstRunText').textContent = 'The download failed: ' + st.error + '. Check your internet connection and press Refresh data.';
        } else {
          $('#main').classList.add('reloading');
          const ok = await loadData();
          $('#main').classList.remove('reloading');
          if (ok) toast(`Updated. Prices as of ${fmt.date(DATA.meta.asOf)}.`);
        }
        break;
      }
      await sleep(700);
    }
    $('#progress').hidden = true;
    $('#refreshBtn').disabled = false;
    polling = false;
  }

  /* ------------------------------------------------------------ hosted: pick up new data */

  // On the hosted site a scheduled job republishes the data every hour of the trading day.
  // An open page checks a tiny version file and reloads the data in place when it changes.
  async function checkForNewData() {
    if (document.visibilityState !== 'visible') return;
    if (!DATA) { await loadData(); return; }
    let v;
    try { v = await getJSON('data/version.json'); } catch (e) { return; }
    if (!v.generated || v.generated === DATA.meta.generated) return;
    $('#main').classList.add('reloading');
    const ok = await loadData();
    $('#main').classList.remove('reloading');
    if (ok) toast(`New prices loaded (updated ${updatedAt()}).`);
  }

  /* ------------------------------------------------------------ start */

  async function init() {
    readUrl();
    $('#q').value = query;
    buildControls();
    bindControls();
    bindSheet();
    bindKeys();
    bindTheme();

    let status = null;
    // Only the local server (server.py, bound to 127.0.0.1) has an API; don't probe for it on the hosted site.
    if (['127.0.0.1', 'localhost'].includes(location.hostname)) {
      try { status = await getJSON('api/status'); SERVER = true; } catch (e) { SERVER = false; }
    }
    // Hosted as static files (GitHub Pages) there is no server to rebuild the data; a scheduled job does it.
    $('#refreshBtn').hidden = !SERVER;
    const ok = await loadData();
    if (!SERVER) {
      setInterval(checkForNewData, 5 * 60 * 1000);
      document.addEventListener('visibilitychange', checkForNewData);
    }
    if (ok) {
      routeFromHash();
      if (status && status.running) poll();
      return;
    }
    $('#firstRun').hidden = false;
    if (status && status.running) poll();
    else if (!SERVER) $('#firstRunText').textContent = location.protocol === 'file:'
      ? 'No data yet. Start the local server with "python server.py"; it downloads the data on first run.'
      : 'The market data hasn’t been published yet. Check back after the next EGX session.';
    else $('#firstRunText').textContent = 'No data yet. Press Refresh data to download it (about a minute).';
  }

  init();
})();
