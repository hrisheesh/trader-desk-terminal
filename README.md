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
curl http://localhost:8000/health
curl http://localhost:8000/api/quotes
curl "http://localhost:8000/api/candles/BTC-USD?interval=30s"
curl "http://localhost:8000/api/candles/BTC-USD?interval=1m"
curl "http://localhost:8000/api/candles/NVDA?interval=1m"
curl http://localhost:8000/api/orderbook/BTC-USD
curl http://localhost:8000/api/tape/BTC-USD
```
