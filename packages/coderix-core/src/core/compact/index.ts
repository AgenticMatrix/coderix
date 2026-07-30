/**
 * compact/index.ts — Unified barrel export for the compression system.
 *
 * All public compression APIs are available through this single import:
 *   import { compactConversation, microcompactMessages, ... } from './compact/index.js';
 *
 * For backward compatibility, compactor.ts also re-exports the key types.
 */

// Types
export type {
  CompactorConfig,
  MicrocompactResult,
  TruncationResult,
  LLMCompactResult,
  CompactionResult,
  AutoCompactConfig,
  AutoCompactTrackingState,
  SessionMemoryCompactConfig,
  CompactBoundaryMessage,
  CompactBoundaryMetadata,
  CompactStrategy,
  KeepOptions,
} from './compact-types.js';

// Constants
export {
  COMPACT_MAX_OUTPUT_TOKENS,
  MAX_PTL_RETRIES,
  MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
  TIME_BASED_GAP_MINUTES,
  TIME_BASED_KEEP_RECENT,
  CLEARED_RESULT_MARKER,
  COMPACTABLE_TOOLS,
  MIN_KEEP_TOKENS,
  MAX_KEEP_TOKENS,
  MIN_TEXT_BLOCK_MESSAGES,
  POST_COMPACT_MAX_FILES,
  POST_COMPACT_TOKEN_BUDGET,
  POST_COMPACT_MAX_TOKENS_PER_FILE,
  AUTOCOMPACT_BUFFER_TOKENS_DEFAULT,
  AUTOCOMPACT_BUFFER_TOKENS_LARGE,
  AUTOCOMPACT_BUFFER_TOKENS_XLARGE,
  MICROCOMPACT_EXIT_THRESHOLD,
  SM_COMPACT_EXIT_THRESHOLD,
} from './compact-types.js';

// Microcompact
export { microcompactMessages } from './microcompact.js';

// Compact prompt
export {
  getCompactPrompt,
  formatCompactSummary,
  getCompactUserSummaryMessage,
  buildCompactContext,
} from './compact-prompt.js';

// Boundary utilities
export {
  createCompactBoundaryMessage,
  createMicrocompactBoundaryMessage,
  isCompactBoundaryMessage,
  isMicrocompactBoundaryMessage,
  isAnyCompactBoundaryMessage,
  findLastCompactBoundaryIndex,
  getMessagesAfterCompactBoundary,
  stripImagesFromMessages,
  stripCompactBoundaries,
  groupMessagesByApiRound,
  dropOldestMessageGroups,
  stripToolUseResultsFromKept,
  buildPostCompactMessages,
} from './compact-boundary.js';

// Auto compact
export {
  getAutoCompactThreshold,
  isAutoCompactEnabled,
  shouldAutoCompact,
  autoCompactIfNeeded,
  resetCircuitBreaker,
} from './auto-compact.js';

// Reactive compact
export {
  reactiveCompactOnPromptTooLong,
  tryReactiveCompact,
  isPromptTooLongError,
} from './reactive-compact.js';

// Post-compact restore
export {
  createPostCompactFileAttachments,
  createPlanAttachmentIfNeeded,
  createPlanModeAttachmentIfNeeded,
  createSkillAttachmentIfNeeded,
  createCoderixMdAttachment,
  collectPostCompactAttachments,
} from './post-compact-restore.js';
export type { PostCompactRestoreOptions } from './post-compact-restore.js';

// Session memory compact
export { trySessionMemoryCompaction } from './session-memory-compact.js';
