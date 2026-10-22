/* Chart wrappers around TradingView Lightweight Charts v5.
   Colours come from the CSS tokens, so both charts follow the day/night edition. */
(function () {
  'use strict';
  const L = window.LightweightCharts;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function token(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function palette() {
    return {
      surface: token('--surface'), ink: token('--ink'), ink2: token('--ink-2'), ink3: token('--ink-3'),
      rule: token('--rule'), grid: token('--rule-2'), s50: token('--s50'), s200: token('--s200'),
      up: token('--up'), down: token('--down'), vol: token('--vol'),
    };
  }

  function sma(values, n) {
    const out = new Array(values.length).fill(null);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= n) sum -= values[i - n];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }

  function lineData(dates, values) {
    const out = [];
    for (let i = 0; i < dates.length; i++) if (values[i] != null) out.push({ time: dates[i], value: values[i] });
    return out;
  }

  function precisionFor(price) { return Math.abs(price) < 10 ? 3 : 2; }

  function dayLabel(iso) {
    const d = new Date(iso + 'T12:00:00Z');
    return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  }

  function compact(v) {
    const a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return String(Math.round(v));
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function baseOptions(p) {
    return {
      autoSize: true,
      layout: {
        background: { type: L.ColorType.Solid, color: p.surface },
        textColor: p.ink3,
        fontFamily: '"IBM Plex Mono", Consolas, monospace',
        fontSize: 11,
        attributionLogo: true,
        panes: { separatorColor: p.rule, separatorHoverColor: p.grid, enableResize: true },
      },
      grid: { vertLines: { color: p.grid }, horzLines: { color: p.grid } },
      rightPriceScale: { borderColor: p.rule },
      timeScale: { borderColor: p.rule, rightOffset: 3, minBarSpacing: 0.4 },
      crosshair: {
        mode: L.CrosshairMode.Normal,
        vertLine: { color: p.ink3, width: 1, style: L.LineStyle.Solid, labelBackgroundColor: p.ink },
        horzLine: { color: p.ink3, width: 1, style: L.LineStyle.Solid, labelBackgroundColor: p.ink },
      },
      localization: { locale: 'en-GB' },
    };
  }

  /* ------------------------------------------------------------ price chart */

  class PriceChart {
    constructor(host, legend) {
      this.host = host;
      this.legend = legend;
      this.data = null;
      this.info = null;
      this.show = { s50: true, s200: true, vol: true, cross: true, px: false, log: false };
      this.range = '1Y';
      this._build();
    }

    _build() {
      const p = (this.p = palette());
      this.chart = L.createChart(this.host, baseOptions(p));
      this.candles = this.chart.addSeries(L.CandlestickSeries, {
        upColor: p.up, downColor: p.down, wickUpColor: p.up, wickDownColor: p.down,
        borderVisible: false, priceLineColor: p.ink3, priceLineStyle: L.LineStyle.Solid,
      });
      const line = (color, title) => ({
        color, lineWidth: 2, title, priceLineVisible: false, lastValueVisible: true,
        crosshairMarkerVisible: false, lineType: L.LineType.Simple,
      });
      this.l50 = this.chart.addSeries(L.LineSeries, line(p.s50, '50d'));
      this.l200 = this.chart.addSeries(L.LineSeries, line(p.s200, '200d'));
      this.markers = L.createSeriesMarkers(this.candles, []);
      this.vol = null;
      this.chart.subscribeCrosshairMove((param) => this._legend(param));
    }

    _syncVolume() {
      if (this.show.vol && !this.vol) {
        this.vol = this.chart.addSeries(L.HistogramSeries, {
          color: this.p.vol, priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false,
        }, 1);
        const panes = this.chart.panes();
        if (panes[1]) { panes[0].setStretchFactor(1); panes[1].setStretchFactor(0.22); }
        if (this.data) this.vol.setData(this.data.d.map((t, i) => ({ time: t, value: this.data.v[i] })));
      } else if (!this.show.vol && this.vol) {
        this.chart.removeSeries(this.vol);
        this.vol = null;
      }
    }

    setData(c, info) {
      this.data = c;
      this.info = info;
      this.index = new Map(c.d.map((t, i) => [t, i]));
      const prec = precisionFor(c.c[c.c.length - 1]);
      const priceFormat = { type: 'price', precision: prec, minMove: Math.pow(10, -prec) };
      for (const s of [this.candles, this.l50, this.l200]) s.applyOptions({ priceFormat });
      this.candles.setData(c.d.map((t, i) => ({ time: t, open: c.o[i], high: c.h[i], low: c.l[i], close: c.c[i] })));
      this.s50v = sma(c.c, 50);
      this.s200v = sma(c.c, 200);
      this.l50.setData(lineData(c.d, this.s50v));
      this.l200.setData(lineData(c.d, this.s200v));
      if (this.vol) this.vol.setData(c.d.map((t, i) => ({ time: t, value: c.v[i] })));
      this._syncVolume();
      this._applyToggles();
      this._markers();
      this.setRange(this.range);
      this._legend(null);
    }

    set(key, on) {
      this.show[key] = on;
      if (key === 'vol') this._syncVolume();
      if (key === 'cross' || key === 'px') this._markers();
      this._applyToggles();
      this._legend(null);
    }

    _applyToggles() {
      this.l50.applyOptions({ visible: this.show.s50 });
      this.l200.applyOptions({ visible: this.show.s200 });
      this.chart.priceScale('right').applyOptions({
        mode: this.show.log ? L.PriceScaleMode.Logarithmic : L.PriceScaleMode.Normal,
      });
    }

    _markers() {
      const out = [];
      if (this.data) {
        const d = this.data.d, c = this.data.c, a = this.s50v, b = this.s200v, p = this.p;
        for (let i = 1; i < d.length; i++) {
          if (b[i] == null || b[i - 1] == null) continue;
          if (this.show.cross && a[i] != null && a[i - 1] != null && (a[i] > b[i]) !== (a[i - 1] > b[i - 1])) {
            const up = a[i] > b[i];
            out.push({ time: d[i], position: up ? 'belowBar' : 'aboveBar', shape: up ? 'arrowUp' : 'arrowDown',
              color: p.ink, text: up ? 'Golden cross' : 'Death cross' });
          }
          if (this.show.px && (c[i] > b[i]) !== (c[i - 1] > b[i - 1])) {
            const up = c[i] > b[i];
            out.push({ time: d[i], position: up ? 'belowBar' : 'aboveBar', shape: 'circle',
              color: up ? p.up : p.down, size: 0.6 });
          }
        }
      }
      this.markers.setMarkers(out);
    }

    setRange(r) {
      this.range = r;
      if (!this.data) return;
      const d = this.data.d, last = d[d.length - 1];
      const ts = this.chart.timeScale();
      const months = { '3M': 3, '6M': 6, '1Y': 12, '2Y': 24 }[r];
      if (!months) { ts.fitContent(); return; }
      const from = new Date(last + 'T00:00:00Z');
      from.setUTCMonth(from.getUTCMonth() - months);
      const fromIso = from.toISOString().slice(0, 10);
      if (fromIso <= d[0]) { ts.fitContent(); return; }
      ts.setVisibleRange({ from: fromIso, to: last });
    }

    _legend(param) {
      const box = this.legend;
      if (!this.data) { box.replaceChildren(); return; }
      const d = this.data;
      let i = param && param.time != null ? this.index.get(param.time) : undefined;
      if (i == null) i = d.d.length - 1;
      const prec = precisionFor(d.c[d.c.length - 1]);
      const f = (v) => v == null ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: prec, maximumFractionDigits: prec });
      const pair = (label, value) => { const s = el('span'); s.append(label + ' ', el('b', null, value)); return s; };

      const row1 = el('div', 'row');
      row1.append(el('b', null, dayLabel(d.d[i])), pair('O', f(d.o[i])), pair('H', f(d.h[i])), pair('L', f(d.l[i])), pair('C', f(d.c[i])));
      if (i > 0) {
        const chg = (d.c[i] / d.c[i - 1] - 1) * 100;
        const cls = Math.abs(chg) < 0.005 ? 'flat' : chg > 0 ? 'up' : 'down';
        row1.append(el('span', 'delta ' + cls, (cls === 'up' ? '▲ ' : cls === 'down' ? '▼ ' : '') + Math.abs(chg).toFixed(2) + '%'));
      }
      const row2 = el('div', 'row');
      const keyed = (cls, label, v) => { const s = el('span'); s.append(el('i', 'key ' + cls), label + ' ', el('b', null, f(v))); return s; };
      if (this.show.s50) row2.append(keyed('s50', '50-day', this.s50v[i]));
      if (this.show.s200) row2.append(keyed('s200', '200-day', this.s200v[i]));
      if (this.show.vol) row2.append(pair('Vol', compact(d.v[i])));
      box.replaceChildren(row1, row2);
    }

    retheme() {
      const data = this.data, info = this.info;
      this.chart.remove();
      this.vol = null;
      this._build();
      if (data) this.setData(data, info);
    }
  }

  /* ------------------------------------------------------------ breadth chart */

  class BreadthChart {
    constructor(host, readout) {
      this.host = host;
      this.readout = readout;
      this.args = null;
      this._build();
    }

    _build() {
      const p = (this.p = palette());
      const opts = baseOptions(p);
      opts.handleScroll = { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false };
      opts.handleScale = { mouseWheel: false, pinch: true, axisPressedMouseMove: false, axisDoubleClickReset: true };
      opts.rightPriceScale = { borderColor: p.rule, scaleMargins: { top: 0.06, bottom: 0.04 } };
      opts.timeScale = Object.assign({}, opts.timeScale, { rightOffset: 1, fixRightEdge: true });
      opts.crosshair.horzLine = { visible: false, labelVisible: false };
      this.chart = L.createChart(this.host, opts);
      const pct = { type: 'custom', minMove: 0.1, formatter: (v) => Math.round(v) + '%' };
      const fixed = () => ({ priceRange: { minValue: 0, maxValue: 100 } });
      const line = (color) => ({
        color, lineWidth: 2, priceFormat: pct, autoscaleInfoProvider: fixed,
        priceLineVisible: false, lastValueVisible: true,
        crosshairMarkerRadius: 4, crosshairMarkerBorderColor: p.surface, crosshairMarkerBorderWidth: 2,
      });
      this.a50 = this.chart.addSeries(L.LineSeries, line(p.s50));
      this.a200 = this.chart.addSeries(L.LineSeries, line(p.s200));
      this.a200.createPriceLine({ price: 50, color: p.ink3, lineWidth: 1, lineStyle: L.LineStyle.Solid, axisLabelVisible: false });
      this.chart.subscribeCrosshairMove((param) => this._read(param));
    }

    setData(dates, a200, a50, n) {
      this.args = [dates, a200, a50, n];
      this.dates = dates;
      this.index = new Map(dates.map((t, i) => [t, i]));
      this.v200 = a200; this.v50 = a50; this.n = n;
      this.a200.setData(lineData(dates, a200));
      this.a50.setData(lineData(dates, a50));
      const from = dates[Math.max(0, dates.length - 250)];
      this.chart.timeScale().setVisibleRange({ from, to: dates[dates.length - 1] });
      this._read(null);
    }

    _read(param) {
      if (!this.dates) return;
      let i = param && param.time != null ? this.index.get(param.time) : undefined;
      if (i == null) i = this.dates.length - 1;
      const fmt = (v) => v == null ? '—' : Math.round(v) + '%';
      const out = [el('span', null, dayLabel(this.dates[i]) + ' · ')];
      out.push(el('b', null, fmt(this.v200[i])), ' above the 200-day · ', el('b', null, fmt(this.v50[i])), ` above the 50-day · ${this.n[i]} stocks`);
      this.readout.replaceChildren(...out);
    }

    retheme() {
      this.chart.remove();
      this._build();
      if (this.args) this.setData(...this.args);
    }
  }

  window.Charts = { PriceChart, BreadthChart, sma };
})();
