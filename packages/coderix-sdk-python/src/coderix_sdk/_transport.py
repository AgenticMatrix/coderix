"""Shared subprocess transport for the Coderix SDK.

The `coderix --sdk` CLI speaks newline-delimited JSON on stdin/stdout:

  in:  {"type":"user","message":{"role":"user","content":"..."}}
       {"type":"control_request","request":{"subtype":"set_permission_mode","mode":"..."}}
       {"type":"control_request","request":{"subtype":"interrupt"}}
  out: one SDKMessage per line (system/assistant/user/stream_event/result)
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
from typing import Any, AsyncIterable, Dict, List, Optional, Tuple, Union

MISSING_BINARY = (
    "Could not locate the `coderix` executable. Set the "
    "`path_to_coderix_executable` option, the CODERIX_PATH environment "
    "variable, or ensure `coderix` is on your PATH."
)


def resolve_binary(options: Dict[str, Any]) -> str:
    explicit = options.get("path_to_coderix_executable")
    if explicit:
        return str(explicit)
    env = os.environ.get("CODERIX_PATH")
    if env:
        return env
    found = shutil.which("coderix")
    if found:
        return found
    raise FileNotFoundError(MISSING_BINARY)


async def spawn(options: Dict[str, Any]):
    path = resolve_binary(options)
    return await asyncio.create_subprocess_exec(
        path,
        "--sdk",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=options.get("cwd"),
    )


async def _write_line(proc, obj: Dict[str, Any]) -> None:
    line = json.dumps(obj, ensure_ascii=False) + "\n"
    assert proc.stdin is not None
    proc.stdin.write(line.encode("utf-8"))
    await proc.stdin.drain()


async def write_user(proc, text: str) -> None:
    await _write_line(proc, {"type": "user", "message": {"role": "user", "content": text}})


async def write_control(proc, subtype: str, mode: Optional[str] = None) -> None:
    request: Dict[str, Any] = {"subtype": subtype}
    if mode is not None:
        request["mode"] = mode
    await _write_line(proc, {"type": "control_request", "request": request})


async def close_stdin(proc) -> None:
    if proc.stdin is not None:
        proc.stdin.close()
        try:
            await proc.stdin.wait_closed()
        except (BrokenPipeError, ConnectionResetError):
            pass


def extract_text(message: Dict[str, Any]) -> str:
    content = message.get("message", {}).get("content") if isinstance(message, dict) else None
    if isinstance(content, str):
        return content
    return ""


async def iter_messages(proc):
    """Yield parsed SDKMessage dicts from stdout until EOF."""
    assert proc.stdout is not None
    while True:
        line = await proc.stdout.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            yield json.loads(line)
        except json.JSONDecodeError:
            # Non-JSON (e.g. stray log line) — skip.
            continue
