"""Type definitions mirroring the Coderix SDK message & option schema.

The wire schema is produced by the TypeScript ``@coderix/core`` sdk mapper
(single source of truth). These TypedDicts document the shapes; at runtime
messages are plain ``dict`` objects parsed from the CLI's NDJSON output.
"""

from typing import (
    Any,
    Dict,
    List,
    Literal,
    Optional,
    TypedDict,
)

# ── Permission mode ──────────────────────────────────────────────────────

PermissionMode = Literal["default", "acceptEdits", "plan", "bypassPermissions"]

# ── SDK messages ─────────────────────────────────────────────────────────


class SDKSystemMessage(TypedDict):
    type: Literal["system"]
    subtype: str  # "init" | "compact_boundary"
    session_id: str
    uuid: str
    cwd: Optional[str]
    tools: Optional[List[str]]
    mcp_servers: Optional[List[str]]
    model: Optional[str]
    permissionMode: Optional[str]


class SDKAssistantMessage(TypedDict):
    type: Literal["assistant"]
    message: Dict[str, Any]
    session_id: str
    uuid: str
    parent_tool_use_id: Optional[str]


class SDKUserMessage(TypedDict):
    type: Literal["user"]
    message: Dict[str, Any]
    session_id: str
    uuid: str
    parent_tool_use_id: Optional[str]


class SDKResultUsage(TypedDict, total=False):
    input_tokens: int
    output_tokens: int
    cache_creation_input_tokens: int
    cache_read_input_tokens: int
    totalCost: float


class SDKResultMessage(TypedDict):
    type: Literal["result"]
    subtype: str  # "success" | "error_max_turns" | "error_during_execution"
    is_error: bool
    result: str
    session_id: str
    uuid: str
    duration_ms: int
    duration_api_ms: int
    num_turns: int
    total_cost_usd: float
    usage: SDKResultUsage


class SDKPartialAssistantMessage(TypedDict):
    type: Literal["stream_event"]
    event: Dict[str, Any]
    session_id: str
    uuid: str
    parent_tool_use_id: Optional[str]


SDKMessage = Any  # one of the above; kept as Any for ergonomic pass-through


class SDKInputMessage(TypedDict):
    type: Literal["user"]
    message: Dict[str, Any]
    parent_tool_use_id: Optional[str]
    session_id: Optional[str]


# ── Options (snake_case, mirroring claude-code-sdk's Python surface) ─────


class Options(TypedDict, total=False):
    abort_controller: Any
    allowed_tools: List[str]
    append_system_prompt: str
    can_use_tool: Any  # async callable(tool_name, input, {signal}) -> permission result
    cwd: str
    disallowed_tools: List[str]
    env: Dict[str, str]
    fallback_model: str
    fork_session: bool
    include_partial_messages: bool
    max_thinking_tokens: int
    max_turns: int
    mcp_servers: Dict[str, Any]
    model: str
    output_format: Literal["text", "json", "stream-json"]
    path_to_coderix_executable: str
    permission_mode: PermissionMode
    resume: str
    setting_sources: List[str]
    stderr: Any
    system_prompt: Any
