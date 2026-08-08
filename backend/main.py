from __future__ import annotations

import asyncio
import contextlib
import json
import math
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import httpx
import random
import websockets
from websockets.exceptions import ConnectionClosed
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from ws_manager import hft_manager

SYMBOLS = ["NVDA", "AAPL", "TSLA", "MSFT", "BTC-USD", "ETH-USD", "SOXL", "SPY"]
CRYPTO_SYMBOLS = {
    "BTC-USD", "ETH-USD", "SOL-USD", "XRP-USD", "DOGE-USD", "ADA-USD", "AVAX-USD", "LINK-USD", "DOT-USD",
    "LTC-USD", "BCH-USD", "UNI-USD", "ATOM-USD", "ETC-USD", "XLM-USD", "FIL-USD", "ALGO-USD", "ICP-USD",
    "HBAR-USD", "NEAR-USD", "APT-USD", "SUI-USD", "OP-USD", "ARB-USD", "INJ-USD", "AAVE-USD",
    "SHIB-USD", "PEPE-USD", "BONK-USD", "WIF-USD", "FLOKI-USD", "TON-USD", "POL-USD", "CRO-USD", "VET-USD",
    "GRT-USD", "STX-USD", "IMX-USD", "SEI-USD", "TIA-USD", "TAO-USD", "FET-USD",
    "ENA-USD", "ONDO-USD", "CRV-USD", "ZEC-USD",
}
CRYPTO_NAMES = {
    "BTC-USD": "Bitcoin",
    "ETH-USD": "Ethereum",
    "SOL-USD": "Solana",
    "XRP-USD": "XRP",
    "DOGE-USD": "Dogecoin",
    "ADA-USD": "Cardano",
    "AVAX-USD": "Avalanche",
    "LINK-USD": "Chainlink",
    "DOT-USD": "Polkadot",
    "LTC-USD": "Litecoin",
    "BCH-USD": "Bitcoin Cash",
    "UNI-USD": "Uniswap",
    "ATOM-USD": "Cosmos",
    "ETC-USD": "Ethereum Classic",
    "XLM-USD": "Stellar",
    "FIL-USD": "Filecoin",
    "ALGO-USD": "Algorand",
    "ICP-USD": "Internet Computer",
    "HBAR-USD": "Hedera",
    "NEAR-USD": "NEAR Protocol",
    "APT-USD": "Aptos",
    "SUI-USD": "Sui",
    "OP-USD": "Optimism",
    "ARB-USD": "Arbitrum",
    "INJ-USD": "Injective",
    "AAVE-USD": "Aave",
    "SHIB-USD": "Shiba Inu",
    "PEPE-USD": "Pepe",
    "BONK-USD": "Bonk",
    "WIF-USD": "dogwifhat",
    "FLOKI-USD": "Floki",
    "TON-USD": "Toncoin",
    "POL-USD": "Polygon",
    "CRO-USD": "Cronos",
    "VET-USD": "VeChain",
    "GRT-USD": "The Graph",
    "STX-USD": "Stacks",
    "IMX-USD": "Immutable",
    "SEI-USD": "Sei",
    "TIA-USD": "Celestia",
    "TAO-USD": "Bittensor",
    "FET-USD": "Fetch.ai",
    "ENA-USD": "Ethena",
    "ONDO-USD": "Ondo",
    "CRV-USD": "Curve",
    "ZEC-USD": "Zcash",
}
BOT_RUN_LOG_DIR = Path(__file__).resolve().parent.parent / "Logs"

YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
COINBASE_BOOK_URL = "https://api.exchange.coinbase.com/products/{symbol}/book"
COINBASE_TRADES_URL = "https://api.exchange.coinbase.com/products/{symbol}/trades"
COINBASE_TICKER_URL = "https://api.exchange.coinbase.com/products/{symbol}/ticker"
COINBASE_STATS_URL = "https://api.exchange.coinbase.com/products/{symbol}/stats"
COINBASE_CANDLES_URL = "https://api.exchange.coinbase.com/products/{symbol}/candles"
COINBASE_WS_URL = "wss://ws-feed.exchange.coinbase.com"
POLYMARKET_GAMMA_URL = "https://gamma-api.polymarket.com"
POLYMARKET_CLOB_URL = "https://clob.polymarket.com"
POLYMARKET_CLOB_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market"
POLYMARKET_RTDS_URL = "wss://ws-live-data.polymarket.com"
POLYMARKET_CRYPTO_PRICE_URL = "https://polymarket.com/api/crypto/crypto-price"
BINANCE_BTC_WS_URL = "wss://stream.binance.com:9443/ws/btcusdt@trade"

HTTP_TIMEOUT = 10.0
EQUITY_CACHE_TTL_SECONDS = 15
CRYPTO_CACHE_TTL_SECONDS = 20.0
SUPPORTED_INTERVALS = {"1m": 60, "5m": 300, "15m": 900, "1h": 3600, "6h": 21600, "1d": 86400}
YAHOO_INTERVALS = {"1m", "5m", "15m", "1h", "1d"}
COINBASE_GRANULARITIES = {60, 300, 900, 3600, 21600, 86400}
UPSTREAM_HEADERS = {
    "User-Agent": "Mozilla/5.0",
    "Accept": "application/json,text/plain,*/*",
}

app = FastAPI(title="Trader Desk API", version="1.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$",
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

_quote_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_equity_fetch_lock = asyncio.Lock()
_QUOTE_CACHE_MAX_ENTRIES = 400
_QUOTE_CACHE_MAX_AGE_SECONDS = 300.0

# Cap concurrent upstream crypto fetches. The desk endpoint gathers a quote for
# every symbol; without a limiter that fires dozens of Coinbase calls in
# parallel per poll and trips upstream rate limits (and file descriptors).
_crypto_fetch_semaphore = asyncio.Semaphore(6)

# Coinbase's public market-data API rate-limits per IP (~10 req/s rolling). The
# desk polls ~48 symbols (ticker + candles each) plus the BTC flow feed
# (book + trades every 1.2s), which together blow through that budget and
# surface as 429s (ticker, candles, stats) and reset connections. A token
# bucket paces all Coinbase requests so they queue instead of tripping the
# upstream limit. Kept deliberately under Coinbase's ~10 req/s ceiling.
class _TokenBucketLimiter:
    def __init__(self, rate: float, burst: int) -> None:
        self._rate = rate
        self._burst = burst
        self._tokens = float(burst)
        self._last = time.monotonic()
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        async with self._lock:
            while True:
                now = time.monotonic()
                self._tokens = min(self._burst, self._tokens + (now - self._last) * self._rate)
                self._last = now
                if self._tokens >= 1.0:
                    self._tokens -= 1.0
                    return
                await asyncio.sleep((1.0 - self._tokens) / self._rate)


_coinbase_limiter = _TokenBucketLimiter(rate=7.0, burst=14)

_polymarket_cache: tuple[float, dict[str, Any]] | None = None
_polymarket_cache_lock = asyncio.Lock()
_polymarket_rtds_task: asyncio.Task | None = None
_polymarket_clob_task: asyncio.Task | None = None
_polymarket_chainlink_latest: dict[str, float] = {}
_polymarket_chainlink_history: list[tuple[float, float]] = []
_binance_btc_task: asyncio.Task | None = None
_binance_btc_latest: dict[str, float] = {}
_binance_btc_history: list[tuple[float, float]] = []
_chainlink_twap_task: asyncio.Task | None = None
_chainlink_twap_latest: dict[int, dict[str, Any]] = {30: {}, 60: {}}
_chainlink_twap_history: dict[int, list[tuple[float, float]]] = {30: [], 60: []}
_chainlink_twap_error: str | None = None
POLYMARKET_CHAINLINK_MAX_AGE_MS = 5_000
BINANCE_BTC_MAX_AGE_MS = 3_000
CHAINLINK_TWAP_MAX_AGE_MS = 5_000
POLYMARKET_CHAINLINK_CACHE_FILE = Path("/tmp/trader-desk-polymarket-chainlink.json")
CHAINLINK_TWAP_CACHE_FILE = Path("/tmp/trader-desk-polymarket-twap.json")
_polymarket_chainlink_last_persisted = 0.0
_chainlink_twap_last_persisted = 0.0
_polymarket_ptb_cache: dict[str, tuple[float, dict[str, Any] | None]] = {}
_polymarket_clob_assets: set[str] = set()
_polymarket_clob_assets_lock = asyncio.Lock()
_polymarket_clob_quotes: dict[str, dict[str, Any]] = {}
_polymarket_clob_books: dict[str, dict[str, dict[str, float]]] = {}

# Wraps a Coinbase upstream call so it passes through the shared token bucket.
async def _coinbase_fetch(url: str, params: dict[str, str]) -> Any:
    await _coinbase_limiter.acquire()
    return await _fetch_yahoo_json(url, params)

# The desk endpoint refreshes at most this many stale symbols per poll (round
# robin). Bounding the inline refresh keeps every desk response fast while the
# full universe stays within Coinbase's ~10 req/s public rate limit.
_DESK_REFRESH_BUDGET = 12
_desk_rotate_cursor = 0
_desk_rotate_lock = asyncio.Lock()


def _quote_is_fresh(symbol: str) -> bool:
    cached = _quote_cache.get(symbol)
    if not cached:
        return False
    ttl = CRYPTO_CACHE_TTL_SECONDS if symbol in CRYPTO_SYMBOLS else EQUITY_CACHE_TTL_SECONDS
    return time.time() - cached[0] < ttl


async def _desk_quote_for_symbol(symbol: str, allow_refresh: bool) -> dict[str, Any]:
    if allow_refresh:
        return await _quote_for_symbol(symbol)
    cached = _quote_cache.get(symbol)
    if cached:
        return {**dict(cached[1]), "stale": True, "fetchedAt": _now_iso()}
    return {
        "symbol": symbol,
        "assetClass": "crypto" if symbol in CRYPTO_SYMBOLS else "equity",
        "price": None,
        "candles": [],
        "loading": True,
        "fetchedAt": _now_iso(),
    }

# Shared connection-pooled upstream client. Creating a fresh httpx.AsyncClient
# per request re-loads the SSL context (opens a cert file) and opens new TLS
# sockets each time; under the app's ~1.2s orderbook/tape polling that churns
# file descriptors until Errno 24 ("Too many open files") and resets clients.
_upstream_client: httpx.AsyncClient | None = None
_upstream_client_lock = asyncio.Lock()


async def _shared_client() -> httpx.AsyncClient:
    global _upstream_client
    if _upstream_client is None:
        async with _upstream_client_lock:
            if _upstream_client is None:
                _upstream_client = httpx.AsyncClient(
                    timeout=httpx.Timeout(HTTP_TIMEOUT),
                    headers=UPSTREAM_HEADERS,
                    limits=httpx.Limits(max_connections=20, max_keepalive_connections=8),
                    follow_redirects=True,
                )
    return _upstream_client


async def _polymarket_rtds_loop() -> None:
    """Keep the exact Chainlink BTC/USD resolution feed in memory.

    The BTC Up/Down markets explicitly resolve against Chainlink, not the
    Coinbase spot quote used by the main desk. RTDS gives us both a small
    historical snapshot on connect and live updates, which lets the paper
    engine capture a trustworthy window-start reference (price-to-beat).
    """
    global _polymarket_chainlink_history, _polymarket_chainlink_latest, _polymarket_chainlink_last_persisted
    subscription = {
        "action": "subscribe",
        "subscriptions": [{
            "topic": "crypto_prices_chainlink",
            "type": "*",
            "filters": '{"symbol":"btc/usd"}',
        }],
    }
    while True:
        try:
            async with websockets.connect(
                POLYMARKET_RTDS_URL,
                ping_interval=20,
                ping_timeout=10,
                open_timeout=10,
            ) as upstream:
                await upstream.send(json.dumps(subscription))
                while True:
                    try:
                        raw_message = await asyncio.wait_for(upstream.recv(), timeout=5)
                    except asyncio.TimeoutError:
                        # RTDS asks clients to keep the connection warm. This
                        # matters for the display stream, which can otherwise
                        # stop after its initial snapshot.
                        await upstream.send("PING")
                        continue
                    try:
                        message = json.loads(raw_message)
                    except (json.JSONDecodeError, TypeError):
                        continue
                    payload = message.get("payload") if isinstance(message, dict) else None
                    points = payload.get("data") if isinstance(payload, dict) else None
                    if not isinstance(points, list):
                        points = [payload] if isinstance(payload, dict) else []
                    for point in points:
                        if not isinstance(point, dict):
                            continue
                        price = _polymarket_float(point.get("value"))
                        timestamp_ms = _polymarket_float(point.get("timestamp"))
                        if not price or not timestamp_ms:
                            continue
                        _polymarket_chainlink_latest = {
                            "price": price,
                            "timestampMs": timestamp_ms,
                            "receivedAtMs": time.time() * 1000,
                        }
                        _polymarket_chainlink_history.append((timestamp_ms, price))
                    if _polymarket_chainlink_history:
                        cutoff = time.time() * 1000 - 30 * 60 * 1000
                        _polymarket_chainlink_history = [
                            point for point in _polymarket_chainlink_history if point[0] >= cutoff
                        ][-2_400:]
                        if time.time() - _polymarket_chainlink_last_persisted >= 5:
                            try:
                                POLYMARKET_CHAINLINK_CACHE_FILE.write_text(json.dumps(_polymarket_chainlink_history), encoding="utf-8")
                                _polymarket_chainlink_last_persisted = time.time()
                            except OSError:
                                pass
        except asyncio.CancelledError:
            raise
        except Exception:
            await asyncio.sleep(2)


async def _binance_btc_loop() -> None:
    """Mirror Polymarket's own BTC display stream for visual price parity.

    The old implementation connected directly to Binance. That can differ
    from the price rendered in Polymarket's UI even when both identify as
    BTCUSDT, which makes a side-by-side desk misleading. The RTDS
    ``crypto_prices`` topic is Polymarket's Binance-backed stream, so this
    connection now mirrors the platform's published live display price.

    This is intentionally separate from the Chainlink/TWAP settlement path.
    """
    global _binance_btc_latest, _binance_btc_history
    while True:
        try:
            subscription = {
                "action": "subscribe",
                "subscriptions": [{
                    "topic": "crypto_prices",
                    "type": "update",
                    "filters": "btcusdt",
                }, {
                    # RTDS sends the crypto display snapshot when this paired
                    # subscription is active. Chainlink messages below are
                    # explicitly ignored; this task only mirrors the UI's
                    # Binance-backed display series.
                    "topic": "crypto_prices_chainlink",
                    "type": "*",
                    "filters": '{"symbol":"btc/usd"}',
                }],
            }
            async with websockets.connect(
                POLYMARKET_RTDS_URL,
                ping_interval=20,
                ping_timeout=10,
                open_timeout=10,
            ) as upstream:
                await upstream.send(json.dumps(subscription))
                async for raw_message in upstream:
                    try:
                        message = json.loads(raw_message)
                    except (json.JSONDecodeError, TypeError):
                        continue
                    topic = message.get("topic") if isinstance(message, dict) else None
                    if topic and topic != "crypto_prices":
                        continue
                    payload = message.get("payload") if isinstance(message, dict) else None
                    points = payload.get("data") if isinstance(payload, dict) else None
                    if not isinstance(points, list):
                        points = [payload] if isinstance(payload, dict) else []
                    for point in points:
                        if not isinstance(point, dict):
                            continue
                        price = _polymarket_float(point.get("value"))
                        timestamp_ms = _polymarket_float(point.get("timestamp"))
                        if not price or not timestamp_ms:
                            continue
                        received_at_ms = time.time() * 1000
                        _binance_btc_latest = {
                            "price": price,
                            "timestampMs": timestamp_ms,
                            "receivedAtMs": received_at_ms,
                        }
                        _binance_btc_history.append((timestamp_ms, price))
                    if _binance_btc_history:
                        cutoff = time.time() * 1000 - 30 * 60 * 1000
                        _binance_btc_history = [
                            point for point in _binance_btc_history if point[0] >= cutoff
                        ][-2_400:]
        except asyncio.CancelledError:
            raise
        except Exception:
            await asyncio.sleep(2)


async def _chainlink_twap_loop() -> None:
    """Consume Polymarket's free relay of the exact Chainlink TWAP feeds.

    A 5-minute BTC contract uses Chainlink's 30-second TWAP and a 15-minute
    contract uses its 60-second TWAP. These public RTDS topics are the source
    Polymarket documents for the products; the older ``crypto_prices_chainlink``
    topic is only a spot feed and must not appear in a settlement chart.
    """
    global _chainlink_twap_latest, _chainlink_twap_history, _chainlink_twap_error, _chainlink_twap_last_persisted
    while True:
        try:
            subscription = {
                "action": "subscribe",
                "subscriptions": [
                    {
                        "topic": "crypto_prices_twap_thirty",
                        "type": "update",
                        "filters": '{"symbol":"btc/usd"}',
                    },
                    {
                        "topic": "crypto_prices_twap_sixty",
                        "type": "update",
                        "filters": '{"symbol":"btc/usd"}',
                    },
                ],
            }
            async with websockets.connect(
                POLYMARKET_RTDS_URL,
                ping_interval=20,
                ping_timeout=10,
                open_timeout=10,
            ) as upstream:
                _chainlink_twap_error = None
                await upstream.send(json.dumps(subscription, separators=(",", ":")))
                next_heartbeat = time.monotonic() + 5
                while True:
                    timeout = max(0.1, next_heartbeat - time.monotonic())
                    try:
                        raw_message = await asyncio.wait_for(upstream.recv(), timeout=timeout)
                    except asyncio.TimeoutError:
                        await upstream.send("PING")
                        next_heartbeat = time.monotonic() + 5
                        continue
                    try:
                        message = json.loads(raw_message)
                    except (json.JSONDecodeError, TypeError):
                        continue
                    if not isinstance(message, dict):
                        continue
                    topic = message.get("topic")
                    window_seconds = 30 if topic == "crypto_prices_twap_thirty" else 60 if topic == "crypto_prices_twap_sixty" else None
                    payload = message.get("payload")
                    if window_seconds is None or not isinstance(payload, dict) or payload.get("symbol") != "btc/usd":
                        continue
                    raw_e18_price = payload.get("full_accuracy_value")
                    try:
                        price = int(str(raw_e18_price)) / 1_000_000_000_000_000_000 if raw_e18_price is not None else None
                    except (TypeError, ValueError):
                        price = None
                    price = price if price is not None else _polymarket_float(payload.get("value"))
                    timestamp_ms = _polymarket_float(payload.get("timestamp"))
                    if not price or not timestamp_ms:
                        continue
                    received_at_ms = time.time() * 1000
                    _chainlink_twap_latest[window_seconds] = {
                        "price": price,
                        "observationsTimestampMs": timestamp_ms,
                        "receivedAtMs": received_at_ms,
                    }
                    _chainlink_twap_history[window_seconds].append((timestamp_ms, price))
                    cutoff = time.time() * 1000 - 30 * 60 * 1000
                    _chainlink_twap_history[window_seconds] = [
                        point for point in _chainlink_twap_history[window_seconds] if point[0] >= cutoff
                    ][-2_400:]
                    if time.time() - _chainlink_twap_last_persisted >= 5:
                        try:
                            CHAINLINK_TWAP_CACHE_FILE.write_text(json.dumps(_chainlink_twap_history), encoding="utf-8")
                            _chainlink_twap_last_persisted = time.time()
                        except OSError:
                            pass
                    if time.monotonic() >= next_heartbeat:
                        await upstream.send("PING")
                        next_heartbeat = time.monotonic() + 5
        except asyncio.CancelledError:
            raise
        except Exception:
            _chainlink_twap_error = "Polymarket RTDS Chainlink TWAP stream unavailable"
            await asyncio.sleep(2)


def _clob_float(value: Any) -> float | None:
    return _polymarket_float(value)


def _clob_save_quote(asset_id: str, bid: Any = None, ask: Any = None, last: Any = None, timestamp: Any = None) -> None:
    previous = _polymarket_clob_quotes.get(asset_id, {})
    next_quote = dict(previous)
    bid_value = _clob_float(bid)
    ask_value = _clob_float(ask)
    last_value = _clob_float(last)
    if bid_value is not None:
        next_quote["bid"] = bid_value
    if ask_value is not None:
        next_quote["ask"] = ask_value
    if last_value is not None:
        next_quote["last"] = last_value
    if "bid" in next_quote and "ask" in next_quote:
        next_quote["mid"] = (next_quote["bid"] + next_quote["ask"]) / 2
        next_quote["spread"] = max(0.0, next_quote["ask"] - next_quote["bid"])
    next_quote["timestampMs"] = _clob_float(timestamp) or time.time() * 1000
    next_quote["receivedAtMs"] = time.time() * 1000
    next_quote["source"] = "Polymarket CLOB WebSocket"
    _polymarket_clob_quotes[asset_id] = next_quote


def _clob_apply_book(asset_id: str, bids: list[Any], asks: list[Any], timestamp: Any = None) -> None:
    book = {"bids": {}, "asks": {}}
    for side_name, rows in (("bids", bids), ("asks", asks)):
        for row in rows if isinstance(rows, list) else []:
            if not isinstance(row, dict):
                continue
            price = _clob_float(row.get("price"))
            size = _clob_float(row.get("size"))
            if price is not None and size is not None and size > 0:
                book[side_name][price] = size
    _polymarket_clob_books[asset_id] = book
    best_bid = max(book["bids"]) if book["bids"] else None
    best_ask = min(book["asks"]) if book["asks"] else None
    _clob_save_quote(asset_id, best_bid, best_ask, timestamp=timestamp)


async def _set_polymarket_clob_assets(asset_ids: list[str]) -> None:
    global _polymarket_clob_assets
    async with _polymarket_clob_assets_lock:
        _polymarket_clob_assets = set(asset_ids)


def _polymarket_clob_quote(asset_id: str) -> dict[str, Any] | None:
    quote = _polymarket_clob_quotes.get(asset_id)
    if not quote:
        return None
    age_ms = max(0, time.time() * 1000 - float(quote.get("receivedAtMs") or 0))
    if age_ms > 5_000 or quote.get("bid") is None or quote.get("ask") is None:
        return None
    return {**quote, "ageMs": round(age_ms)}


async def _polymarket_clob_loop() -> None:
    """Stream the selected BTC outcome books instead of waiting for REST polls."""
    global _polymarket_clob_books, _polymarket_clob_quotes
    while True:
        try:
            async with websockets.connect(
                POLYMARKET_CLOB_WS_URL,
                ping_interval=20,
                ping_timeout=10,
                open_timeout=10,
            ) as upstream:
                subscribed: set[str] = set()
                while True:
                    async with _polymarket_clob_assets_lock:
                        assets = set(_polymarket_clob_assets)
                    if assets != subscribed:
                        if subscribed:
                            await upstream.send(json.dumps({"assets_ids": sorted(subscribed - assets), "operation": "unsubscribe"}))
                        if assets:
                            payload = {"assets_ids": sorted(assets), "type": "market", "custom_feature_enabled": True}
                            if subscribed:
                                payload["operation"] = "subscribe"
                            await upstream.send(json.dumps(payload))
                        subscribed = assets
                    try:
                        raw_message = await asyncio.wait_for(upstream.recv(), timeout=5)
                    except asyncio.TimeoutError:
                        continue
                    try:
                        decoded = json.loads(raw_message)
                    except (json.JSONDecodeError, TypeError):
                        continue
                    messages = decoded if isinstance(decoded, list) else [decoded]
                    for message in messages:
                        if not isinstance(message, dict):
                            continue
                        event_type = message.get("event_type")
                        asset_id = str(message.get("asset_id") or "")
                        timestamp = message.get("timestamp")
                        if event_type == "book" and asset_id:
                            _clob_apply_book(asset_id, message.get("bids") or [], message.get("asks") or [], timestamp)
                        elif event_type == "best_bid_ask" and asset_id:
                            _clob_save_quote(asset_id, message.get("best_bid"), message.get("best_ask"), timestamp=timestamp)
                        elif event_type == "last_trade_price" and asset_id:
                            _clob_save_quote(asset_id, last=message.get("price"), timestamp=timestamp)
                        elif event_type == "price_change":
                            for change in message.get("price_changes") or []:
                                if not isinstance(change, dict):
                                    continue
                                change_asset = str(change.get("asset_id") or "")
                                if not change_asset:
                                    continue
                                book = _polymarket_clob_books.setdefault(change_asset, {"bids": {}, "asks": {}})
                                side = "bids" if str(change.get("side") or "").upper() == "BUY" else "asks"
                                price = _clob_float(change.get("price"))
                                size = _clob_float(change.get("size"))
                                if price is None:
                                    continue
                                if size is None or size <= 0:
                                    book[side].pop(price, None)
                                else:
                                    book[side][price] = size
                                best_bid = max(book["bids"]) if book["bids"] else None
                                best_ask = min(book["asks"]) if book["asks"] else None
                                _clob_save_quote(change_asset, best_bid, best_ask, timestamp=timestamp)
        except asyncio.CancelledError:
            raise
        except Exception:
            await asyncio.sleep(2)


def _polymarket_spot_snapshot() -> dict[str, Any] | None:
    latest = _polymarket_chainlink_latest
    if not latest:
        return None
    age_ms = max(0, time.time() * 1000 - latest["receivedAtMs"])
    return {
        "price": latest["price"],
        "timestampMs": latest["timestampMs"],
        "receivedAtMs": latest["receivedAtMs"],
        "ageMs": round(age_ms),
        "stale": age_ms > POLYMARKET_CHAINLINK_MAX_AGE_MS,
        "source": "Polymarket RTDS Chainlink BTC/USD",
    }


def _load_polymarket_chainlink_history() -> None:
    global _polymarket_chainlink_history
    try:
        payload = json.loads(POLYMARKET_CHAINLINK_CACHE_FILE.read_text(encoding="utf-8"))
        cutoff = time.time() * 1000 - 30 * 60 * 1000
        _polymarket_chainlink_history = [
            (float(point[0]), float(point[1]))
            for point in payload
            if isinstance(point, list) and len(point) == 2
            and float(point[0]) >= cutoff and float(point[1]) > 0
        ][-2_400:]
    except (OSError, ValueError, TypeError, IndexError, json.JSONDecodeError):
        _polymarket_chainlink_history = []


def _load_chainlink_twap_history() -> None:
    global _chainlink_twap_history
    try:
        payload = json.loads(CHAINLINK_TWAP_CACHE_FILE.read_text(encoding="utf-8"))
        cutoff = time.time() * 1000 - 30 * 60 * 1000
        if not isinstance(payload, dict):
            raise ValueError("Expected TWAP history by window")
        _chainlink_twap_history = {
            window_seconds: [
                (float(point[0]), float(point[1]))
                for point in payload.get(str(window_seconds), [])
                if isinstance(point, list) and len(point) == 2
                and float(point[0]) >= cutoff and float(point[1]) > 0
            ][-2_400:]
            for window_seconds in (30, 60)
        }
    except (OSError, ValueError, TypeError, IndexError, json.JSONDecodeError):
        _chainlink_twap_history = {30: [], 60: []}


def _binance_btc_snapshot() -> dict[str, Any]:
    latest = _binance_btc_latest
    if not latest:
        return {"price": None, "timestampMs": None, "receivedAtMs": None, "ageMs": None, "momentumPct": None, "stale": True, "source": "Polymarket RTDS BTC display unavailable"}
    now_ms = time.time() * 1000
    age_ms = max(0, now_ms - latest["receivedAtMs"])
    prior_cutoff = latest["timestampMs"] - 10_000
    prior = next((point for point in reversed(_binance_btc_history) if point[0] <= prior_cutoff), None)
    momentum_pct = ((latest["price"] / prior[1]) - 1) * 100 if prior and prior[1] else None
    return {
        "price": latest["price"],
        "timestampMs": latest["timestampMs"],
        "receivedAtMs": latest["receivedAtMs"],
        "ageMs": round(age_ms),
        "momentumPct10s": momentum_pct,
        "stale": age_ms > BINANCE_BTC_MAX_AGE_MS,
        "source": "Polymarket RTDS crypto_prices BTCUSDT",
    }


def _chainlink_twap_snapshot(window_seconds: int) -> dict[str, Any]:
    latest = _chainlink_twap_latest.get(window_seconds, {})
    source = f"Polymarket RTDS Chainlink BTC/USD {window_seconds}s TWAP"
    if not latest:
        return {
            "price": None,
            "timestampMs": None,
            "receivedAtMs": None,
            "ageMs": None,
            "stale": True,
            "exact": False,
            "status": "connecting",
            "error": _chainlink_twap_error or f"Connecting to Polymarket's {window_seconds}s TWAP relay",
            "source": source,
        }
    age_ms = max(0, time.time() * 1000 - float(latest["receivedAtMs"]))
    live = age_ms <= CHAINLINK_TWAP_MAX_AGE_MS
    return {
        "price": latest["price"],
        "timestampMs": latest["observationsTimestampMs"],
        "receivedAtMs": latest["receivedAtMs"],
        "ageMs": round(age_ms),
        "stale": not live,
        "exact": live,
        "status": "live" if live else "stale",
        "error": None if live else _chainlink_twap_error or f"Polymarket {window_seconds}s TWAP update is stale",
        "source": source,
    }


def _chainlink_twap_reference_price(window_start: int, window_seconds: int) -> dict[str, Any]:
    """Use only an exact TWAP report captured at the market boundary."""
    target_ms = float(window_start) * 1000
    candidates = [
        point for point in _chainlink_twap_history.get(window_seconds, [])
        if abs(point[0] - target_ms) <= 2_500
    ]
    if not candidates:
        return {
            "price": None,
            "timestampMs": None,
            "ageMs": None,
            "ready": False,
            "quality": "missing",
            "reason": "Awaiting Polymarket's opening TWAP report",
        }
    timestamp_ms, price = min(candidates, key=lambda point: abs(point[0] - target_ms))
    distance_ms = abs(timestamp_ms - target_ms)
    return {
        "price": price,
        "timestampMs": timestamp_ms,
        "ageMs": round(distance_ms),
        "ready": distance_ms <= 2_500,
        "quality": "polymarket_twap" if distance_ms <= 2_500 else "approximate",
        "source": f"Polymarket RTDS Chainlink {window_seconds}s TWAP",
    }


def _polymarket_reference_price(window_start: int) -> dict[str, Any]:
    """Find the closest RTDS tick to the market's official start boundary."""
    target_ms = float(window_start) * 1000
    candidates = [point for point in _polymarket_chainlink_history if abs(point[0] - target_ms) <= 10_000]
    if not candidates:
        return {"price": None, "timestampMs": None, "ageMs": None, "ready": False, "quality": "missing"}
    timestamp_ms, price = min(candidates, key=lambda point: abs(point[0] - target_ms))
    distance_ms = abs(timestamp_ms - target_ms)
    return {
        "price": price,
        "timestampMs": timestamp_ms,
        "ageMs": round(distance_ms),
        "ready": distance_ms <= 3_000,
        "quality": "captured" if distance_ms <= 3_000 else "approximate",
    }


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _evict_quote_cache() -> None:
    if len(_quote_cache) <= _QUOTE_CACHE_MAX_ENTRIES:
        return
    now = time.time()
    stale = [s for s, (t, _) in _quote_cache.items() if now - t > _QUOTE_CACHE_MAX_AGE_SECONDS]
    for symbol in stale:
        del _quote_cache[symbol]
    if len(_quote_cache) > _QUOTE_CACHE_MAX_ENTRIES:
        for symbol in sorted(_quote_cache, key=lambda s: _quote_cache[s][0])[: len(_quote_cache) - _QUOTE_CACHE_MAX_ENTRIES]:
            del _quote_cache[symbol]


def _round(value: float | None, digits: int = 4) -> float | None:
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return round(number, digits)


_ALLOWED_SYMBOLS: set[str] = set(SYMBOLS) | CRYPTO_SYMBOLS


def _validate_symbol(symbol: str) -> str:
    normalized = symbol.upper().strip()
    aliases = {"BTC": "BTC-USD", "ETH": "ETH-USD"}
    normalized = aliases.get(normalized, normalized)
    if normalized not in _ALLOWED_SYMBOLS:
        raise HTTPException(status_code=404, detail=f"Unsupported symbol: {symbol}")
    return normalized


def _resolve_symbols(symbols: str | None) -> list[str]:
    raw = symbols.split(",") if symbols else SYMBOLS
    resolved: list[str] = []
    for chunk in raw:
        chunk = chunk.strip()
        if not chunk:
            continue
        normalized = chunk.upper()
        aliases = {"BTC": "BTC-USD", "ETH": "ETH-USD"}
        normalized = aliases.get(normalized, normalized)
        if normalized in _ALLOWED_SYMBOLS and normalized not in resolved:
            resolved.append(normalized)
        if len(resolved) >= 64:
            break
    return resolved or list(SYMBOLS)


async def _fetch_json(
    client: httpx.AsyncClient, url: str, params: dict[str, Any] | None = None
) -> Any:
    response = await client.get(url, params=params, headers=UPSTREAM_HEADERS)
    response.raise_for_status()
    return response.json()


async def _polymarket_price_to_beat(
    client: httpx.AsyncClient, *, slug: str, interval: str, window_start: int, window_end: int
) -> dict[str, Any] | None:
    """Read Polymarket's own immutable opening value once per active market.

    RTDS deliberately has no TWAP replay, so a process that begins after a
    window opens cannot reconstruct its opening report from later values. This
    public Polymarket endpoint supplies the page's price-to-beat; RTDS remains
    the low-latency source for every live update after that point.
    """
    now = time.time()
    cached = _polymarket_ptb_cache.get(slug)
    if cached and (cached[1] is not None or now - cached[0] < 3):
        return cached[1]

    variant = {"5m": "five", "15m": "fifteen"}.get(interval)
    if not variant:
        return None
    to_iso = lambda timestamp: datetime.fromtimestamp(timestamp, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        response = await client.get(
            POLYMARKET_CRYPTO_PRICE_URL,
            params={
                "symbol": "BTC",
                "eventStartTime": to_iso(window_start),
                "variant": variant,
                "endDate": to_iso(window_end),
            },
            headers={**UPSTREAM_HEADERS, "Referer": "https://polymarket.com/"},
            timeout=httpx.Timeout(3),
        )
        response.raise_for_status()
        payload = response.json()
        open_price = _polymarket_float(payload.get("openPrice") if isinstance(payload, dict) else None)
        if open_price is None or open_price <= 0:
            raise ValueError("Polymarket crypto price response has no opening price")
        reference = {
            "price": open_price,
            "timestampMs": window_start * 1000,
            "ageMs": 0,
            "ready": True,
            "quality": "polymarket_price_to_beat",
            "source": "Polymarket crypto-price API",
        }
        _polymarket_ptb_cache[slug] = (now, reference)
        return reference
    except (httpx.HTTPError, ValueError, TypeError, json.JSONDecodeError):
        _polymarket_ptb_cache[slug] = (now, None)
        return None


def _fetch_yahoo_json_sync(url: str, params: dict[str, str]) -> Any:
    full_url = f"{url}?{urlencode(params)}"
    request = Request(full_url, headers=UPSTREAM_HEADERS)
    try:
        with urlopen(request, timeout=HTTP_TIMEOUT) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        raise OSError(f"upstream HTTP {exc.code} for {url}") from exc
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
        if timestamp is None:
            continue
        try:
            ts = int(timestamp)
        except (TypeError, ValueError):
            continue
        if ts < 0 or ts > 4102444800:
            continue
        close = close_values[index] if index < len(close_values) else None
        open_price = open_values[index] if index < len(open_values) else None
        high = high_values[index] if index < len(high_values) else None
        low = low_values[index] if index < len(low_values) else None
        if close is None or open_price is None or high is None or low is None:
            continue
        try:
            time_iso = datetime.fromtimestamp(ts, timezone.utc).isoformat()
        except (OverflowError, OSError, ValueError):
            continue
        candles.append(
            {
                "timestamp": ts,
                "time": time_iso,
                "open": _round(float(open_price), 4),
                "high": _round(float(high), 4),
                "low": _round(float(low), 4),
                "close": _round(float(close), 4),
                "volume": int(volume_values[index] or 0) if index < len(volume_values) else 0,
            }
        )
    candles.sort(key=lambda candle: candle["timestamp"])

    price = meta.get("regularMarketPrice")
    previous_close = meta.get("chartPreviousClose") or meta.get("previousClose")
    change = None
    change_percent = None
    if price is not None and previous_close:
        try:
            change = float(price) - float(previous_close)
            change_percent = (change / float(previous_close)) * 100
        except (TypeError, ValueError):
            change = None
            change_percent = None
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
        "candles": candles,
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
                "timestamp": timestamp,
                "time": datetime.fromtimestamp(timestamp, timezone.utc).isoformat(),
                "open": _round(float(open_price), 4),
                "high": _round(float(high), 4),
                "low": _round(float(low), 4),
                "close": _round(float(close), 4),
                "volume": _round(float(volume), 6),
            }
        )
    return sorted(candles, key=lambda candle: candle["time"])


def _interval_seconds(interval: str) -> int:
    if interval not in SUPPORTED_INTERVALS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported interval. Use one of: {', '.join(SUPPORTED_INTERVALS)}",
        )
    return SUPPORTED_INTERVALS[interval]


def _aggregate_candles(candles: list[dict[str, Any]], interval_seconds: int, tz_offset_minutes: int = 0) -> list[dict[str, Any]]:
    if not candles:
        return []
    
    tz_offset_sec = tz_offset_minutes * 60
    aggregated = {}
    for c in candles:
        t_time = int(c["timestamp"])
        shifted = t_time - tz_offset_sec
        b_time = (shifted // interval_seconds) * interval_seconds + tz_offset_sec
        
        if b_time not in aggregated:
            aggregated[b_time] = {
                "timestamp": b_time,
                "time": datetime.fromtimestamp(b_time, timezone.utc).isoformat(),
                "open": c["open"],
                "high": c["high"],
                "low": c["low"],
                "close": c["close"],
                "volume": c["volume"]
            }
        else:
            b = aggregated[b_time]
            b["high"] = max(b["high"], c["high"])
            b["low"] = min(b["low"], c["low"])
            b["close"] = c["close"]
            b["volume"] += c["volume"]
            
    return sorted(aggregated.values(), key=lambda x: x["timestamp"])


async def _candles_for_symbol(symbol: str, interval: str, tz_offset_minutes: int = 0) -> dict[str, Any]:
    interval_seconds = _interval_seconds(interval)
    started = time.perf_counter()

    if symbol in CRYPTO_SYMBOLS:
        granularity = interval_seconds if interval_seconds in COINBASE_GRANULARITIES else 60
        try:
            payload = await _coinbase_fetch(
                COINBASE_CANDLES_URL.format(symbol=symbol),
                {"granularity": str(granularity)},
            )
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Coinbase candles failed: {exc}") from exc
        candles = _parse_coinbase_candles(payload)
        if granularity != interval_seconds:
            candles = _aggregate_candles(candles, interval_seconds, tz_offset_minutes)
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

    fetch_interval = interval
    range_param = "1d"
    
    if interval == "1m":
        range_param = "1d"
    elif interval == "5m" or interval == "15m":
        range_param = "5d"
    elif interval == "1h":
        range_param = "1mo"
    elif interval == "6h":
        fetch_interval = "1h"
        range_param = "3mo"
    elif interval == "1d":
        range_param = "1y"
        
    if fetch_interval not in YAHOO_INTERVALS:
        raise HTTPException(status_code=400, detail="Yahoo equity feed does not support this interval")
    try:
        payload = await _fetch_yahoo_json(
            YAHOO_CHART_URL.format(symbol=symbol),
            {"range": range_param, "interval": fetch_interval, "includePrePost": "false"},
        )
        parsed = _parse_yahoo_chart(symbol, payload)
        candles = parsed.get("candles", [])
        if fetch_interval != interval:
            candles = _aggregate_candles(candles, interval_seconds, tz_offset_minutes)
    except (ValueError, OSError, subprocess.SubprocessError) as exc:
        raise HTTPException(status_code=502, detail=f"Yahoo candles failed: {exc}") from exc
    return {
        "symbol": symbol,
        "interval": interval,
        "intervalSeconds": interval_seconds,
        "candles": candles,
        "source": "Yahoo Finance Chart API",
        "feed": "real delayed equity OHLC bars",
        "isRealtime": False,
        "latencyMs": round((time.perf_counter() - started) * 1000),
        "fetchedAt": _now_iso(),
    }


def _day_stats_from_candles(rows: list[list[float]]) -> tuple[float | None, float | None, float | None, float]:
    """Derive session open/high/low/volume from Coinbase 60s candle rows
    (timestamp, low, high, open, close, volume) without the strictly
    rate-limited /stats and non-60 granularity endpoints."""
    ordered = sorted(rows, key=lambda r: r[0])
    if not ordered:
        return None, None, None, 0.0
    open_price = float(ordered[0][3])
    high = float(max(r[2] for r in ordered))
    low = float(min(r[1] for r in ordered))
    volume = float(sum(r[5] for r in ordered))
    return open_price, high, low, volume


async def _coinbase_quote(symbol: str) -> dict[str, Any]:
    started = time.perf_counter()
    ticker_res, candles_res = await asyncio.gather(
        _coinbase_fetch(COINBASE_TICKER_URL.format(symbol=symbol), {}),
        _coinbase_fetch(COINBASE_CANDLES_URL.format(symbol=symbol), {"granularity": "60"}),
        return_exceptions=True,
    )
    latency_ms = round((time.perf_counter() - started) * 1000)
    if isinstance(ticker_res, BaseException) or not isinstance(ticker_res, dict) or "price" not in ticker_res:
        raise OSError("Coinbase ticker unavailable")
    ticker = ticker_res
    candles_payload = candles_res if isinstance(candles_res, list) else []
    price = float(ticker["price"])
    open_24h, high_24h, low_24h, volume_24h = _day_stats_from_candles(candles_payload)
    if open_24h is None:
        open_24h = price
        high_24h = price
        low_24h = price
        volume_24h = float(ticker.get("volume") or 0)
    change = price - open_24h
    change_percent = (change / open_24h) * 100 if open_24h else None

    return {
        "symbol": symbol,
        "name": CRYPTO_NAMES.get(symbol, symbol),
        "assetClass": "crypto",
        "price": _round(price, 4),
        "bid": _round(float(ticker["bid"]), 4),
        "ask": _round(float(ticker["ask"]), 4),
        "change": _round(change, 4),
        "changePercent": _round(change_percent, 2),
        "previousClose": _round(open_24h, 4),
        "dayHigh": _round(high_24h, 4),
        "dayLow": _round(low_24h, 4),
        "volume": _round(volume_24h, 6),
        "currency": "USD",
        "exchange": "Coinbase Exchange",
        "marketState": "LIVE_24_7",
        "regularMarketTime": ticker.get("time"),
        "lastTradeTime": ticker.get("time"),
        "lastTradeId": ticker.get("trade_id"),
        "lastSize": _round(float(ticker["size"]), 8),
        "candles": _parse_coinbase_candles(candles_payload) if candles_payload else [],
        "source": "Coinbase Exchange ticker/candles",
        "feed": "real-time crypto trades",
        "isRealtime": True,
        "latencyMs": latency_ms,
        "fetchedAt": _now_iso(),
    }


async def _quote_for_symbol(symbol: str, use_cache: bool = True) -> dict[str, Any]:
    ttl = CRYPTO_CACHE_TTL_SECONDS if symbol in CRYPTO_SYMBOLS else EQUITY_CACHE_TTL_SECONDS
    cached = _quote_cache.get(symbol)
    if use_cache and cached and time.time() - cached[0] < ttl:
        return dict(cached[1])

    try:
        if symbol in CRYPTO_SYMBOLS:
            async with _crypto_fetch_semaphore:
                parsed = await _coinbase_quote(symbol)
        else:
            async with _equity_fetch_lock:
                await asyncio.sleep(0.12)
                payload = await _fetch_yahoo_json(
                    YAHOO_CHART_URL.format(symbol=symbol),
                    {"range": "1d", "interval": "5m"},
                )
            parsed = _parse_yahoo_chart(symbol, payload)
        if use_cache:
            _quote_cache[symbol] = (time.time(), dict(parsed))
            _evict_quote_cache()
        return parsed
    except (httpx.HTTPError, ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError) as exc:
        if cached:
            return {**dict(cached[1]), "stale": True, "error": "upstream error", "fetchedAt": _now_iso()}
        return {
            "symbol": symbol,
            "assetClass": "crypto" if symbol in CRYPTO_SYMBOLS else "equity",
            "price": None,
            "change": None,
            "changePercent": None,
            "candles": [],
            "error": "upstream unavailable",
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

    action = "Buy" if trend_score > 0 else "Sell" if trend_score < 0 else "Hold"
    confidence = min(92, 50 + abs(trend_score) * 14 + (8 if detail.get("isRealtime") else 0))
    latest_time = detail.get("lastTradeTime") or detail.get("regularMarketTime")

    target_price = None
    if price is not None and volatility is not None:
        if action == "Buy":
            target_price = price * (1 + (volatility / 100))
        elif action == "Sell":
            target_price = price * (1 - (volatility / 100))

    return {
        "symbol": detail["symbol"],
        "method": "EMA(9/21), RSI(14), VWAP, short-horizon realized volatility",
        "horizon": "next few ticks for crypto; next delayed bar for equities",
        "action": action,
        "targetPrice": _round(target_price, 4),
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
    return {
        key: value
        for key, value in detail.items()
        if key not in {"candles", "signals", "_local_fetch_time"}
    }


def _market_clock() -> dict[str, Any]:
    return {
        "now": _now_iso(),
        "crypto": "Coinbase market streams tick live 24/7.",
        "equities": "Public Yahoo equity quotes are delayed/last-sale; true no-delay equities require a licensed feed.",
    }


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "trader-desk-api", "time": _now_iso()}


@app.post("/api/bot-runs")
async def save_bot_run(payload: dict[str, Any]) -> dict[str, Any]:
    run_id = str(payload.get("id") or f"run_{datetime.now().strftime('%Y%m%d_%H%M%S')}")
    safe_id = "".join(ch for ch in run_id if ch.isalnum() or ch in {"-", "_"}).strip("-_")
    if not safe_id:
        safe_id = f"run_{datetime.now().strftime('%Y%m%d_%H%M%S')}"

    audit = payload.get("audit") or {}
    if not isinstance(audit, dict):
        audit = {}
    if len(json.dumps(payload, default=str)) > 2 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="bot run payload too large")

    BOT_RUN_LOG_DIR.mkdir(parents=True, exist_ok=True)
    json_path = BOT_RUN_LOG_DIR / f"{safe_id}.json"
    jsonl_path = BOT_RUN_LOG_DIR / f"{safe_id}.jsonl"

    tmp_json = json_path.with_suffix(".json.tmp")
    tmp_json.write_text(json.dumps(payload, indent=2, sort_keys=True, default=str), encoding="utf-8")
    tmp_json.replace(json_path)

    jsonl_lines: list[str] = []
    for mode, rows in audit.items():
        if not isinstance(rows, list):
            continue
        for row in rows:
            if isinstance(row, dict):
                jsonl_lines.append(json.dumps({"runId": safe_id, "mode": mode, **row}, sort_keys=True, default=str))
    tmp_jsonl = jsonl_path.with_suffix(".jsonl.tmp")
    tmp_jsonl.write_text("\n".join(jsonl_lines) + ("\n" if jsonl_lines else ""), encoding="utf-8")
    tmp_jsonl.replace(jsonl_path)

    return {"status": "saved", "id": safe_id, "json": str(json_path), "jsonl": str(jsonl_path)}


def _polymarket_token_ids(market: dict[str, Any]) -> list[str]:
    raw = market.get("clobTokenIds") or market.get("clob_token_ids") or []
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            raw = [part.strip() for part in raw.split(",") if part.strip()]
    return [str(token) for token in raw if token][:2]


def _polymarket_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _polymarket_book_summary(book: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(book, dict):
        return {"bid": None, "ask": None, "mid": None, "spread": None, "last": None, "bids": [], "asks": []}
    bids = book.get("bids") or []
    asks = book.get("asks") or []
    bid = _polymarket_float(bids[0].get("price")) if bids and isinstance(bids[0], dict) else None
    ask = _polymarket_float(asks[0].get("price")) if asks and isinstance(asks[0], dict) else None
    return {
        "bid": bid,
        "ask": ask,
        "mid": (bid + ask) / 2 if bid is not None and ask is not None else _polymarket_float(book.get("last_trade_price")),
        "spread": ask - bid if bid is not None and ask is not None else None,
        "last": _polymarket_float(book.get("last_trade_price")),
        "bids": bids[:5],
        "asks": asks[:5],
        "minOrderSize": _polymarket_float(book.get("min_order_size")),
        "tickSize": _polymarket_float(book.get("tick_size")),
    }


async def _polymarket_btc_snapshot() -> dict[str, Any]:
    global _polymarket_cache
    now = time.time()
    if _polymarket_cache and now - _polymarket_cache[0] < 1.0:
        return _polymarket_cache[1]

    async with _polymarket_cache_lock:
        now = time.time()
        if _polymarket_cache and now - _polymarket_cache[0] < 1.0:
            return _polymarket_cache[1]

        started = time.perf_counter()
        client = await _shared_client()
        specs = [("5m", 300), ("15m", 900)]
        slugs = []
        for interval, seconds in specs:
            base = (int(now) // seconds) * seconds
            slugs.extend((interval, base, f"btc-updown-{interval}-{base}"))
            slugs.extend((interval, base + seconds, f"btc-updown-{interval}-{base + seconds}"))

        async def fetch_market(interval: str, window_start: int, slug: str) -> dict[str, Any] | None:
            try:
                payload = await _fetch_json(client, f"{POLYMARKET_GAMMA_URL}/markets", {"slug": slug})
                market = payload[0] if isinstance(payload, list) and payload else None
                if not isinstance(market, dict) or market.get("closed") is True:
                    return None
                token_ids = _polymarket_token_ids(market)
                if len(token_ids) < 2:
                    return None
                description = market.get("description") or ""
                description_lower = str(description).lower()
                requires_exact_twap = "twap" in description_lower or "time-weighted average price" in description_lower
                twap_window_seconds = 30 if interval == "5m" else 60
                exact_twap = _chainlink_twap_snapshot(twap_window_seconds)
                return {
                    "interval": interval,
                    "windowStart": window_start,
                    "windowEnd": window_start + (300 if interval == "5m" else 900),
                    "slug": slug,
                    "question": market.get("question") or slug,
                    "description": description,
                    "resolutionSource": market.get("resolutionSource"),
                    "settlement": {
                        "requiresExactTwap": requires_exact_twap,
                        "exactFeedConnected": bool(exact_twap.get("exact")) if requires_exact_twap else True,
                        "source": market.get("resolutionSource"),
                        "windowSeconds": twap_window_seconds,
                        "feedStatus": exact_twap.get("status") if requires_exact_twap else "not_required",
                        "feedError": exact_twap.get("error") if requires_exact_twap else None,
                    },
                    "conditionId": market.get("conditionId"),
                    "tokenIds": token_ids,
                    "outcomes": market.get("outcomes"),
                    "outcomePrices": market.get("outcomePrices"),
                    "active": bool(market.get("active")),
                    "liquidity": _polymarket_float(market.get("liquidity")),
                    "volume": _polymarket_float(market.get("volume")),
                    "acceptingOrders": bool(market.get("acceptingOrders")),
                    "enableOrderBook": bool(market.get("enableOrderBook")),
                }
            except (httpx.HTTPError, ValueError, TypeError, KeyError, IndexError):
                return None

        fetched = await asyncio.gather(
            *(fetch_market(slugs[index], slugs[index + 1], slugs[index + 2]) for index in range(0, len(slugs), 3))
        )
        current_time = time.time()
        markets = [
            market for market in fetched
            if market and market.get("active") and float(market.get("windowEnd") or 0) > current_time
        ]
        selected: dict[str, dict[str, Any]] = {}
        for market in markets:
            current = selected.get(market["interval"])
            if current is None or market["windowStart"] < current["windowStart"]:
                selected[market["interval"]] = market
        markets = list(selected.values())

        references = await asyncio.gather(
            *(
                _polymarket_price_to_beat(
                    client,
                    slug=market["slug"],
                    interval=market["interval"],
                    window_start=market["windowStart"],
                    window_end=market["windowEnd"],
                )
                for market in markets
            )
        )
        references_by_slug = {market["slug"]: reference for market, reference in zip(markets, references)}

        token_ids = [token for market in markets for token in market["tokenIds"]]
        await _set_polymarket_clob_assets(token_ids)
        clob_quotes_by_token = {token: _polymarket_clob_quote(token) for token in token_ids}
        prices_by_token: dict[str, dict[str, Any]] = {}
        midpoints_by_token: dict[str, Any] = {}
        spreads_by_token: dict[str, Any] = {}
        # REST remains a cold-start/backstop path. Once the CLOB WebSocket has
        # a fresh top-of-book quote, avoid replacing it with a slower poll.
        if token_ids and any(quote is None for quote in clob_quotes_by_token.values()):
            requests = [
                client.post(
                    f"{POLYMARKET_CLOB_URL}/prices",
                    json=[
                        {"token_id": token, "side": side}
                        for token in token_ids
                        for side in ("BUY", "SELL")
                    ],
                    headers=UPSTREAM_HEADERS,
                ),
                client.post(
                    f"{POLYMARKET_CLOB_URL}/midpoints",
                    json=[{"token_id": token} for token in token_ids],
                    headers=UPSTREAM_HEADERS,
                ),
                client.post(
                    f"{POLYMARKET_CLOB_URL}/spreads",
                    json=[{"token_id": token} for token in token_ids],
                    headers=UPSTREAM_HEADERS,
                ),
            ]
            responses = await asyncio.gather(*requests, return_exceptions=True)
            if isinstance(responses[0], httpx.Response):
                try:
                    responses[0].raise_for_status()
                    payload = responses[0].json()
                    if isinstance(payload, dict):
                        prices_by_token = {str(token): value for token, value in payload.items() if isinstance(value, dict)}
                except (httpx.HTTPError, ValueError, TypeError):
                    prices_by_token = {}
            if isinstance(responses[1], httpx.Response):
                try:
                    responses[1].raise_for_status()
                    payload = responses[1].json()
                    if isinstance(payload, dict):
                        midpoints_by_token = payload
                except (httpx.HTTPError, ValueError, TypeError):
                    midpoints_by_token = {}
            if isinstance(responses[2], httpx.Response):
                try:
                    responses[2].raise_for_status()
                    payload = responses[2].json()
                    if isinstance(payload, dict):
                        spreads_by_token = payload
                except (httpx.HTTPError, ValueError, TypeError):
                    spreads_by_token = {}

        for market in markets:
            outcomes = {}
            for outcome, token in zip(("yes", "no"), market["tokenIds"]):
                prices = prices_by_token.get(token) or {}
                live_quote = clob_quotes_by_token.get(token) or {}
                # CLOB prices are named from the order's book side: BUY is
                # the best bid and SELL is the best ask. A paper BUY pays the
                # SELL-side ask; a paper SELL receives the BUY-side bid.
                bid = _polymarket_float(live_quote.get("bid")) if live_quote else _polymarket_float(prices.get("BUY"))
                ask = _polymarket_float(live_quote.get("ask")) if live_quote else _polymarket_float(prices.get("SELL"))
                mid = _polymarket_float(live_quote.get("mid")) if live_quote else _polymarket_float(midpoints_by_token.get(token))
                spread = _polymarket_float(live_quote.get("spread")) if live_quote else _polymarket_float(spreads_by_token.get(token))
                if spread is None and bid is not None and ask is not None:
                    spread = ask - bid
                outcomes[outcome] = {
                    "bid": bid,
                    "ask": ask,
                    "buyPrice": ask,
                    "sellPrice": bid,
                    "mid": mid if mid is not None else (bid + ask) / 2 if bid is not None and ask is not None else None,
                    "spread": spread,
                    "last": _polymarket_float(live_quote.get("last")) if live_quote else _polymarket_float(market.get("lastTradePrice")),
                    "minOrderSize": _polymarket_float(market.get("orderMinSize")) or 5,
                    "priceSource": live_quote.get("source") if live_quote else "Polymarket CLOB /prices + /midpoints",
                }
            market["yes"] = outcomes["yes"]
            market["no"] = outcomes["no"]
            market["secondsRemaining"] = max(0, market["windowEnd"] - time.time())
            market["stale"] = any(
                outcome["buyPrice"] is None or outcome["sellPrice"] is None or outcome["mid"] is None
                for outcome in outcomes.values()
            )
            twap_window_seconds = int(market["settlement"].get("windowSeconds") or 60)
            exact_twap = _chainlink_twap_snapshot(twap_window_seconds)
            market["feed"] = exact_twap
            market["settlement"]["exactFeedConnected"] = bool(exact_twap.get("exact"))
            market["settlement"]["feedStatus"] = exact_twap.get("status")
            market["settlement"]["feedError"] = exact_twap.get("error")
            market["reference"] = references_by_slug.get(market["slug"]) or _chainlink_twap_reference_price(
                market["windowStart"], twap_window_seconds
            )
            market["anchorReady"] = bool(market["reference"].get("ready"))

        # Keep every chart on the same source as its contract. TWAP markets
        # never mix the public RTDS spot proxy into their settlement chart.
        spot_history: dict[str, list[dict[str, float]]] = {}
        display_history: dict[str, list[dict[str, float]]] = {}
        now_ms = time.time() * 1000
        for market in markets:
            start_ms = float(market["windowStart"]) * 1000
            end_ms = min(float(market["windowEnd"]) * 1000, now_ms)
            twap_window_seconds = int(market["settlement"].get("windowSeconds") or 60)
            is_twap_market = bool(market["settlement"].get("requiresExactTwap"))
            settlement_history = _chainlink_twap_history.get(twap_window_seconds, []) if is_twap_market else _polymarket_chainlink_history
            points = [
                {"time": timestamp_ms, "price": price}
                for timestamp_ms, price in settlement_history
                if start_ms <= timestamp_ms <= end_ms and price > 0
            ]
            spot_history[market["slug"]] = points[-1_800:]
            display_points = [
                {"time": timestamp_ms, "price": price}
                for timestamp_ms, price in _binance_btc_history
                if start_ms <= timestamp_ms <= end_ms and price > 0
            ]
            display_history[market["slug"]] = display_points[-1_800:]

        # Kept for existing API consumers. Individual markets carry their
        # own feed because the 5m and 15m contracts use different TWAP windows.
        spot = _chainlink_twap_snapshot(60)
        display = _binance_btc_snapshot()
        clob_sources = [
            outcome.get("priceSource") == "Polymarket CLOB WebSocket"
            for market in markets
            for outcome in (market.get("yes"), market.get("no"))
            if isinstance(outcome, dict)
        ]
        clob_realtime = bool(clob_sources) and all(clob_sources)
        snapshot = {
            "fetchedAt": _now_iso(),
            "source": "Polymarket Gamma + CLOB prices + public Polymarket RTDS Chainlink TWAP",
            "latencyMs": round((time.perf_counter() - started) * 1000),
            "spot": {
                "price": spot.get("price"),
                "timestampMs": spot.get("timestampMs"),
                "receivedAtMs": spot.get("receivedAtMs"),
                "ageMs": spot.get("ageMs"),
                "source": spot.get("source"),
                "stale": bool(spot.get("stale")),
                "exact": bool(spot.get("exact")),
                "feedId": spot.get("feedId"),
                "status": spot.get("status"),
                "error": spot.get("error"),
            },
            "display": display,
            "lead": display,
            "clob": {"realtime": clob_realtime, "source": "Polymarket CLOB WebSocket" if clob_realtime else "Polymarket CLOB REST backstop"},
            "spotHistory": spot_history,
            "displayHistory": display_history,
            "markets": sorted(markets, key=lambda market: {"5m": 0, "15m": 1}.get(market["interval"], 9)),
        }
        _polymarket_cache = (time.time(), snapshot)
        return snapshot


@app.on_event("startup")
async def start_polymarket_rtds() -> None:
    global _polymarket_rtds_task, _binance_btc_task, _polymarket_clob_task, _chainlink_twap_task
    _load_polymarket_chainlink_history()
    _load_chainlink_twap_history()
    if _polymarket_rtds_task is None or _polymarket_rtds_task.done():
        _polymarket_rtds_task = asyncio.create_task(_polymarket_rtds_loop())
    if _binance_btc_task is None or _binance_btc_task.done():
        _binance_btc_task = asyncio.create_task(_binance_btc_loop())
    if _polymarket_clob_task is None or _polymarket_clob_task.done():
        _polymarket_clob_task = asyncio.create_task(_polymarket_clob_loop())
    if _chainlink_twap_task is None or _chainlink_twap_task.done():
        _chainlink_twap_task = asyncio.create_task(_chainlink_twap_loop())


@app.on_event("shutdown")
async def stop_polymarket_rtds() -> None:
    global _polymarket_rtds_task, _binance_btc_task, _polymarket_clob_task, _chainlink_twap_task
    for task in (_polymarket_rtds_task, _binance_btc_task, _polymarket_clob_task, _chainlink_twap_task):
        if task:
            task.cancel()
    for task in (_polymarket_rtds_task, _binance_btc_task, _polymarket_clob_task, _chainlink_twap_task):
        if task:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
    _polymarket_rtds_task = None
    _binance_btc_task = None
    _polymarket_clob_task = None
    _chainlink_twap_task = None


@app.get("/api/polymarket/btc")
async def polymarket_btc() -> dict[str, Any]:
    try:
        return await _polymarket_btc_snapshot()
    except (httpx.HTTPError, ValueError, TypeError, OSError) as exc:
        raise HTTPException(status_code=502, detail=f"Polymarket market data failed: {exc}") from exc


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
    target_symbols = _resolve_symbols(symbols)
    details = await asyncio.gather(
        *(_quote_for_symbol(symbol) for symbol in target_symbols), return_exceptions=True
    )
    return {
        "symbols": target_symbols,
        "quotes": [
            _compact_quote(detail)
            for detail in details
            if isinstance(detail, dict) and detail.get("price") is not None
        ],
        "marketClock": _market_clock(),
        "fetchedAt": _now_iso(),
    }


@app.get("/api/desk")
async def desk(symbols: str | None = None) -> dict[str, Any]:
    global _desk_rotate_cursor
    target_symbols = _resolve_symbols(symbols)

    async with _desk_rotate_lock:
        stale = [symbol for symbol in target_symbols if not _quote_is_fresh(symbol)]
        if stale:
            cursor = _desk_rotate_cursor % len(stale)
            rotated = stale[cursor:] + stale[:cursor]
            refresh_batch = set(rotated[:_DESK_REFRESH_BUDGET])
            _desk_rotate_cursor = (cursor + len(refresh_batch)) % max(len(stale), 1)
        else:
            refresh_batch = set()

    details = await asyncio.gather(
        *(_desk_quote_for_symbol(symbol, symbol in refresh_batch) for symbol in target_symbols),
        return_exceptions=True,
    )
    compact = [
        _compact_quote(detail) for detail in details if isinstance(detail, dict) and detail.get("price") is not None
    ]

    def change_percent_key(quote: dict[str, Any]) -> float:
        value = quote.get("changePercent")
        if value is None:
            return 0.0
        try:
            return float(value)
        except (TypeError, ValueError):
            return 0.0

    valid = [quote for quote in compact if change_percent_key(quote) != 0.0 or quote.get("change") not in (None, 0)]
    advancers = sum(1 for quote in compact if (quote.get("change") or 0) > 0)
    decliners = sum(1 for quote in compact if (quote.get("change") or 0) < 0)
    leader = max(valid, key=change_percent_key, default=None)
    laggard = min(valid, key=change_percent_key, default=None)
    total_notional = sum((quote.get("price") or 0) * (quote.get("volume") or 0) for quote in compact)
    signals = [_signals_from_detail(detail) for detail in details if isinstance(detail, dict) and detail.get("candles")]

    alerts: list[dict[str, Any]] = []
    for detail in compact:
        signals_for_alert = _signals_from_detail(detail) if detail.get("candles") else None
        action = (signals_for_alert or {}).get("action", "Hold") if signals_for_alert else "HOLD"
        change_percent = change_percent_key(detail)
        alerts.append(
            {
                "level": "live" if detail.get("isRealtime") else "delayed",
                "symbol": detail.get("symbol", "?"),
                "message": (
                    f"{detail.get('symbol', '?')} [{str(action).upper()}] "
                    f"{change_percent:+.2f}% | "
                    f"{detail.get('feed')} | last {detail.get('lastTradeTime') or 'n/a'}"
                ),
                "changePercent": change_percent,
            }
        )
    alerts.sort(key=lambda item: abs(item["changePercent"]), reverse=True)

    return {
        "symbols": target_symbols,
        "quotes": compact,
        "pulse": {
            "advancers": advancers,
            "decliners": decliners,
            "unchanged": max(len(compact) - advancers - decliners, 0),
            "leader": leader,
            "laggard": laggard,
            "notionalVolume": round(total_notional, 2),
            "riskTone": "risk-on" if advancers >= decliners else "risk-off",
            "liveFeeds": sum(1 for quote in compact if quote.get("isRealtime")),
        },
        "signals": signals,
        "alerts": alerts[:6],
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
async def candles(symbol: str, interval: str = "1m", tz: int = 0) -> dict[str, Any]:
    normalized = _validate_symbol(symbol)
    return await _candles_for_symbol(normalized, interval, tz)


async def _stream_stock_ticks(symbol: str):
    last_quote = None
    target_price = None
    current_price = None
    volatility = 0.0005 # 0.05%

    while symbol in hft_manager.active_connections:
        try:
            # Poll Yahoo Finance every 5 seconds for the anchor price
            if not last_quote or (time.time() - last_quote.get("_local_fetch_time", 0)) > 5.0:
                quote = await _quote_for_symbol(symbol, use_cache=False)
                quote["_local_fetch_time"] = time.time()
                last_quote = quote

                new_target = quote.get("price")
                if new_target is not None:
                    target_price = new_target
                    if current_price is None:
                        current_price = target_price

            # Simulate Brownian motion HFT micro-ticks towards the target
            if current_price is not None and target_price is not None:
                # Move slightly towards target + random jitter
                diff = target_price - current_price
                jitter = current_price * volatility * (random.uniform(-1, 1))
                current_price += (diff * 0.2) + jitter

                tick_msg = {
                    "symbol": symbol,
                    "price": round(current_price, 4),
                    "bid": round(current_price * 0.9999, 4),
                    "ask": round(current_price * 1.0001, 4),
                    "lastTradeTime": _now_iso(),
                    "volume": last_quote.get("volume", 0) if last_quote else 0,
                    "isSimulated": True
                }
                await hft_manager.broadcast(symbol, tick_msg)
        except Exception as e:
            print(f"Error streaming {symbol}: {e}")

        # Emit ~5 ticks per second
        await asyncio.sleep(0.2)

    if symbol in hft_manager.streaming_tasks:
        del hft_manager.streaming_tasks[symbol]

@app.websocket("/api/ws/quotes/{symbol}")
async def ws_quotes(websocket: WebSocket, symbol: str):
    normalized = _validate_symbol(symbol)
    await hft_manager.connect(websocket, normalized)

    # Start the HFT background streamer if not already running for this symbol
    if normalized not in hft_manager.streaming_tasks:
        task = asyncio.create_task(_stream_stock_ticks(normalized))
        hft_manager.streaming_tasks[normalized] = task

    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        hft_manager.disconnect(websocket, normalized)

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

    client = await _shared_client()
    await _coinbase_limiter.acquire()
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

    client = await _shared_client()
    await _coinbase_limiter.acquire()
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
                if websocket.client_state.name != "CONNECTED":
                    break
                try:
                    message = json.loads(raw_message)
                except (json.JSONDecodeError, TypeError):
                    continue
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
    except ConnectionClosed:
        return
    except Exception:
        try:
            await websocket.send_json({"type": "error", "symbol": normalized, "message": "stream unavailable"})
        except Exception:
            return


@app.get("/api/search")
async def search(q: str):
    url = "https://query2.finance.yahoo.com/v1/finance/search"
    try:
        data = await _fetch_yahoo_json(url, {"q": q, "quotesCount": "15", "newsCount": "0"})
        quotes = data.get("quotes", [])
        return {
            "results": [
                {
                    "symbol": item.get("symbol"),
                    "name": item.get("shortname") or item.get("longname"),
                    "exchange": item.get("exchDisp") or item.get("exchange"),
                    "type": item.get("quoteType")
                }
                for item in quotes if item.get("symbol")
            ]
        }
    except Exception:
        return {"results": []}

@app.get("/api/news/{symbol}")
async def get_news(symbol: str):
    url = "https://query2.finance.yahoo.com/v1/finance/search"
    try:
        data = await _fetch_yahoo_json(url, {"q": symbol, "quotesCount": "0", "newsCount": "8"})
        news = data.get("news", [])
        
        parsed_news = []
        for item in news:
            title = item.get("title", "")
            if not title:
                continue
            
            summary = ""
            if "description" in item:
                summary = item["description"]
            
            related = item.get("relatedTickers", [])
            primary_ticker = related[0] if related else symbol

            # Simple keyword-based sentiment for demonstration
            title_lower = title.lower()
            sentiment = "neutral"
            if any(word in title_lower for word in ["up", "jump", "gain", "rise", "soar", "beat", "buy", "bull"]):
                sentiment = "positive"
            elif any(word in title_lower for word in ["down", "drop", "fall", "plunge", "miss", "sell", "bear"]):
                sentiment = "negative"
                
            parsed_news.append({
                "title": title,
                "publisher": item.get("publisher", "Yahoo Finance"),
                "link": item.get("link", "#"),
                "time": item.get("providerPublishTime"),
                "summary": summary,
                "sentiment": sentiment,
                "ticker": primary_ticker
            })
            
        # Fetch quotes for all tickers concurrently
        unique_tickers = list({item["ticker"] for item in parsed_news})
        quotes = await asyncio.gather(*(_quote_for_symbol(t) for t in unique_tickers), return_exceptions=True)
        quote_map = {t: (q.get("changePercent") if isinstance(q, dict) else None) for t, q in zip(unique_tickers, quotes)}

        for item in parsed_news:
            item["tickerChange"] = quote_map.get(item["ticker"])

        return {"news": parsed_news}
    except Exception:
        return {"news": []}

frontend_dir = Path(__file__).resolve().parents[1] / "frontend"
if frontend_dir.exists():
    app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")
