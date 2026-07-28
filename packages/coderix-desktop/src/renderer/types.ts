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
}
