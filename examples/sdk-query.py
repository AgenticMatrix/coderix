"""End-to-end example for the Coderix Python SDK (`coderix-sdk`).

Run after installing the SDK (``pip install -e packages/coderix-sdk-python``):

    python examples/sdk-query.py

Mirrors claude-code-sdk's Python ``query()`` + ``CoderixSDKClient``.
"""

import asyncio

from coderix_sdk import query, CoderixSDKClient


async def one_shot() -> None:
    print("=== query() ===")
    async for msg in query(
        prompt="Reply with exactly: hello",
        options={"permission_mode": "plan", "max_turns": 3},
    ):
        t = msg.get("type")
        if t == "system":
            print(f"[system] {msg.get('subtype')} session={msg.get('session_id')}")
        elif t == "result":
            print(
                f"[result] {msg.get('subtype')} "
                f"turns={msg.get('num_turns')} cost=${msg.get('total_cost_usd', 0):.4f}"
            )
            print(f"         {msg.get('result')}")
        elif t == "assistant":
            content = msg.get("message", {}).get("content")
            if isinstance(content, str):
                print(f"[assistant] {content}")


async def client() -> None:
    print("\n=== CoderixSDKClient ===")
    c = CoderixSDKClient(options={"permission_mode": "plan"})
    await c.connect()
    try:
        async for msg in c.query(prompt="Say hi in one word"):
            if msg.get("type") == "result":
                print(f"[result] {msg.get('subtype')}: {msg.get('result')}")
    finally:
        await c.disconnect()


async def main() -> None:
    await one_shot()
    await client()


if __name__ == "__main__":
    asyncio.run(main())
