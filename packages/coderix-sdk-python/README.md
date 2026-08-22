# coderix-sdk (Python)

A Python SDK for [Coderix](https://github.com/your-org/coderix), mirroring the
public API of **claude-code-sdk** (`@anthropic-ai/claude-code` /
`@anthropic-ai/claude-agent-sdk`).

It talks to the `coderix` CLI over a stream-json subprocess protocol
(`coderix --sdk`) — the same wire schema produced by the in-process
TypeScript SDK (`@coderix/sdk`), so the two languages can never drift.

## Install

```bash
pip install -e packages/coderix-sdk-python
```

This SDK has no Python dependencies; it shells out to the `coderix` CLI. The
CLI is resolved in this order:

1. the `path_to_coderix_executable` option
2. the `CODERIX_PATH` environment variable
3. `coderix` on `PATH`

## Quick start

```python
import asyncio
from coderix_sdk import query

async def main():
    async for message in query(
        prompt="Explain what this repo does.",
        options={"permission_mode": "plan", "max_turns": 5},
    ):
        print(message["type"], message.get("subtype", ""))

asyncio.run(main())
```

The stream yields `system` (leading `init`), then `assistant` / `user` /
`stream_event` (with `include_partial_messages`), and finally a `result`
message:

```python
async for message in query(prompt="hi"):
    if message["type"] == "result":
        print(message["result"])
```

## Long-lived client

```python
from coderix_sdk import CoderixSDKClient

async def main():
    client = CoderixSDKClient()
    await client.connect()

    async for message in client.query(prompt="First question"):
        print(message)

    await client.set_permission_mode("acceptEdits")
    await client.interrupt()  # abort the in-flight turn (if any)

    async for message in client.query(prompt="Second question"):
        print(message)

    await client.disconnect()
```

## Message schema

Faithful to claude-code-sdk:

| type          | subtype                          |
| ------------- | -------------------------------- |
| `system`      | `init`, `compact_boundary`       |
| `assistant`   | (Anthropic Messages API message) |
| `user`        | (Anthropic Messages API message) |
| `stream_event`| (partial assistant, opt-in)      |
| `result`      | `success` / `error_during_execution` / `error_max_turns` |

## v1 limitations

- `can_use_tool` and `interrupt`-permission round-trips are supported in the
  in-process TypeScript SDK; the subprocess protocol resolves headless
  permission requests by **denying** by default. Use `permission_mode:
  "acceptEdits"` / `"bypassPermissions"` to auto-approve.
- `updated_input` (rewriting tool inputs from `can_use_tool`) and externally
  injected `tool_result`s are not yet supported.
