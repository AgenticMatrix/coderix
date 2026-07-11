/**
 * Core type definitions for the Unified Agent TUI.
 *
 * ContentBlock-driven message model: each Message contains an array of
 * typed ContentBlocks that drive rendering.  The model supports both
 * Coderix (35+ tools).
 */

import type { CoreState } from '@coderix/core';

// ── ContentBlock types ──────────────────────────────────────────────

export interface TextBlock {
  type: 'text';
  content: string;
}

export interface ThinkingBlock {
  type: 'thinking';
  content: string;
  expanded?: boolean;
}

export type ToolUseState = 'pending' | 'executing' | 'done' | 'error';
export type RiskLevel = 'safe' | 'mutation' | 'destructive';
export type PermissionState = 'approved' | 'denied' | 'pending';

export interface ToolUseBlock {
  type: 'tool_use';
  toolName: string;
  toolId: string;
  input: Record<string, unknown>;
  state: ToolUseState;
  duration?: number;
  riskLevel?: RiskLevel;
  permissionState?: PermissionState;
  /** Tool execution result (injected after execution for inline display). */
  result?: {
    content: string;
    isError: boolean;
    metadata?: Record<string, unknown>;
  };
}

export interface ToolResultBlock {
  type: 'tool_result';
  toolId: string;
  toolName: string;
  content: string;
  isError: boolean;
  truncated?: boolean;
  /** Execution duration in milliseconds. */
  duration?: number;
  /** Tool-specific structured metadata from the executor. */
  metadata?: Record<string, unknown>;
}

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm: string;
}

export interface TodoUpdateBlock {
  type: 'todo_update';
  todos: TodoItem[];
  oldTodos?: TodoItem[];
}

export interface TurnSummary {
  turnNumber: number;
  toolCount: number;
  subagentCount: number;
  todoUpdates: number;
  duration: number;
  tokenUsage: { input: number; output: number; cache?: number };
  outcome: 'success' | 'error' | 'interrupted' | 'compacted';
}

export interface TurnBoundary {
  type: 'turn_boundary';
  turnId: number;
  summary?: TurnSummary;
}

export type SubagentType = 'explore' | 'plan' | 'general-purpose' | 'verification';
export type SubagentState = 'running' | 'done' | 'error';

export interface SubagentBlock {
  type: 'subagent';
  agentType: SubagentType;
  agentName: string;
  state: SubagentState;
  messageCount?: number;
}

export interface CompactionBoundary {
  type: 'compaction';
  removedCount: number;
  reason: string;
}

export type SpeculationState = 'predicting' | 'used' | 'discarded';

export interface SpeculationBlock {
  type: 'speculation';
  state: SpeculationState;
}

export interface CompletionBoundary {
  type: 'completion';
  stopReason: string;
}

/**
 * All ContentBlock variants.  Each block drives its own renderer.
 * New block types can be added without changing existing renderers.
 */
export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | TodoUpdateBlock
  | TurnBoundary
  | SubagentBlock
  | CompactionBoundary
  | SpeculationBlock
  | CompletionBoundary;

// ── Message ─────────────────────────────────────────────────────────

export interface Message {
  id: number;
  role: 'user' | 'assistant' | 'system';
  /** Flat text content — kept for backward compat, derived from blocks. */
  content: string;
  /** Canonical content as typed blocks.  Drives rendering. */
  blocks: ContentBlock[];
  /** Legacy thinking field — will be migrated to ThinkingBlock. */
  thinking?: string;
  thinkingExpanded?: boolean;
  toolsExpanded?: boolean;
  timestamp: number;
  /** Duration of the thinking phase in ms, set when thinking completes. */
  thinkingDuration?: number;
  /** Estimated token count of the thinking content. */
  thinkingTokens?: number;
}

// ── App config ──────────────────────────────────────────────────────

export type { AppConfig } from '@coderix/core';

// ── Approval request ─────────────────────────────────────────────────

export interface ApprovalRequest {
  toolName: string;
  command: string;
  description: string;
  toolUseId: string;
}

export interface QuestionRequest {
  questions: Array<{
    header: string;
    question: string;
    options?: Array<{ label: string; description: string }>;
    multiSelect?: boolean;
  }>;
}

// ── Chat state ──────────────────────────────────────────────────────

export type AgentMode = 'plan' | 'ask' | 'auto';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface ChatState extends CoreState {
  messages: Message[];
  isStreaming: boolean;
  error: string | null;
  inputText: string;
  cursorPosition: number;
  /** Current permission/execution mode. */
  mode: AgentMode;
  /** Per-turn summaries for TurnBoundary rendering. */
  turns: TurnSummary[];
  /** Monotonically increasing turn counter. */
  currentTurnId: number;
  /** Pending approval request — shown as a floating prompt overlay. */
  approvalReq: ApprovalRequest | null;
  /** Pending question request (ask-user-question tool). */
  questionReq: QuestionRequest | null;
  /** Input history lines (newest last). */
  history: string[];
  /** Current position in history (-1 = not browsing). */
  historyIndex: number;
  /** Saved input text before browsing history (to restore on exit). */
  historyScratch: string;
  /** Paste block contents keyed by ID (IDs embedded as markers in inputText). */
  pasteBlocks: Record<number, string>;
  /** When true, paste content preview is shown above the input line. */
  pastePreviewVisible: boolean;
  /** Global toggle for content-level expansion (thinking, tool results). */
  contentExpanded: boolean;
  /** When set, renders a sub-agent transcript view instead of the main chat. */
  subAgentView: { agentId: string } | null;
  /** Saved main chat messages when viewing a sub-agent. Restored on exit. */
  savedMainMessages: Message[] | null;
  /** Per-agent cached message state. Keyed by agentId. */
  subAgentMessageCache: Record<string, Message[]>;
  /** Last viewed sub-agent ID — Ctrl+T defaults to this. */
  lastAgentViewId: string | null;
  /** When true, shows the sub-agent picker overlay. */
  agentPicker: boolean;
  /** When true, the task panel has been manually dismissed. */
  taskPanelDismissed: boolean;
  /** Timestamp when the current thinking block started (for duration tracking). */
  thinkingStartedAt?: number;
  /** When true, the todo panel has been manually dismissed. */
  todoPanelDismissed: boolean;
  /** When true, the team panel has been manually dismissed. */
  teamPanelDismissed: boolean;
  /** When true, the team picker overlay is shown. */
  teamPicker: boolean;
  /** When true, the memory picker overlay is shown. */
  memoryPicker: boolean;
  /** When true, the session picker overlay is shown. */
  sessionPicker: boolean;
  /** Selected index in the command picker dropdown (-1 = hidden). */
  commandPickerIndex: number;
  /** When true, display is frozen (user scrolled up during streaming). */
  isFrozen: boolean;
  /** Accumulated real token usage from latest API response (for ctx display). */
  tokenUsage: TokenUsage;
  /** Accumulated total cost across all turns. */
  accumulatedCost: number;
  /** Price per 1M input tokens (cache miss). */
  inputPrice: number;
  /** Price per 1M output tokens. */
  outputPrice: number;
  /** Price per 1M cache read/creation input tokens. */
  cacheReadPrice: number;
  /** Brief mode toggle — reduces response verbosity to save context. */
  briefMode: boolean;
  /** Cumulative output tokens since the last user message (turn-level, includes sub-agents). */
  turnOutputTokens: number;
  /** Timestamp when the current turn started (user message sent). */
  turnStartedAt: number;
}

// ── Chat actions ────────────────────────────────────────────────────

export type BlockDeltaType = 'text' | 'thinking' | 'json';

export type ChatAction =
  // Input
  | { type: 'SET_INPUT'; text: string }
  | { type: 'INSERT_CHAR'; char: string }
  | { type: 'DELETE_CHAR'; position: 'before' | 'after' }
  | { type: 'SET_CURSOR'; position: number }
  // Messages
  | { type: 'ADD_USER_MESSAGE'; message: Message }
  | { type: 'START_ASSISTANT_RESPONSE'; id: number }
  // ContentBlock streaming
  | { type: 'START_BLOCK'; messageId: number; block: ContentBlock }
  | { type: 'APPEND_BLOCK_DELTA'; messageId: number; deltaType: BlockDeltaType; text: string }
  | { type: 'STOP_BLOCK'; messageId: number }
  // Legacy streaming (kept during transition)
  | { type: 'APPEND_ASSISTANT_TEXT'; id: number; text: string }
  | { type: 'APPEND_ASSISTANT_THINKING'; id: number; text: string }
  // Lifecycle
  | { type: 'FINISH_ASSISTANT_RESPONSE'; id: number }
  | { type: 'INTERRUPT' }
  | { type: 'UPDATE_BLOCK_STATE'; toolId: string; state: ToolUseState }
  | { type: 'SET_TOOL_USE_RESULT'; toolId: string; duration?: number; result: ToolUseBlock['result'] }
  | { type: 'TOGGLE_THINKING'; id: number }
  | { type: 'TOGGLE_TOOLS'; id: number }
  | { type: 'TOGGLE_ALL_EXPAND' }
  | { type: 'TOGGLE_ALL_CONTENT' }
  | { type: 'OPEN_SUBAGENT_VIEW'; agentId: string }
  | { type: 'CLOSE_SUBAGENT_VIEW' }
  | { type: 'LOAD_SUBAGENT_TRANSCRIPT'; agentId: string; messages: Message[] }
  | { type: 'SHOW_AGENT_PICKER' }
  | { type: 'HIDE_AGENT_PICKER' }
  | { type: 'TOGGLE_TASK_PANEL' }
  | { type: 'TOGGLE_TODO_PANEL' }
  | { type: 'TOGGLE_TEAM_PANEL' }
  | { type: 'SET_COMMAND_PICKER_INDEX'; index: number }
  | { type: 'SHOW_TEAM_PICKER' }
  | { type: 'HIDE_TEAM_PICKER' }
  | { type: 'SHOW_MEMORY_PICKER' }
  | { type: 'HIDE_MEMORY_PICKER' }
  | { type: 'SHOW_SESSION_PICKER' }
  | { type: 'HIDE_SESSION_PICKER' }
  | { type: 'FREEZE_DISPLAY' }
  | { type: 'UNFREEZE_DISPLAY' }
  | { type: 'SET_MODE'; mode: AgentMode }
  | { type: 'SET_ERROR'; error: string }
  | { type: 'CLEAR_ERROR' }
  | { type: 'CLEAR_CHAT' }
  | { type: 'LOAD_CHAT'; messages: Message[]; turns: TurnSummary[]; isStreaming?: boolean }
  // Permission / approval
  | { type: 'SHOW_APPROVAL'; req: ApprovalRequest }
  | { type: 'HIDE_APPROVAL' }
  | { type: 'SHOW_QUESTION'; questions: QuestionRequest['questions'] }
  | { type: 'HIDE_QUESTION' }
  // History
  | { type: 'LOAD_HISTORY'; history: string[] }
  | { type: 'ADD_HISTORY'; line: string }
  | { type: 'SET_HISTORY_INDEX'; index: number; scratch?: string }
  // Paste blocks
  | { type: 'ADD_PASTE_BLOCK'; text: string }
  | { type: 'TOGGLE_PASTE_PREVIEW' }
  // Token usage
  | { type: 'UPDATE_TOKEN_USAGE'; usage: Partial<TokenUsage>; skipDisplay?: boolean }
  // Agent cache management
  | { type: 'EVICT_AGENT_CACHE'; agentId: string }
  | { type: 'TOGGLE_BRIEF_MODE' }
  // Internal: route an action to savedMainMessages when in sub-agent view
  | { type: 'ROUTE_TO_SAVED_MAIN'; action: ChatAction };

// ── Streaming callbacks (API client → App) ──────────────────────────

export interface StreamCallbacks {
  /** A new content block has started (text / thinking / tool_use). */
  onBlockStart: (block: ContentBlock) => void;
  /** Delta content for the currently-open block. */
  onBlockDelta: (deltaType: BlockDeltaType, text: string) => void;
  /** The current block is complete. */
  onBlockStop: () => void;
  /** The entire stream finished successfully. */
  onDone: () => void;
  /** A non-abort error occurred. */
  onError: (error: Error) => void;
}
