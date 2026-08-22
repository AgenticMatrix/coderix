"""CoderixSDKClient — a long-lived SDK client.

Mirrors claude-code-sdk's ``ClaudeSDKClient``: one persistent ``coderix
--sdk`` subprocess across multiple ``query()`` calls, with runtime control
via ``set_permission_mode()`` and ``interrupt()``.

Queries are sequential: a second ``query()`` call while one is in flight
raises. This keeps result-stream demultiplexing trivial for v1.
"""

from __future__ import annotations

import asyncio
from typing import Any, AsyncIterable, AsyncIterator, Dict, Optional, Union

from ._transport import (
    spawn,
    write_user,
    write_control,
    close_stdin,
    extract_text,
    iter_messages,
)


class CoderixSDKClient:
    def __init__(self, *, options: Optional[Dict[str, Any]] = None):
        self._options = dict(options or {})
        self._proc = None
        self._init_message: Optional[Dict[str, Any]] = None
        self._init_yielded = False
        self._in_flight = False
        self._write_lock = asyncio.Lock()

    async def connect(self) -> None:
        """Spawn the subprocess and consume the leading `init` message."""
        if self._proc is not None:
            return
        self._proc = await spawn(self._options)
        # The CLI emits `init` immediately on startup.
        self._init_message = None
        assert self._proc.stdout is not None
        first = await self._proc.stdout.readline()
        if first:
            import json

            try:
                self._init_message = json.loads(first)
            except json.JSONDecodeError:
                self._init_message = None

    async def _ensure_connected(self) -> None:
        if self._proc is None:
            await self.connect()

    async def _send(self, obj: Dict[str, Any]) -> None:
        import json

        assert self._proc is not None and self._proc.stdin is not None
        async with self._write_lock:
            self._proc.stdin.write((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
            await self._proc.stdin.drain()

    async def query(
        self,
        *,
        prompt: Union[str, AsyncIterable[Dict[str, Any]]],
        options: Optional[Dict[str, Any]] = None,
    ) -> AsyncIterator[Dict[str, Any]]:
        """Run a query against the connected engine, yielding SDK messages."""
        if self._in_flight:
            raise RuntimeError("A query is already in flight; await it before starting another.")
        await self._ensure_connected()
        assert self._proc is not None

        self._in_flight = True
        try:
            if self._init_message is not None and not self._init_yielded:
                self._init_yielded = True
                yield self._init_message

            if isinstance(prompt, str):
                if prompt:
                    await self._send(
                        {"type": "user", "message": {"role": "user", "content": prompt}}
                    )
            else:
                async for msg in prompt:
                    text = extract_text(msg)
                    if text:
                        await self._send(
                            {"type": "user", "message": {"role": "user", "content": text}}
                        )

            # Read messages until the terminal `result` for this query.
            async for message in iter_messages(self._proc):
                yield message
                if message.get("type") == "result":
                    break
        finally:
            self._in_flight = False

    async def set_permission_mode(self, mode: str) -> None:
        """Change the permission mode (applies to the current / next turn)."""
        await self._ensure_connected()
        await self._send({"type": "control_request", "request": {"subtype": "set_permission_mode", "mode": mode}})

    async def interrupt(self) -> None:
        """Interrupt the currently running turn."""
        await self._ensure_connected()
        await self._send({"type": "control_request", "request": {"subtype": "interrupt"}})

    async def disconnect(self) -> None:
        """Close stdin and wait for the subprocess to exit."""
        if self._proc is not None:
            await close_stdin(self._proc)
            try:
                await asyncio.wait_for(self._proc.wait(), timeout=5)
            except asyncio.TimeoutError:
                self._proc.kill()
                await self._proc.wait()
            self._proc = None
            self._init_message = None
            self._init_yielded = False

    async def __aenter__(self) -> "CoderixSDKClient":
        await self.connect()
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.disconnect()
