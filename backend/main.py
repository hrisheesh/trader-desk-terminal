from __future__ import annotations

import asyncio
import json
import math
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import httpx
import websockets
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

SYMBOLS = ["NVDA", "AAPL", "TSLA", "MSFT", "BTC-USD", "ETH-USD", "SOXL", "SPY"]
CRYPTO_SYMBOLS = {"BTC-USD", "ETH-USD"}

YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
COINBASE_BOOK_URL = "https://api.exchange.coinbase.com/products/{symbol}/book"
COINBASE_TRADES_URL = "https://api.exchange.coinbase.com/products/{symbol}/trades"
COINBASE_TICKER_URL = "https://api.exchange.coinbase.com/products/{symbol}/ticker"
COINBASE_STATS_URL = "https://api.exchange.coinbase.com/products/{symbol}/stats"
COINBASE_CANDLES_URL = "https://api.exchange.coinbase.com/products/{symbol}/candles"
COINBASE_WS_URL = "wss://ws-feed.exchange.coinbase.com"

HTTP_TIMEOUT = 10.0
EQUITY_CACHE_TTL_SECONDS = 15
CRYPTO_CACHE_TTL_SECONDS = 0.75
SUPPORTED_INTERVALS = {"1m": 60, "2m": 120, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600}
YAHOO_INTERVALS = {"1m", "2m", "5m", "15m", "30m", "1h"}
COINBASE_GRANULARITIES = {60, 300, 900, 3600}
UPSTREAM_HEADERS = {
    "User-Agent": "Mozilla/5.0",
    "Accept": "application/json,text/plain,*/*",
}

app = FastAPI(title="Trader Desk API", version="1.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$",
    allow_credentials=False,
    allow_methods=["GET"],
    allow_headers=["*"],
)

_quote_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_equity_fetch_lock = asyncio.Lock()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _round(value: float | None, digits: int = 4) -> float | None:
    if value is None or math.isnan(value):
        return None
    return round(value, digits)


def _validate_symbol(symbol: str) -> str:
    normalized = symbol.upper().strip()
    aliases = {"BTC": "BTC-USD", "ETH": "ETH-USD"}
    normalized = aliases.get(normalized, normalized)
    return normalized


async def _fetch_json(
    client: httpx.AsyncClient, url: str, params: dict[str, Any] | None = None
) -> Any:
    response = await client.get(url, params=params, headers=UPSTREAM_HEADERS)
    response.raise_for_status()
    return response.json()


def _fetch_yahoo_json_sync(url: str, params: dict[str, str]) -> Any:
    full_url = f"{url}?{urlencode(params)}"
    request = Request(full_url, headers=UPSTREAM_HEADERS)
    try:
        with urlopen(request, timeout=HTTP_TIMEOUT) as response:
            return json.loads(response.read().decode("utf-8"))
    except Exception:
        result = subprocess.run(
            [
                "curl",
                "-L",
                "-sS",
                "--max-time",
                str(int(HTTP_TIMEOUT)),
                "-A",
                UPSTREAM_HEADERS["User-Agent"],
                full_url,
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        return json.loads(result.stdout)


async def _fetch_yahoo_json(url: str, params: dict[str, str]) -> Any:
    return await asyncio.to_thread(_fetch_yahoo_json_sync, url, params)


def _parse_yahoo_chart(symbol: str, payload: dict[str, Any]) -> dict[str, Any]:
    chart = payload.get("chart", {})
    error = chart.get("error")
    if error:
        raise ValueError(error.get("description") or error.get("code") or "Yahoo chart error")

    result = (chart.get("result") or [None])[0]
    if not result:
        raise ValueError("Yahoo chart response did not include result data")

    meta = result.get("meta", {})
    timestamps = result.get("timestamp") or []
    quote_block = ((result.get("indicators") or {}).get("quote") or [{}])[0]

    candles: list[dict[str, Any]] = []
    close_values = quote_block.get("close") or []
    open_values = quote_block.get("open") or []
    high_values = quote_block.get("high") or []
    low_values = quote_block.get("low") or []
    volume_values = quote_block.get("volume") or []

    for index, timestamp in enumerate(timestamps):
        close = close_values[index] if index < len(close_values) else None
        open_price = open_values[index] if index < len(open_values) else None
        high = high_values[index] if index < len(high_values) else None
        low = low_values[index] if index < len(low_values) else None
        if close is None or open_price is None or high is None or low is None:
            continue
        candles.append(
            {
                "time": datetime.fromtimestamp(timestamp, timezone.utc).isoformat(),
                "open": _round(float(open_price), 4),
                "high": _round(float(high), 4),
                "low": _round(float(low), 4),
                "close": _round(float(close), 4),
                "volume": int(volume_values[index] or 0) if index < len(volume_values) else 0,
            }
        )

    price = meta.get("regularMarketPrice")
    previous_close = meta.get("chartPreviousClose") or meta.get("previousClose")
    change = float(price) - float(previous_close) if price is not None and previous_close else None
    change_percent = (change / float(previous_close)) * 100 if change is not None else None
    regular_market_time = None
    if meta.get("regularMarketTime"):
        regular_market_time = datetime.fromtimestamp(
            int(meta["regularMarketTime"]), timezone.utc
        ).isoformat()

    return {
        "symbol": symbol,
        "name": meta.get("shortName") or meta.get("longName") or symbol,
        "assetClass": "equity",
        "price": _round(float(price), 4) if price is not None else None,
        "bid": None,
        "ask": None,
        "change": _round(change, 4),
        "changePercent": _round(change_percent, 2),
        "previousClose": _round(float(previous_close), 4) if previous_close is not None else None,
        "dayHigh": _round(float(meta["regularMarketDayHigh"]), 4)
        if meta.get("regularMarketDayHigh") is not None
        else None,
        "dayLow": _round(float(meta["regularMarketDayLow"]), 4)
        if meta.get("regularMarketDayLow") is not None
        else None,
        "volume": int(meta.get("regularMarketVolume") or 0),
        "currency": meta.get("currency") or "USD",
        "exchange": meta.get("fullExchangeName") or meta.get("exchangeName"),
        "marketState": meta.get("marketState") or "REGULAR_MARKET_LAST_SALE",
        "regularMarketTime": regular_market_time,
        "lastTradeTime": regular_market_time,
        "candles": candles[-120:],
        "source": "Yahoo Finance Chart API",
        "feed": "real delayed equity last-sale",
        "isRealtime": False,
        "latencyMs": None,
        "fetchedAt": _now_iso(),
    }


def _parse_coinbase_candles(rows: list[list[float]]) -> list[dict[str, Any]]:
    candles = []
    for timestamp, low, high, open_price, close, volume in rows:
        candles.append(
            {
                "time": datetime.fromtimestamp(timestamp, timezone.utc).isoformat(),
                "open": _round(float(open_price), 4),
                "high": _round(float(high), 4),
                "low": _round(float(low), 4),
                "close": _round(float(close), 4),
                "volume": _round(float(volume), 6),
            }
        )
    return sorted(candles, key=lambda candle: candle["time"])[-120:]


def _interval_seconds(interval: str) -> int:
    if interval not in SUPPORTED_INTERVALS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported interval. Use one of: {', '.join(SUPPORTED_INTERVALS)}",
        )
    return SUPPORTED_INTERVALS[interval]


def _aggregate_candles(candles: list[dict[str, Any]], interval_seconds: int) -> list[dict[str, Any]]:
    buckets: dict[int, dict[str, Any]] = {}
    for candle in candles:
        timestamp = datetime.fromisoformat(candle["time"]).timestamp()
        bucket_start = int(timestamp // interval_seconds) * interval_seconds
        bucket = buckets.get(bucket_start)
        if bucket is None:
            buckets[bucket_start] = {
                "time": datetime.fromtimestamp(bucket_start, timezone.utc).isoformat(),
                "open": candle["open"],
                "high": candle["high"],
                "low": candle["low"],
                "close": candle["close"],
                "volume": candle.get("volume") or 0,
            }
            continue
        bucket["high"] = _round(max(float(bucket["high"]), float(candle["high"])), 4)
        bucket["low"] = _round(min(float(bucket["low"]), float(candle["low"])), 4)
        bucket["close"] = candle["close"]
        bucket["volume"] = _round(float(bucket.get("volume") or 0) + float(candle.get("volume") or 0), 6)
    return [buckets[key] for key in sorted(buckets)][-120:]


async def _candles_for_symbol(symbol: str, interval: str) -> dict[str, Any]:
    interval_seconds = _interval_seconds(interval)
    started = time.perf_counter()

    if symbol in CRYPTO_SYMBOLS:
        granularity = interval_seconds if interval_seconds in COINBASE_GRANULARITIES else 60
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
            try:
                payload = await _fetch_json(
                    client,
                    COINBASE_CANDLES_URL.format(symbol=symbol),
                    {"granularity": granularity},
                )
            except httpx.HTTPError as exc:
                raise HTTPException(status_code=502, detail=f"Coinbase candles failed: {exc}") from exc
        candles = _parse_coinbase_candles(payload)
        if granularity != interval_seconds:
            candles = _aggregate_candles(candles, interval_seconds)
        feed_note = "real-time crypto OHLC; active candle updates from Coinbase WebSocket"
        return {
            "symbol": symbol,
            "interval": interval,
            "intervalSeconds": interval_seconds,
            "nativeIntervalSeconds": granularity,
            "candles": candles,
            "source": "Coinbase Exchange Product Candles",
            "feed": feed_note,
            "isRealtime": True,
            "latencyMs": round((time.perf_counter() - started) * 1000),
            "fetchedAt": _now_iso(),
        }

    if interval not in YAHOO_INTERVALS:
        raise HTTPException(status_code=400, detail="Yahoo equity feed does not support this interval")
    try:
        payload = await _fetch_yahoo_json(
            YAHOO_CHART_URL.format(symbol=symbol),
            {"range": "1d", "interval": interval, "includePrePost": "false"},
        )
        parsed = _parse_yahoo_chart(symbol, payload)
    except (ValueError, OSError, subprocess.SubprocessError) as exc:
        raise HTTPException(status_code=502, detail=f"Yahoo candles failed: {exc}") from exc
    return {
        "symbol": symbol,
        "interval": interval,
        "intervalSeconds": interval_seconds,
        "candles": parsed.get("candles", []),
        "source": "Yahoo Finance Chart API",
        "feed": "real delayed equity OHLC bars",
        "isRealtime": False,
        "latencyMs": round((time.perf_counter() - started) * 1000),
        "fetchedAt": _now_iso(),
    }


async def _coinbase_quote(symbol: str, client: httpx.AsyncClient) -> dict[str, Any]:
    started = time.perf_counter()
    ticker, stats, candles_payload = await asyncio.gather(
        _fetch_json(client, COINBASE_TICKER_URL.format(symbol=symbol)),
        _fetch_json(client, COINBASE_STATS_URL.format(symbol=symbol)),
        _fetch_json(client, COINBASE_CANDLES_URL.format(symbol=symbol), {"granularity": 60}),
    )
    latency_ms = round((time.perf_counter() - started) * 1000)
    price = float(ticker["price"])
    open_24h = float(stats["open"])
    change = price - open_24h
    change_percent = (change / open_24h) * 100 if open_24h else None

    return {
        "symbol": symbol,
        "name": "Bitcoin" if symbol == "BTC-USD" else "Ethereum",
        "assetClass": "crypto",
        "price": _round(price, 4),
        "bid": _round(float(ticker["bid"]), 4),
        "ask": _round(float(ticker["ask"]), 4),
        "change": _round(change, 4),
        "changePercent": _round(change_percent, 2),
        "previousClose": _round(open_24h, 4),
        "dayHigh": _round(float(stats["high"]), 4),
        "dayLow": _round(float(stats["low"]), 4),
        "volume": _round(float(stats["volume"]), 6),
        "currency": "USD",
        "exchange": "Coinbase Exchange",
        "marketState": "LIVE_24_7",
        "regularMarketTime": ticker.get("time"),
        "lastTradeTime": ticker.get("time"),
        "lastTradeId": ticker.get("trade_id"),
        "lastSize": _round(float(ticker["size"]), 8),
        "candles": _parse_coinbase_candles(candles_payload),
        "source": "Coinbase Exchange ticker/stats/candles",
        "feed": "real-time crypto trades",
        "isRealtime": True,
        "latencyMs": latency_ms,
        "fetchedAt": _now_iso(),
    }


async def _quote_for_symbol(symbol: str, use_cache: bool = True) -> dict[str, Any]:
    ttl = CRYPTO_CACHE_TTL_SECONDS if symbol in CRYPTO_SYMBOLS else EQUITY_CACHE_TTL_SECONDS
    cached = _quote_cache.get(symbol)
    if use_cache and cached and time.time() - cached[0] < ttl:
        return cached[1]

    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        try:
            if symbol in CRYPTO_SYMBOLS:
                parsed = await _coinbase_quote(symbol, client)
            else:
                async with _equity_fetch_lock:
                    await asyncio.sleep(0.12)
                    payload = await _fetch_yahoo_json(
                        YAHOO_CHART_URL.format(symbol=symbol),
                        {"range": "1d", "interval": "5m"},
                    )
                parsed = _parse_yahoo_chart(symbol, payload)
            _quote_cache[symbol] = (time.time(), parsed)
            return parsed
        except (httpx.HTTPError, ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError) as exc:
            if cached:
                return {**cached[1], "stale": True, "error": str(exc), "fetchedAt": _now_iso()}
            return {
                "symbol": symbol,
                "assetClass": "crypto" if symbol in CRYPTO_SYMBOLS else "equity",
                "price": None,
                "change": None,
                "changePercent": None,
                "candles": [],
                "error": str(exc),
                "source": "Coinbase Exchange" if symbol in CRYPTO_SYMBOLS else "Yahoo Finance Chart API",
                "feed": "upstream error",
                "isRealtime": False,
                "fetchedAt": _now_iso(),
            }


def _ema(values: list[float], period: int) -> float | None:
    if len(values) < period:
        return None
    multiplier = 2 / (period + 1)
    ema = sum(values[:period]) / period
    for value in values[period:]:
        ema = (value - ema) * multiplier + ema
    return ema


def _rsi(values: list[float], period: int = 14) -> float | None:
    if len(values) <= period:
        return None
    gains = []
    losses = []
    for prev, current in zip(values[-period - 1 : -1], values[-period:]):
        delta = current - prev
        gains.append(max(delta, 0))
        losses.append(abs(min(delta, 0)))
    avg_gain = sum(gains) / period
    avg_loss = sum(losses) / period
    if avg_loss == 0:
        return 100.0
    return 100 - (100 / (1 + avg_gain / avg_loss))


def _signals_from_detail(detail: dict[str, Any]) -> dict[str, Any]:
    candles = detail.get("candles") or []
    closes = [float(candle["close"]) for candle in candles if candle.get("close") is not None]
    volumes = [float(candle.get("volume") or 0) for candle in candles]
    price = float(detail["price"]) if detail.get("price") is not None else (closes[-1] if closes else None)

    ema_9 = _ema(closes, 9)
    ema_21 = _ema(closes, 21)
    rsi_14 = _rsi(closes)
    vwap = None
    if candles and sum(volumes) > 0:
        vwap = sum(float(c["close"]) * float(c.get("volume") or 0) for c in candles) / sum(volumes)

    last_15 = closes[-15:] if len(closes) >= 15 else closes
    volatility = None
    if len(last_15) > 2:
        returns = [
            (current - previous) / previous
            for previous, current in zip(last_15, last_15[1:])
            if previous
        ]
        if returns:
            mean = sum(returns) / len(returns)
            variance = sum((item - mean) ** 2 for item in returns) / len(returns)
            volatility = math.sqrt(variance) * 100

    trend_score = 0
    if price is not None and ema_9 is not None:
        trend_score += 1 if price >= ema_9 else -1
    if ema_9 is not None and ema_21 is not None:
        trend_score += 1 if ema_9 >= ema_21 else -1
    if rsi_14 is not None:
        if rsi_14 >= 65:
            trend_score += 1
        elif rsi_14 <= 35:
            trend_score -= 1

    direction = "up" if trend_score > 0 else "down" if trend_score < 0 else "flat"
    confidence = min(92, 50 + abs(trend_score) * 14 + (8 if detail.get("isRealtime") else 0))
    latest_time = detail.get("lastTradeTime") or detail.get("regularMarketTime")

    return {
        "symbol": detail["symbol"],
        "method": "EMA(9/21), RSI(14), VWAP, short-horizon realized volatility",
        "horizon": "next few ticks for crypto; next delayed bar for equities",
        "direction": direction,
        "confidence": confidence,
        "ema9": _round(ema_9, 4),
        "ema21": _round(ema_21, 4),
        "rsi14": _round(rsi_14, 2),
        "vwap": _round(vwap, 4),
        "realizedVolatilityPct": _round(volatility, 4),
        "isRealtime": bool(detail.get("isRealtime")),
        "basis": "live Coinbase ticks" if detail.get("isRealtime") else "Yahoo delayed bars",
        "asOf": latest_time,
        "disclaimer": "Quant signal from real market data, not a guaranteed prediction.",
    }


def _compact_quote(detail: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in detail.items() if key not in {"candles"}}


def _market_clock() -> dict[str, Any]:
    return {
        "now": _now_iso(),
        "crypto": "Coinbase BTC-USD and ETH-USD stream live 24/7.",
        "equities": "Public Yahoo equity quotes are delayed/last-sale; true no-delay equities require a licensed feed.",
    }


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "trader-desk-api", "time": _now_iso()}


@app.get("/api/symbols")
async def symbols() -> dict[str, Any]:
    return {
        "symbols": [
            {"symbol": symbol, "assetClass": "crypto" if symbol in CRYPTO_SYMBOLS else "equity"}
            for symbol in SYMBOLS
        ]
    }


@app.get("/api/quotes")
async def quotes(symbols: str | None = None) -> dict[str, Any]:
    target_symbols = [s.strip().upper() for s in symbols.split(",")] if symbols else SYMBOLS
    target_symbols = [_validate_symbol(s) for s in target_symbols if s.strip()]
    details = await asyncio.gather(*(_quote_for_symbol(symbol) for symbol in target_symbols))
    return {
        "symbols": target_symbols,
        "quotes": [_compact_quote(detail) for detail in details],
        "marketClock": _market_clock(),
        "fetchedAt": _now_iso(),
    }


@app.get("/api/desk")
async def desk(symbols: str | None = None) -> dict[str, Any]:
    target_symbols = [s.strip().upper() for s in symbols.split(",")] if symbols else SYMBOLS
    target_symbols = [_validate_symbol(s) for s in target_symbols if s.strip()]
    details = await asyncio.gather(*(_quote_for_symbol(symbol) for symbol in target_symbols))
    compact = [_compact_quote(detail) for detail in details]
    valid = [quote for quote in compact if quote.get("price") is not None]
    advancers = sum(1 for quote in valid if (quote.get("change") or 0) > 0)
    decliners = sum(1 for quote in valid if (quote.get("change") or 0) < 0)
    leader = max(valid, key=lambda quote: quote.get("changePercent") or -10_000, default=None)
    laggard = min(valid, key=lambda quote: quote.get("changePercent") or 10_000, default=None)
    total_notional = sum((quote.get("price") or 0) * (quote.get("volume") or 0) for quote in valid)
    signals = [_signals_from_detail(detail) for detail in details if detail.get("candles")]

    return {
        "symbols": target_symbols,
        "quotes": compact,
        "pulse": {
            "advancers": advancers,
            "decliners": decliners,
            "unchanged": max(len(valid) - advancers - decliners, 0),
            "leader": leader,
            "laggard": laggard,
            "notionalVolume": round(total_notional, 2),
            "riskTone": "risk-on" if advancers >= decliners else "risk-off",
            "liveFeeds": sum(1 for quote in valid if quote.get("isRealtime")),
        },
        "signals": signals,
        "alerts": [
            {
                "level": "live" if quote.get("isRealtime") else "delayed",
                "symbol": quote["symbol"],
                "message": (
                    f"{quote['symbol']} {quote.get('changePercent', 0):+.2f}% | "
                    f"{quote.get('feed')} | last {quote.get('lastTradeTime') or 'n/a'}"
                ),
            }
            for quote in sorted(
                valid,
                key=lambda item: abs(item.get("changePercent") or 0),
                reverse=True,
            )[:6]
        ],
        "marketClock": _market_clock(),
        "fetchedAt": _now_iso(),
    }


@app.get("/api/quotes/{symbol}")
async def quote_detail(symbol: str) -> dict[str, Any]:
    normalized = _validate_symbol(symbol)
    detail = await _quote_for_symbol(normalized, use_cache=False)
    if detail.get("candles"):
        detail["signals"] = _signals_from_detail(detail)
    return detail


@app.get("/api/candles/{symbol}")
async def candles(symbol: str, interval: str = "1m") -> dict[str, Any]:
    normalized = _validate_symbol(symbol)
    return await _candles_for_symbol(normalized, interval)


@app.get("/api/signals/{symbol}")
async def signals(symbol: str) -> dict[str, Any]:
    normalized = _validate_symbol(symbol)
    detail = await _quote_for_symbol(normalized, use_cache=False)
    if not detail.get("candles"):
        raise HTTPException(status_code=502, detail="No candle data available for signal calculation")
    return _signals_from_detail(detail)


@app.get("/api/orderbook/{symbol}")
async def orderbook(symbol: str) -> dict[str, Any]:
    normalized = _validate_symbol(symbol)
    if normalized not in CRYPTO_SYMBOLS:
        raise HTTPException(status_code=404, detail="Order book is available for BTC-USD and ETH-USD only")

    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        try:
            payload = await _fetch_json(client, COINBASE_BOOK_URL.format(symbol=normalized), {"level": 2})
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"Coinbase order book failed: {exc}") from exc

    def rows(side: str) -> list[dict[str, float | int]]:
        return [
            {"price": float(row[0]), "size": float(row[1]), "orders": int(row[2])}
            for row in payload.get(side, [])[:16]
        ]

    return {
        "symbol": normalized,
        "bids": rows("bids"),
        "asks": rows("asks"),
        "source": "Coinbase Exchange Product Book",
        "isRealtime": True,
        "fetchedAt": _now_iso(),
    }


@app.get("/api/tape/{symbol}")
async def tape(symbol: str) -> dict[str, Any]:
    normalized = _validate_symbol(symbol)
    if normalized not in CRYPTO_SYMBOLS:
        quote = await _quote_for_symbol(normalized)
        candles = quote.get("candles", [])[-20:]
        return {
            "symbol": normalized,
            "trades": [
                {
                    "time": candle["time"],
                    "price": candle["close"],
                    "size": candle["volume"],
                    "side": "up" if candle["close"] >= candle["open"] else "down",
                }
                for candle in reversed(candles)
            ],
            "source": "Yahoo Finance delayed intraday bars, not live trade tape",
            "isRealtime": False,
            "fetchedAt": _now_iso(),
        }

    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        try:
            payload = await _fetch_json(client, COINBASE_TRADES_URL.format(symbol=normalized))
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"Coinbase trade tape failed: {exc}") from exc

    return {
        "symbol": normalized,
        "trades": [
            {
                "time": trade.get("time"),
                "price": float(trade["price"]),
                "size": float(trade["size"]),
                "side": trade.get("side") or "trade",
                "tradeId": trade.get("trade_id"),
            }
            for trade in payload[:36]
        ],
        "source": "Coinbase Exchange Product Trades",
        "isRealtime": True,
        "fetchedAt": _now_iso(),
    }


@app.websocket("/api/stream/{symbol}")
async def stream(symbol: str, websocket: WebSocket) -> None:
    normalized = _validate_symbol(symbol)
    await websocket.accept()
    if normalized not in CRYPTO_SYMBOLS:
        await websocket.send_json(
            {
                "symbol": normalized,
                "type": "delayed-only",
                "isRealtime": False,
                "message": "No-delay equity streaming is not available from the configured public feed.",
            }
        )
        await websocket.close(code=1003)
        return

    subscribe = {
        "type": "subscribe",
        "product_ids": [normalized],
        "channels": ["ticker"],
    }

    try:
        async with websockets.connect(COINBASE_WS_URL, ping_interval=20, ping_timeout=20) as upstream:
            await upstream.send(json.dumps(subscribe))
            async for raw_message in upstream:
                message = json.loads(raw_message)
                if message.get("type") != "ticker" or message.get("product_id") != normalized:
                    continue
                await websocket.send_json(
                    {
                        "type": "tick",
                        "symbol": normalized,
                        "price": float(message["price"]),
                        "bid": float(message["best_bid"]) if message.get("best_bid") else None,
                        "ask": float(message["best_ask"]) if message.get("best_ask") else None,
                        "lastSize": float(message["last_size"]) if message.get("last_size") else None,
                        "side": message.get("side"),
                        "tradeId": message.get("trade_id"),
                        "time": message.get("time"),
                        "source": "Coinbase Exchange WebSocket ticker",
                        "isRealtime": True,
                        "fetchedAt": _now_iso(),
                    }
                )
    except WebSocketDisconnect:
        return
    except Exception as exc:
        await websocket.send_json({"type": "error", "symbol": normalized, "message": str(exc)})


import urllib.parse

@app.get("/api/search")
async def search(q: str):
    url = f"https://query2.finance.yahoo.com/v1/finance/search?q={urllib.parse.quote(q)}"
    headers = {"User-Agent": "Mozilla/5.0"}
    async with httpx.AsyncClient() as client:
        response = await client.get(url, headers=headers)
        if response.status_code != 200:
            raise HTTPException(status_code=response.status_code, detail="Search failed")
        data = response.json()
        quotes = data.get("quotes", [])
        return {
            "results": [
                {
                    "symbol": item.get("symbol"),
                    "name": item.get("shortname") or item.get("longname"),
                    "exchange": item.get("exchange"),
                    "type": item.get("quoteType")
                }
                for item in quotes if item.get("symbol")
            ]
        }

frontend_dir = Path(__file__).resolve().parents[1] / "frontend"
if frontend_dir.exists():
    app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")
