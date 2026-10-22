/**
 * Shared types for the Coderix Desktop renderer.
 *
 * These types are used across components, stores, hooks, and the IPC client.
 * They define the shape of data flowing between the main process (via preload)
 * and the renderer process.
 */

// ── Stream Types ──────────────────────────────────────────

/** A single content block in a message stream */
export interface StreamBlock {
  /** Block type — determines how the block is rendered */
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'system';
  /** Text content (for text, thinking, tool_result, system blocks) */
  content?: string;
  /** Tool name (for tool_use and tool_result blocks) */
  toolName?: string;
  /** Tool call ID — used to correlate tool_use with tool_result */
  toolId?: string;
  /** Tool input parameters (for tool_use blocks) */
  toolInput?: Record<string, unknown>;
  /** Execution state for tool_use blocks */
  state?: 'pending' | 'executing' | 'done' | 'error';
  /** Tool result content — attached to tool_use when the matching tool_result arrives */
  toolResult?: string;
  /** Tool result metadata (e.g. addedLines, removedLines for write tool) */
  toolMetadata?: Record<string, unknown>;
  /** Session this block belongs to — used to drop late cross-session stream events */
  sessionId?: string;
  /** Wall-clock start/end of this block's stream (ms epoch). Thinking blocks
   *  carry both so each LLM turn's thinking time can be shown independently. */
  startedAt?: number;
  endedAt?: number;
}

// ── Token / Cost Types ────────────────────────────────────

/** Token usage statistics from a single API call */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: number;
  currency?: string;
  /** Current context footprint (last call's input + output + cache_read). */
  contextTokens?: number;
}

// ── Permission Types ──────────────────────────────────────

/** A permission request sent from the main process when a tool needs approval */
export interface PermissionRequest {
  /** Unique identifier for this request */
  id: string;
  /** Name of the tool requesting permission */
  toolName: string;
  /** Input parameters the tool will use */
  toolInput: Record<string, unknown>;
  /** Human-readable description of what the tool will do */
  message?: string;
  /** Owning session id (for routing a backgrounded prompt back to its session) */
  sessionId?: string;
}

/** Question request emitted by AskUserQuestion. */
export interface QuestionRequest {
  toolUseId: string;
  toolName: string;
  sessionId?: string;
  questions: Array<{
    header: string;
    question: string;
    options?: Array<{ label: string; description: string }>;
    multiSelect?: boolean;
  }>;
}

// ── Session Types ─────────────────────────────────────────

/** Summary information for a session in the sidebar list */
export interface SessionInfo {
  id: string;
  title: string;
  turnCount: number;
  model: string;
  updatedAt: number;
  createdAt: number;
  agentType?: string;
  pluginId?: string;
  /** Working directory of the session (for workspace grouping). */
  workDir?: string;
  /** Another live client (CLI) is currently writing this session. */
  busy?: boolean;
  /** First 60 chars of the latest user message. */
  lastUserPreview?: string;
  /** Display title derived from the first user message. */
  displayTitle?: string;
  /** Full text of the first user message. */
  firstUserText?: string;
}

/** A versioned CAD step surfaced by `cad:listSteps` (mirrors cad_harness's Step). */
export interface CadStep {
  id: string;
  name: string;
  baseName: string;
  version: number;
  isLatest: boolean;
  kind: 'assembly' | 'part' | 'frame';
  status: 'generating' | 'generated';
  viewerFile?: string;
  renderHash?: string;
  sourceMtime?: number;
  sourcePath?: string;
  stepPath?: string;
  glbPath?: string;
  snapshotPath?: string;
}
