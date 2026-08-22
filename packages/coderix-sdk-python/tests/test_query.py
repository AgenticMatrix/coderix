"""Tests for coderix_sdk — protocol + binary resolution, without a live CLI."""

import asyncio
import json
import os

import pytest

from coderix_sdk._transport import resolve_binary, extract_text
from coderix_sdk import query


class FakeReader:
    def __init__(self, lines):
        self._lines = [json.dumps(l) for l in lines]

    async def readline(self):
        if self._lines:
            return (self._lines.pop(0) + "\n").encode("utf-8")
        return b""


class FakeWriter:
    def __init__(self, sink):
        self._sink = sink

    def write(self, data: bytes):
        self._sink.append(data.decode("utf-8"))

    async def drain(self):
        return None

    def close(self):
        pass

    async def wait_closed(self):
        return None


class FakeProcess:
    def __init__(self, responses):
        self.returncode = None
        self.killed = False
        self.stdin_lines = []
        self.stdout = FakeReader(responses)
        self.stdin = FakeWriter(self.stdin_lines)

    def kill(self):
        self.killed = True

    async def wait(self):
        self.returncode = 0


def test_resolve_binary_explicit():
    assert resolve_binary({"path_to_coderix_executable": "/x/coderix"}) == "/x/coderix"


def test_resolve_binary_env(monkeypatch):
    monkeypatch.setenv("CODERIX_PATH", "/env/coderix")
    assert resolve_binary({}) == "/env/coderix"


def test_extract_text_string():
    assert extract_text({"message": {"content": "hello"}}) == "hello"


def test_extract_text_nonstring():
    assert extract_text({"message": {"content": ["a", "b"]}}) == ""


@pytest.mark.asyncio
async def test_query_protocol(monkeypatch):
    responses = [
        {"type": "system", "subtype": "init", "session_id": "s1"},
        {"type": "assistant", "message": {"role": "assistant", "content": "hi"}},
        {"type": "result", "subtype": "success", "result": "hi", "is_error": False},
    ]

    proc = FakeProcess(responses)

    async def fake_spawn(options):
        return proc

    import importlib

    query_mod = importlib.import_module("coderix_sdk.query")
    monkeypatch.setattr(query_mod, "spawn", fake_spawn)

    messages = []
    async for msg in query(prompt="hello", options={"cwd": "/tmp"}):
        messages.append(msg)

    # The user prompt was written to the subprocess stdin.
    assert len(proc.stdin_lines) == 1
    written = json.loads(proc.stdin_lines[0])
    assert written["type"] == "user"
    assert written["message"]["content"] == "hello"

    # All three messages were yielded, result last.
    assert [m["type"] for m in messages] == ["system", "assistant", "result"]
