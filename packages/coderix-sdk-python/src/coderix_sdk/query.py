"""One-shot ``query()`` — the top-level SDK entry point.

Mirrors claude-code-sdk's ``query({ prompt, options })`` async generator::

    async for message in query(prompt="Say hello"):
        print(message)

Each call spawns a fresh ``coderix --sdk`` subprocess, streams the user
prompt, and yields ``system``/``assistant``/``user``/``stream_event``
messages followed by a terminal ``result`` message.
"""

from __future__ import annotations

import asyncio
from typing import Any, AsyncIterable, AsyncIterator, Dict, Union

from ._transport import (
    spawn,
    write_user,
    close_stdin,
    extract_text,
    iter_messages,
)


async def _run(prompt: Union[str, AsyncIterable[Dict[str, Any]]], options: Dict[str, Any]):
    proc = await spawn(options)
    try:
        if isinstance(prompt, str):
            if prompt:
                await write_user(proc, prompt)
        else:
            async for msg in prompt:
                text = extract_text(msg)
                if text:
                    await write_user(proc, text)
        await close_stdin(proc)

        async for message in iter_messages(proc):
            yield message
    finally:
        if proc.returncode is None:
            proc.kill()
        await proc.wait()


def query(
    *,
    prompt: Union[str, AsyncIterable[Dict[str, Any]]],
    options: Dict[str, Any] | None = None,
) -> AsyncIterator[Dict[str, Any]]:
    """Run a query and yield SDK messages.

    ``prompt`` is a string or an async iterable of user messages
    (``{"type": "user", "message": {"role": "user", "content": "..."}}``).
    """
    return _run(prompt, options or {})
