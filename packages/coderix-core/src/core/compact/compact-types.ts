/**
 * compact-types.ts — Shared type definitions for the compression system.
 *
 * Centralizes all compression-related types to avoid circular dependencies
 * between the compactor orchestrator and its sub-modules.
 */

import type { Message, AssistantMessage, UserMessage, StreamEvent, CompactMetadata } from '../types.js';

// ---------------------------------------------------------------------------
// Strategy enum
// ---------------------------------------------------------------------------

export type CompactStrategy = CompactMetadata['strategy'];

// ---------------------------------------------------------------------------
// Compactor configuration
// ---------------------------------------------------------------------------

export interface CompactorConfig {
  estimateTokens: (messages: Message[]) => number;
  summarizeEnabled: boolean;
}

// ---------------------------------------------------------------------------
// Microcompact types
// ---------------------------------------------------------------------------

export interface MicrocompactResult {
  strategy: 'none' | 'time_based';
  removedCount: number;
  savedTokens: number;
  messages: Message[];
  /** Tool use IDs that were cleared, for content-replacement cleanup. */
  clearedToolUseIds?: string[];
}

// ---------------------------------------------------------------------------
// Truncation types
// ---------------------------------------------------------------------------

export interface TruncationResult {
  messages: Message[];
  droppedCount: number;
  savedTokens: number;
}

export interface KeepOptions {
  /** Minimum tokens to preserve (default: 10,000). */
  minTokens?: number;
  /** Maximum tokens to preserve (hard cap, default: 40,000). */
  maxTokens?: number;
  /** Minimum number of messages with text blocks (default: 5). */
  minTextBlockMessages?: number;
  /** Optional floor index — don't expand below this. */
  floorIndex?: number;
}

// ---------------------------------------------------------------------------
// LLM Compaction types
// ---------------------------------------------------------------------------

/** Signature matching query.ts CallModelParams to avoid circular imports. */
export type CompactModelFn = (
  params: {
    system: string;
    messages: Message[];
    tools: unknown[];
    signal: AbortSignal;
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
) => AsyncGenerator<StreamEvent | AssistantMessage, any, any>;

export interface LLMCompactResult {
  boundaryMarker: Message;
  summaryMessages: UserMessage[];
  messagesToKeep: Message[];
  preCompactTokens: number;
  postCompactTokens: number;
  strategy: CompactStrategy;
}

// ---------------------------------------------------------------------------
// CompactionResult — unified result from all compaction strategies
// ---------------------------------------------------------------------------

export interface CompactionResult {
  boundaryMarker: Message;
  summaryMessages: UserMessage[];
  /** Post-compact restoration attachments (files, skills, plans, tasks). */
  attachments: Message[];
  /** Hook result messages to display. */
  hookResults: Message[];
  messagesToKeep?: Message[];
  preCompactTokenCount?: number;
  postCompactTokenCount?: number;
  /** Display text for the user (compaction progress / summary). */
  userDisplayMessage?: string;
}

// ---------------------------------------------------------------------------
// Auto-compact types
// ---------------------------------------------------------------------------

export interface AutoCompactConfig {
  /** Absolute token threshold that triggers auto-compact. */
  threshold: number;
  /** Buffer tokens above the effective window for safety margin. */
  bufferTokens: number;
  /** Circuit breaker: max consecutive failures before disabling. */
  maxConsecutiveFailures: number;
  /** Whether auto-compact is enabled. */
  enabled: boolean;
}

export interface AutoCompactTrackingState {
  compacted: boolean;
  turnCounter: number;
  turnId: string;
  consecutiveFailures?: number;
}

// ---------------------------------------------------------------------------
// Session memory compact types
// ---------------------------------------------------------------------------

export interface SessionMemoryCompactConfig {
  /** Minimum tokens preserved after SM compact. */
  minTokens: number;
  /** Minimum messages with text blocks preserved. */
  minTextBlockMessages: number;
  /** Maximum tokens preserved after SM compact. */
  maxTokens: number;
}

// ---------------------------------------------------------------------------
// Compact boundary message
// ---------------------------------------------------------------------------

export interface CompactBoundaryMetadata {
  trigger: 'manual' | 'auto';
  preTokens: number;
  strategy: CompactStrategy;
  messagesSummarized?: number;
  /** Optional user context from PreCompact hook. */
  userContext?: string;
}

export interface CompactBoundaryMessage extends Message {
  role: 'system';
  subtype: 'compact_boundary';
  compactMetadata: CompactBoundaryMetadata;
}

// ---------------------------------------------------------------------------
// Microcompact boundary message
// ---------------------------------------------------------------------------

export interface MicrocompactBoundaryMetadata {
  trigger: 'auto';
  preTokens: number;
  tokensSaved: number;
  compactedToolIds: string[];
}

export interface MicrocompactBoundaryMessage extends Message {
  role: 'system';
  subtype: 'microcompact_boundary';
  content: string;
  microcompactMetadata: MicrocompactBoundaryMetadata;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum output tokens for a compaction summary. */
export const COMPACT_MAX_OUTPUT_TOKENS = 20_000;

/** Maximum PTL (prompt too long) retries for summarization. */
export const MAX_PTL_RETRIES = 3;

/** Circuit breaker: max consecutive auto-compact failures. */
export const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3;

// ── Microcompact constants ──────────────────────────────────────────

/** Minutes of inactivity before time-based micro-compact triggers. */
export const TIME_BASED_GAP_MINUTES = 60;

/** Number of most-recent tool results kept during time-based MC. */
export const TIME_BASED_KEEP_RECENT = 5;

/** Placeholder text inserted in place of cleared tool results. */
export const CLEARED_RESULT_MARKER = '[Old tool result content cleared]';

/** Tool names whose results are safe to clear during micro-compaction. */
export const COMPACTABLE_TOOLS = new Set<string>([
  'read',
  'bash',
  'grep',
  'glob',
  'WebSearch',
  'WebFetch',
  'update',
  'edit',
  'write',
]);

// ── Truncation budget constants ─────────────────────────────────────

export const MIN_KEEP_TOKENS = 10_000;
export const MAX_KEEP_TOKENS = 40_000;
export const MIN_TEXT_BLOCK_MESSAGES = 5;

// ── Post-compact restoration constants ──────────────────────────────

export const POST_COMPACT_MAX_FILES = 5;
export const POST_COMPACT_TOKEN_BUDGET = 50_000;
export const POST_COMPACT_MAX_TOKENS_PER_FILE = 5_000;
export const POST_COMPACT_MAX_TOKENS_PER_SKILL = 5_000;
export const POST_COMPACT_SKILLS_TOKEN_BUDGET = 25_000;

// ── Auto-compact buffer constants ───────────────────────────────────

/** Default auto-compact buffer for models with < 400K window. */
export const AUTOCOMPACT_BUFFER_TOKENS_DEFAULT = 13_000;
/** Buffer for models with >= 400K context window. */
export const AUTOCOMPACT_BUFFER_TOKENS_LARGE = 30_000;
/** Buffer for models with >= 800K context window. */
export const AUTOCOMPACT_BUFFER_TOKENS_XLARGE = 50_000;

// ── Token thresholds for early exit in multi-strategy pipeline ──────

/** If microcompact brings tokens below 60% of budget, skip remaining strategies. */
export const MICROCOMPACT_EXIT_THRESHOLD = 0.6;
/** If session-memory compact brings tokens below 70% of budget, skip remaining. */
export const SM_COMPACT_EXIT_THRESHOLD = 0.7;
