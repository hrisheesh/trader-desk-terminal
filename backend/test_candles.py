import asyncio
from httpx import AsyncClient
from main import _candles_for_symbol

async def main():
    async with AsyncClient() as client:
        print("Fetching 1h BTC-USD")
        res = await _candles_for_symbol("BTC-USD", "1h", -330)
        print(f"Got {len(res['candles'])} candles")
        if res['candles']:
            print(res['candles'][0])
            print(res['candles'][-1])

        print("Fetching 2m BTC-USD")
        res2 = await _candles_for_symbol("BTC-USD", "2m", -330)
        print(f"Got {len(res2['candles'])} candles")
        if res2['candles']:
            print(res2['candles'][0])
            print(res2['candles'][-1])

asyncio.run(main())
