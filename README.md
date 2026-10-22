# Above the Line: EGX 200-day screener

A local website that shows every Egyptian Exchange stock as a card with a 6-month sparkline. It measures each stock against its 200-day and 50-day simple moving averages. Click a card for a full candlestick chart with both averages, volume, and golden/death-cross markers.

## Run it

```
python server.py        (or double-click start.bat)
```

The server opens http://127.0.0.1:8200. On the very first start it downloads about 5 years of daily candles for every stock, which takes about a minute. After that, press **Refresh data** on the page whenever you want new prices. You can also rebuild from the command line with `python egx_data.py`.

You only need Python 3.9+. There's nothing to pip-install and no API keys.

## Live site on GitHub Pages

`.github/workflows/pages.yml` publishes `web/` to GitHub Pages at `https://<user>.github.io/<repo>/`. It runs:

- Every hour of the trading day: 10:05, 11:05 … 15:05 Cairo time, Sunday to Thursday, and never on Friday or Saturday. GitHub's cron only understands UTC, and Egypt switches between UTC+3 and UTC+2, so the cron fires 07:05–13:05 UTC and a small `gate` job skips any run that falls outside 10:00–15:59 in Cairo. Nothing needs changing when the clocks change. GitHub sometimes starts scheduled runs late, by up to about 15 minutes.
- On every push to `main`.
- On demand, from **Actions → Build data and publish → Run workflow**.

An open page checks `data/version.json` every 5 minutes, and whenever you return to the tab. If the data is newer, it reloads it in place.

Each run downloads fresh data with `egx_data.py` and deploys it. The generated data is never committed. GitHub's cache carries the previous run's candles forward, so a symbol that fails to download keeps its last data.

One-time setup: in the repo, go to **Settings → Pages → Build and deployment** and set **Source** to **GitHub Actions**.

On the hosted site the Refresh button is hidden, because there's no local server to rebuild the data; the scheduled run does it instead. GitHub pauses scheduled workflows in a repository with no activity for 60 days. If that happens, click **Enable workflow** on the Actions tab.

## What's on the page

- **Breadth:** the share of stocks above their 200-day and 50-day averages today, with a 2-year history chart. It follows the index filter. Click any figure, such as "Golden crosses, last 30 sessions", to filter the list to those stocks.
- **Index tiles:** EGX 30, EGX 70 EWI and EGX 100 EWI, each with its own full chart.
- **Filters:**
  - Index: All, EGX30, EGX70, EGX100, Outside EGX100.
  - Trend: above 200d, above 50d, above both, below 200d.
  - Signals: fresh break above or below the 200-day, golden or death cross, uptrend stack, pullback to a rising 200-day, near the 52-week high, stretched.
  - Sector, minimum liquidity, search, and sort by 12 measures.
  - Filters are saved in the URL, so any view can be bookmarked.
- **Cards and table views**, a ★ watchlist saved in your browser, and **Export CSV** of the current list.
- **Full chart:**
  - Candles, 50-day and 200-day lines, and a volume pane.
  - Golden/death-cross markers, plus optional markers for every price cross of the 200-day.
  - Log scale, and ranges from 3 months to 5 years.
  - A crosshair readout and a key-figures panel.
  - Keyboard: ← → moves to the previous/next stock, Esc closes.
- Day and night editions.

## Data: all free, no paid API

| What | Source | Notes |
|---|---|---|
| Stock list, names, sectors, market cap | TradingView public screener (`scanner.tradingview.com`) | That scan misses a few live stocks (EHDR, for one), so index members are also requested by name. |
| Daily candles, 1,300 bars | TradingView chart websocket (`data.tradingview.com`) | `tvfeed.py` holds a minimal standard-library websocket client. About 300 symbols download in ~45 s. |
| 50/200-day averages, signals, breadth | Computed locally from the candles | Matches TradingView's own SMA200 values to within rounding. |
| EGX30 / EGX70 EWI membership | `index_membership.json` (static) | From the EGX review effective 1 Sep 2026, read from Investing.com's component pages. EGX100 EWI = EGX30 + EGX70. |

Both TradingView endpoints are unofficial and delayed about 15 minutes. That's fine for a personal end-of-day screen, but not for redistribution or a product. Yahoo Finance was tested and rejected: it lacks some EGX stocks (e.g. SUCE), has only one bar for the EGX30 index, and its closes didn't match the exchange's.

**Keeping index membership current:** EGX rebalances its indices twice a year, with changes taking effect around 1 March and 1 September. After each review, edit the two lists in `index_membership.json`. Each refresh also compares your EGX30 list with TradingView's and shows a note at the bottom of the page if they differ.

## Files

```
server.py              local web server + refresh endpoint (127.0.0.1 only)
egx_data.py            builds web/data/: universe, candles, averages, signals, breadth
tvfeed.py              TradingView screener + websocket client (stdlib only)
index_membership.json  static EGX30 / EGX70 lists
web/                   the site: index.html, style.css, app.js, charts.js
web/vendor/            TradingView Lightweight Charts 5.2.1 (Apache 2.0)
web/data/              generated; safe to delete (rebuilt on next start), not committed
.github/workflows/     scheduled build + GitHub Pages deploy
```

Nothing here is investment advice.
