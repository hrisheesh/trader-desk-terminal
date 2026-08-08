# Trader Desk

Concept: **Live Command Floor**. The desk is a dense Bloomberg-style floor with an asymmetric watch rail, central live focus chart, crypto book/tape, signal stack, market pulse, alerts, and a status tape. It is designed to fit in one viewport without page scrolling.

## Data Truth

- `BTC-USD` and `ETH-USD` use real Coinbase Exchange REST data plus a backend-proxied Coinbase WebSocket ticker. The active crypto candle updates tick by tick.
- `30s` crypto candles are live-only from real Coinbase WebSocket ticks after page load. Coinbase REST does not publish 30s historical candles, so the historical seed remains native 1m and is labeled in the chart caption.
- `NVDA`, `AAPL`, `TSLA`, `MSFT`, `SOXL`, and `SPY` use real Yahoo Finance chart data. Public Yahoo equity data is delayed/last-sale and may not move while the equity market is closed.
- The frontend never calls Yahoo or Coinbase directly.
- True no-delay live equities require a licensed realtime equities feed/API key. This app does not fake ticks, randomize prices, or synthesize chart movement.
- Signals are computed from real candles/ticks: EMA(9/21), RSI(14), VWAP, realized volatility, and directional nowcast. They are indicators, not guaranteed predictions.

## APIs

- `GET /health`
- `GET /api/symbols`
- `GET /api/quotes`
- `GET /api/desk`
- `GET /api/quotes/{symbol}`
- `GET /api/candles/{symbol}?interval=30s|1m|2m|5m|15m|1h`
- `GET /api/signals/{symbol}`
- `GET /api/orderbook/{symbol}`
- `GET /api/tape/{symbol}`
- `WS /api/stream/{symbol}` backend-proxied live Coinbase crypto ticks

## Run

```bash
# terminal 1 — backend
cd trader-desk/backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000

# terminal 2 — frontend
cd trader-desk/frontend
npm install && npm run dev

# static alternative:
# python3 -m http.server 8080
```

Open `http://localhost:8080`. You can also open `http://localhost:8000` because FastAPI serves the static frontend fallback.

## Verification

```bash
cd trader-desk/frontend
npm test

curl http://localhost:8000/health
curl http://localhost:8000/api/quotes
curl "http://localhost:8000/api/candles/BTC-USD?interval=30s"
curl "http://localhost:8000/api/candles/BTC-USD?interval=1m"
curl "http://localhost:8000/api/candles/NVDA?interval=1m"
curl http://localhost:8000/api/orderbook/BTC-USD
curl http://localhost:8000/api/tape/BTC-USD
```

Bot runs manage exits continuously while the run is active. Warm-up is a real
evidence-building phase: it records observations but blocks new entries. After
warm-up, entries are allowed throughout the active window, while an early exit
phase releases open risk before the deadline so the final close is only a
backstop. Any position still open at the deadline receives a final cash-safety
close so a stopped run cannot leave paper capital stranded. The headless live
report runner defaults to a 5-minute validation run:

Open positions stay pinned in each bot's swarm panel with live verdict, P&L,
age, stop, free-hand momentum status, and feed-staleness status. Stale quotes
block new entries but do not disable risk monitoring for an existing position.
The optional Multiplier toggle is paper-only free-hand momentum mode: swarm
conviction decides how much current cash to allocate, with no fixed profit
target. Exits respond to live momentum, adaptive trailing, learned momentum
buckets, and the normal stop, time, stale-feed, and deadline safety controls.

The Bot mode selector also includes Polymarket BTC paper mode for the live 5m
and 15m Up/Down markets. It discovers markets through Gamma, streams the
selected outcome books through the Polymarket CLOB WebSocket, and uses
`/prices` and `/midpoints` as a cold-start/backstop (rather than trusting the
occasionally unusable first level of `/books`). Its price, chart, and PTB are
kept on the matching Chainlink TWAP source for each BTC window, while contract
prices remain live through the CLOB. Calm, Normal, and Aggressive retain
separate capital, decisions, and learning. It is paper-only; no Polymarket
credentials or real orders are used.

The desk uses Polymarket's free RTDS relay for the exact Chainlink TWAP source:
BTC 5-minute markets use the 30-second topic and BTC 15-minute markets use the
60-second topic. It sends the required five-second heartbeat, keeps the two
feeds separate, and does not substitute Binance, Coinbase, or the generic
Chainlink spot topic. The chart and current price therefore follow the same
public source Polymarket documents for each contract.

The RTDS TWAP stream has no replay. The backend persists its own recent exact
history and captures the opening tick for the next window. It also asks
Polymarket's public crypto-price endpoint for the immutable Price to Beat when
available, which lets a backend started mid-window recover the official opening
value without a paid Chainlink account. If neither source has the opening
report, the bot remains monitoring-only rather than inventing a PTB.

```bash
cd trader-desk/frontend
node run_live_bots.cjs
```
