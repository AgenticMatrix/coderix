import type { StreamBlock, TokenUsage } from '../types.js';

/**
 * Shared types for the Coderix Desktop renderer state management.
 */

/** A single chat message (user or AI turn) */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  blocks: StreamBlock[];
  timestamp: number;
}

/** Summary of a session for list display */
export interface SessionSummary {
  id: string;
  title: string;
  turnCount: number;
  model: string;
  updatedAt: number;
  createdAt: number;
  /** Agent registry key this session is bound to (plugin sessions). */
  agentType?: string;
  /** Plugin name this session was created from. */
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

/** Aggregated token usage for the current session */
export interface AggregatedTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCost: number;
  currency: string;
  /** Current context footprint (last call's input + output + cache_read). */
  contextTokens: number;
}

/** Create a unique ID */
export function createId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
