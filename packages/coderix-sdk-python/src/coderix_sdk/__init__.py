"""
coderix_sdk — Python SDK for Coderix.

A faithful mirror of claude-code-sdk's Python API. Communicates with the
`coderix` CLI over a stream-json subprocess protocol (`coderix --sdk`).

Usage::

    from coderix_sdk import query, CoderixSDKClient

    async for message in query(prompt="Say hello", options={}):
        print(message)

    client = CoderixSDKClient()
    await client.connect()
    async for message in client.query(prompt="Do a thing"):
        print(message)
    await client.disconnect()
"""

from .query import query
from .client import CoderixSDKClient
from .types import (
    PermissionMode,
    Options,
    SDKSystemMessage,
    SDKAssistantMessage,
    SDKUserMessage,
    SDKResultMessage,
    SDKPartialAssistantMessage,
    SDKMessage,
    SDKInputMessage,
)

__all__ = [
    "query",
    "CoderixSDKClient",
    "PermissionMode",
    "Options",
    "SDKSystemMessage",
    "SDKAssistantMessage",
    "SDKUserMessage",
    "SDKResultMessage",
    "SDKPartialAssistantMessage",
    "SDKMessage",
    "SDKInputMessage",
]

__version__ = "0.1.0"
