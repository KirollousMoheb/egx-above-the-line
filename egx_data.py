"""Build the website's data: EGX universe, daily candles, moving averages, signals, breadth.

Run directly (python egx_data.py) or through the Refresh button on the site (server.py).
Writes web/data/market.json and one web/data/candles/<id>.json per stock and index.
"""
import datetime as dt
import json
import os
import re
import sys
import time

import tvfeed

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ROOT, "web", "data")
CANDLE_DIR = os.path.join(DATA_DIR, "candles")
MARKET_FILE = os.path.join(DATA_DIR, "market.json")
MEMBERSHIP_FILE = os.path.join(ROOT, "index_membership.json")

BARS = 1300           # ~5 years of EGX sessions per symbol
SPARK = 126           # ~6 months of closes on each card
BREADTH_DAYS = 520    # ~2 years of breadth history
ACTIVE_DAYS = 30      # no trade for this many calendar days -> treated as inactive

INDEXES = [  # (key, TradingView symbol, display name)
    ("EGX30", "EGX:EGX30", "EGX 30"),
    ("EGX70", "EGX:EGX70EWI", "EGX 70 EWI"),
    ("EGX100", "EGX:EGX100EWI", "EGX 100 EWI"),
]
# TradingView lists a few EGX stocks under their ISIN; show the EGX code instead.
TICKER_ALIASES = {
    "EGS3E071C013-EGP": "ACRO", "EGS370O1C013": "NAPR", "EGS72L31C011": "SLAR",
    "EGS3I0S1C019": "FCMD", "EGS48271C018-EGP": "ESAC", "EGS30AJ1C016-EGP": "DIFC",
}
SCAN_COLUMNS = ["name", "description", "sector", "industry", "market_cap_basic", "indexes", "type"]


# ---------------------------------------------------------------- indicators

def sma(values, n):
    out, total = [None] * len(values), 0.0
    for i, v in enumerate(values):
        total += v
        if i >= n:
            total -= values[i - n]
        if i >= n - 1:
            out[i] = total / n
    return out


def rsi(closes, n=14):
    if len(closes) <= n:
        return None
    gain = sum(max(closes[i] - closes[i - 1], 0) for i in range(1, n + 1)) / n
    loss = sum(max(closes[i - 1] - closes[i], 0) for i in range(1, n + 1)) / n
    for i in range(n + 1, len(closes)):
        d = closes[i] - closes[i - 1]
        gain = (gain * (n - 1) + max(d, 0)) / n
        loss = (loss * (n - 1) + max(-d, 0)) / n
    return 100.0 if loss == 0 else 100 - 100 / (1 + gain / loss)


def last_cross(dates, fast, slow):
    """Most recent crossing of fast over/under slow: golden (up) or death (down)."""
    for i in range(len(fast) - 1, 0, -1):
        a, b, pa, pb = fast[i], slow[i], fast[i - 1], slow[i - 1]
        if a is None or b is None or pa is None or pb is None:
            break
        if (a > b) != (pa > pb):
            return {"type": "golden" if a > b else "death", "date": dates[i], "ago": len(fast) - 1 - i}
    return None


def _price(x):
    if x is None:
        return None
    return round(x, 3 if abs(x) < 10 else 2)


def _pct(a, b):
    if a is None or not b:
        return None
    return round((a / b - 1) * 100, 2)


def stats(d, h, l, c, v):
    """Everything the cards, filters and fact box need, from one symbol's bars."""
    n = len(c)
    s50, s200 = sma(c, 50), sma(c, 200)
    streak = 0
    if s200[-1] is not None:
        above = c[-1] > s200[-1]
        for i in range(n - 1, -1, -1):
            if s200[i] is None or (c[i] > s200[i]) != above:
                break
            streak += 1
        streak = streak if above else -streak

    def perf(k):
        return _pct(c[-1], c[-1 - k]) if n > k else None

    year = d[-1][:4]
    prev_year_close = next((c[i] for i in range(n - 1, -1, -1) if d[i][:4] < year), None)
    hi52, lo52 = max(h[-250:]), min(l[-250:])
    tail = range(max(0, n - 20), n)
    r = rsi(c)
    return {
        "last": d[-1],
        "close": _price(c[-1]),
        "chg": _pct(c[-1], c[-2]) if n > 1 else None,
        "sma50": _price(s50[-1]),
        "sma200": _price(s200[-1]),
        "d50": _pct(c[-1], s50[-1]),
        "d200": _pct(c[-1], s200[-1]),
        # exact comparisons: the rounded distances can read 0.00 for a close a hair above its average
        "a50": None if s50[-1] is None else c[-1] > s50[-1],
        "a200": None if s200[-1] is None else c[-1] > s200[-1],
        "slope200": _pct(s200[-1], s200[-21]) if n >= 220 else None,
        "streak": streak,
        "since": d[n - abs(streak)] if streak else None,
        "cross": last_cross(d, s50, s200),
        "hi52": _price(hi52),
        "lo52": _price(lo52),
        "fromHi": _pct(c[-1], hi52),
        "rsi": round(r, 1) if r is not None else None,
        "perf": {"1W": perf(5), "1M": perf(21), "3M": perf(63), "6M": perf(126),
                 "YTD": _pct(c[-1], prev_year_close), "1Y": perf(250)},
        "val20": round(sum(c[i] * v[i] for i in tail) / len(tail)),
        "vol": v[-1],
        "bars": n,
        "spark": {"c": [_price(x) for x in c[-SPARK:]],
                  "s50": [_price(x) for x in s50[-SPARK:]],
                  "s200": [_price(x) for x in s200[-SPARK:]]},
    }


# ---------------------------------------------------------------- data shaping

def _date(ts):
    # Daily bars are stamped at the session open in UTC; +3h keeps the Cairo calendar date.
    return time.strftime("%Y-%m-%d", time.gmtime(ts + 3 * 3600))


def columns(bars):
    by_date = {}
    for b in bars:
        if len(b) < 5 or b[4] is None:
            continue
        close = b[4]
        by_date[_date(b[0])] = (b[1] if b[1] is not None else close,
                                b[2] if b[2] is not None else close,
                                b[3] if b[3] is not None else close,
                                close,
                                (b[5] if len(b) > 5 and b[5] is not None else 0))
    d = sorted(by_date)
    o, h, l, c, v = (list(x) for x in zip(*(by_date[k] for k in d))) if d else ([], [], [], [], [])
    return {"d": d, "o": o, "h": h, "l": l, "c": c, "v": v}


def _file_id(name):
    return re.sub(r"[^A-Za-z0-9_-]", "_", name)


def _write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, separators=(",", ":"), ensure_ascii=False)
    for attempt in range(5):  # Windows refuses to replace a file another process is reading
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            time.sleep(0.2 * (attempt + 1))
    os.replace(tmp, path)


def _read_candles(fid):
    try:
        with open(os.path.join(CANDLE_DIR, fid + ".json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def breadth(calendar, series, groups):
    """Share of stocks above their 200/50-day average on each market day.

    A stock counts on a day if it traded within ACTIVE_DAYS before it; on days it
    didn't trade, its last state carries forward (the same rule the list uses).
    """
    cal = [dt.date.fromisoformat(x).toordinal() for x in calendar]
    rows = {}
    for sid, (dates, a200, a50) in series.items():
        ords = [dt.date.fromisoformat(x).toordinal() for x in dates]
        r200, r50, k = [], [], 0
        for day in cal:
            while k < len(ords) and ords[k] <= day:
                k += 1
            j = k - 1
            if j < 0 or day - ords[j] > ACTIVE_DAYS:
                r200.append(None)
                r50.append(None)
            else:
                r200.append(a200[j])
                r50.append(a50[j])
        rows[sid] = (r200, r50)

    out = {"dates": calendar, "groups": {}}
    for g, members in groups.items():
        n, p200, p50 = [], [], []
        for i in range(len(cal)):
            s200 = [rows[s][0][i] for s in members if s in rows and rows[s][0][i] is not None]
            s50 = [rows[s][1][i] for s in members if s in rows and rows[s][1][i] is not None]
            n.append(len(s200))
            p200.append(round(100 * sum(s200) / len(s200), 1) if s200 else None)
            p50.append(round(100 * sum(s50) / len(s50), 1) if s50 else None)
        out["groups"][g] = {"n": n, "a200": p200, "a50": p50}
    return out


# ---------------------------------------------------------------- build

def load_membership():
    with open(MEMBERSHIP_FILE, encoding="utf-8") as f:
        m = json.load(f)
    return m, set(m["EGX30"]), set(m["EGX70"])


def build(progress=None):
    progress = progress or (lambda phase, done=0, total=0: None)
    t0 = time.time()
    membership, egx30, egx70 = load_membership()
    warnings = []

    progress("Listing EGX stocks")
    rows = tvfeed.scan(SCAN_COLUMNS)
    listed = {r["name"] for r in rows}
    # The market-wide scan silently omits a few live stocks (EHDR, for one); ask for index members by name.
    missing = [f"EGX:{t}" for t in sorted((egx30 | egx70) - listed)]
    if missing:
        rows += tvfeed.scan(SCAN_COLUMNS, missing)
    rows = [r for r in rows if r.get("type") in (None, "stock")]
    found = {r["name"] for r in rows}
    if (egx30 | egx70) - found:
        warnings.append("Index members not found on TradingView: " + ", ".join(sorted((egx30 | egx70) - found)))
    tv30 = {r["name"] for r in rows if any(ix.get("proname") == "EGX:EGX30" for ix in (r.get("indexes") or []))}
    if tv30 and tv30 != egx30:
        warnings.append("TradingView's EGX30 differs from index_membership.json "
                        f"(TradingView adds {sorted(tv30 - egx30)}, lacks {sorted(egx30 - tv30)}). "
                        "A review may have taken effect; update the file.")

    symbols = [r["symbol"] for r in rows] + [sym for _, sym, _ in INDEXES]
    progress("Downloading candles", 0, len(symbols))
    history, errors = tvfeed.fetch_history(
        symbols, BARS, on_progress=lambda done, total: progress("Downloading candles", done, total))

    progress("Computing averages and signals")
    os.makedirs(CANDLE_DIR, exist_ok=True)

    def load(sym, fid):
        """Fresh bars when the download worked, else the previous run's file."""
        if history.get(sym):
            cols = columns(history[sym])
            _write_json(os.path.join(CANDLE_DIR, fid + ".json"), {"id": fid, "sym": sym, **cols})
            return cols, False
        old = _read_candles(fid)
        return (old, True) if old and old.get("c") else (None, False)

    indices = []
    for key, sym, label in INDEXES:
        cols, stale = load(sym, key)
        if cols and len(cols["c"]) > 1:
            indices.append({"id": key, "t": key, "sym": sym, "name": label, "stale": stale,
                            **stats(cols["d"], cols["h"], cols["l"], cols["c"], cols["v"])})

    stocks, series = [], {}
    for r in sorted(rows, key=lambda r: r["name"]):
        name, sym = r["name"], r["symbol"]
        fid = _file_id(name)
        cols, stale = load(sym, fid)
        if not cols or len(cols["c"]) < 2:
            continue
        idx = [k for k, members in (("EGX30", egx30), ("EGX70", egx70)) if name in members]
        if idx:
            idx.append("EGX100")
        s = {"id": fid, "t": TICKER_ALIASES.get(name, name), "sym": sym,
             "name": r.get("description") or name, "sector": r.get("sector"),
             "industry": r.get("industry"), "mcap": r.get("market_cap_basic"),
             "idx": idx, "stale": stale,
             **stats(cols["d"], cols["h"], cols["l"], cols["c"], cols["v"])}
        stocks.append(s)
        s200, s50 = sma(cols["c"], 200), sma(cols["c"], 50)
        series[fid] = (cols["d"],
                       [None if m is None else c > m for c, m in zip(cols["c"], s200)],
                       [None if m is None else c > m for c, m in zip(cols["c"], s50)])

    egx30_bars = next((i for i in indices if i["id"] == "EGX30"), None)
    calendar_src = _read_candles("EGX30") if egx30_bars else None
    as_of = egx30_bars["last"] if egx30_bars else max(s["last"] for s in stocks)
    cutoff = (dt.date.fromisoformat(as_of) - dt.timedelta(days=ACTIVE_DAYS)).isoformat()
    inactive = [s["t"] for s in stocks if s["last"] < cutoff]
    stocks = [s for s in stocks if s["last"] >= cutoff]
    active_ids = {s["id"] for s in stocks}
    series = {k: v for k, v in series.items() if k in active_ids}

    progress("Measuring market breadth")
    calendar = (calendar_src["d"] if calendar_src else sorted({d for v in series.values() for d in v[0]}))[-BREADTH_DAYS:]
    in30 = {s["id"] for s in stocks if "EGX30" in s["idx"]}
    in70 = {s["id"] for s in stocks if "EGX70" in s["idx"]}
    groups = {"ALL": active_ids, "EGX30": in30, "EGX70": in70, "EGX100": in30 | in70,
              "OTHER": active_ids - in30 - in70}

    market = {
        "meta": {
            "asOf": as_of,
            "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "seconds": round(time.time() - t0, 1),
            "stocks": len(stocks),
            "inactive": inactive,
            "errors": {k: v for k, v in errors.items()},
            "warnings": warnings,
            "membership": {"asOf": membership["as_of"], "source": membership["source"]},
        },
        "indices": indices,
        "stocks": stocks,
        "breadth": breadth(calendar, series, groups),
    }
    _write_json(MARKET_FILE, market)
    # Tiny file an open page polls to learn that market.json changed, without re-downloading it.
    _write_json(os.path.join(DATA_DIR, "version.json"), {"generated": market["meta"]["generated"]})
    progress("Done")
    return market


def main():
    def progress(phase, done=0, total=0):
        line = f"{phase} {done}/{total}" if total else phase
        sys.stdout.write("\r" + line.ljust(60))
        sys.stdout.flush()

    m = build(progress)
    meta, stocks = m["meta"], m["stocks"]
    ranked = [s for s in stocks if s["a200"] is not None]
    above200 = sum(s["a200"] for s in ranked)
    above50 = sum(bool(s["a50"]) for s in ranked)
    print(f"\nAs of {meta['asOf']}: {above200} of {len(ranked)} stocks above SMA200, "
          f"{above50} above SMA50. Built in {meta['seconds']}s.")
    for w in meta["warnings"]:
        print("warning:", w)
    if meta["errors"]:
        print("download errors:", ", ".join(sorted(meta["errors"])))


if __name__ == "__main__":
    main()
