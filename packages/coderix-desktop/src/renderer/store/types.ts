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
}

/** Aggregated token usage for the current session */
export interface AggregatedTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCost: number;
  currency: string;
}

/** Create a unique ID */
export function createId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
