import asyncio
import json
import random
import time
from typing import Dict, Set
from fastapi import WebSocket

class HFTWebSocketManager:
    def __init__(self):
        self.active_connections: Dict[str, Set[WebSocket]] = {}
        self.streaming_tasks: Dict[str, asyncio.Task] = {}

    async def connect(self, websocket: WebSocket, symbol: str):
        await websocket.accept()
        if symbol not in self.active_connections:
            self.active_connections[symbol] = set()
        self.active_connections[symbol].add(websocket)

    def disconnect(self, websocket: WebSocket, symbol: str):
        if symbol in self.active_connections:
            self.active_connections[symbol].discard(websocket)
            if not self.active_connections[symbol]:
                del self.active_connections[symbol]

    async def broadcast(self, symbol: str, message: dict):
        if symbol in self.active_connections:
            websockets_to_remove = set()
            msg_str = json.dumps(message)
            for connection in self.active_connections[symbol]:
                try:
                    await connection.send_text(msg_str)
                except Exception:
                    websockets_to_remove.add(connection)
            for connection in websockets_to_remove:
                self.disconnect(connection, symbol)

hft_manager = HFTWebSocketManager()
