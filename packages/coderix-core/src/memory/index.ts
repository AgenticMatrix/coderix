/**
 * Memory module — public API barrel export.
 *
 * The Coderix memory system provides persistent, file-based memory
 * for AI coding agents. It supports:
 *
 *   - Auto-memory directory management (MEMORY.md index + topic files)
 *   - Frontmatter-based memory file parsing (name/description/type)
 *   - System prompt injection (teaches the model how to save/recall)
 *   - Auto-extraction (background memory extraction from conversations)
 *   - Intelligent recall (keyword-based relevance search)
 *   - Staleness warnings (age-based staleness caveats)
 *
 * Enable with: CODERIX_MEMORY_ENABLED=true
 * Or in settings.json: { "memory": { "enabled": true } }
 *
 * See each module for detailed documentation.
 */

// Types
export {
  MEMORY_TYPES,
  parseMemoryType,
  type MemoryType,
  type MemoryFrontmatter,
  type MemoryHeader,
  type MemoryEntry,
  type MemoryIndexEntry,
  type MemorySettings,
  type MemoryConfig,
  DEFAULT_MEMORY_CONFIG,
  ENTRYPOINT_NAME,
  MAX_ENTRYPOINT_LINES,
  MAX_ENTRYPOINT_BYTES,
  MAX_MEMORY_FILES,
  MAX_MEMORY_FILE_BYTES,
} from './types.js';

// Directory
export {
  getMemoryDir,
  getMemoryIndexPath,
  getProjectRoot,
  getConfigDir,
  ensureMemoryDirExists,
  isAutoMemPath,
  isMemoryEnabled,
  sanitizePath,
} from './memory-directory.js';

// Frontmatter
export {
  validateMemoryFrontmatter,
  parseMemoryFile,
  parseMemoryHeader,
  createMemoryFile,
  scanMemoryFiles,
  formatMemoryManifest,
} from './frontmatter.js';

// Index
export {
  loadIndex,
  saveIndex,
  addIndexEntry,
  removeIndexEntry,
  formatIndexContent,
  parseIndexContent,
  condenseIndex,
  cleanStaleEntries,
} from './memory-index.js';

// Prompt builder
export {
  loadMemoryPrompt,
  formatMemoryContext,
} from './prompt-builder.js';

// Staleness
export {
  memoryAgeDays,
  memoryAge,
  memoryFreshnessText,
  memoryFreshnessNote,
  injectStalenessWarnings,
} from './staleness.js';

// Config
export {
  loadMemoryConfig,
  isAutoExtractEnabled,
  isRecallEnabled,
} from './config.js';

// Extraction
export {
  initExtractMemories,
  executeExtractMemories,
  drainPendingExtraction,
  _resetExtractionState,
  _getExtractionState,
} from './extract-memories.js';

// Recall
export {
  findRelevantMemories,
  formatRecalledMemories,
  RelevanceCache,
} from './recall.js';

// Scorer
export {
  tokenize,
  jaccardSimilarity,
  scoreMemoryRelevance,
  rankMemories,
} from './scorer.js';
