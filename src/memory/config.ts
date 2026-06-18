/**
 * Memory configuration loader.
 *
 * Merges environment variables and settings.json into a resolved MemoryConfig.
 * Priority: env vars > settings.json > defaults.
 */

import {
  type MemoryConfig,
  type MemorySettings,
  DEFAULT_MEMORY_CONFIG,
} from './types.js';

// ---------------------------------------------------------------------------
// Env var parsing
// ---------------------------------------------------------------------------

function isTruthy(val: string | undefined): boolean {
  return val === 'true' || val === '1';
}

function isFalsy(val: string | undefined): boolean {
  return val === 'false' || val === '0';
}

function parseIntSafe(val: string | undefined): number | undefined {
  if (val === undefined) return undefined;
  const n = Number.parseInt(val, 10);
  return Number.isNaN(n) ? undefined : n;
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

/**
 * Load resolved memory configuration.
 *
 * @param settings - Memory settings from CoderSettings.memory (Phase 2 integration)
 * @returns Fully resolved MemoryConfig with defaults applied
 */
export function loadMemoryConfig(settings?: MemorySettings): MemoryConfig {
  const config: MemoryConfig = { ...DEFAULT_MEMORY_CONFIG };

  // === Step 1: env vars ===

  // CODERIX_MEMORY_ENABLED: explicit on/off
  const envEnabled = process.env.CODERIX_MEMORY_ENABLED;
  if (isTruthy(envEnabled)) {
    config.enabled = true;
  } else if (isFalsy(envEnabled)) {
    config.enabled = false;
  }

  // CODERIX_DISABLE_MEMORY: force-off
  if (isTruthy(process.env.CODERIX_DISABLE_MEMORY)) {
    config.enabled = false;
  }

  // CODERIX_DISABLE_AUTO_EXTRACT: disable extraction
  if (isTruthy(process.env.CODERIX_DISABLE_AUTO_EXTRACT)) {
    config.autoExtract = false;
  }

  // CODERIX_MEMORY_EXTRACT_EVERY_N: throttle
  const extractN = parseIntSafe(process.env.CODERIX_MEMORY_EXTRACT_EVERY_N);
  if (extractN !== undefined && extractN > 0) {
    config.extractEveryNTurns = extractN;
  }

  // CODERIX_DISABLE_MEMORY_RECALL: disable recall
  if (isTruthy(process.env.CODERIX_DISABLE_MEMORY_RECALL)) {
    config.recallEnabled = false;
  }

  // CODERIX_MEMORY_RECALL_MAX: max results
  const recallMax = parseIntSafe(process.env.CODERIX_MEMORY_RECALL_MAX);
  if (recallMax !== undefined && recallMax > 0) {
    config.recallMaxResults = recallMax;
  }

  // === Step 2: settings.json ===

  if (settings) {
    if (settings.enabled !== undefined) {
      config.enabled = settings.enabled;
    }
    if (settings.autoExtract !== undefined) {
      config.autoExtract = settings.autoExtract;
    }
    if (
      settings.extractEveryNTurns !== undefined &&
      settings.extractEveryNTurns > 0
    ) {
      config.extractEveryNTurns = settings.extractEveryNTurns;
    }
    if (settings.recallEnabled !== undefined) {
      config.recallEnabled = settings.recallEnabled;
    }
    if (
      settings.recallMaxResults !== undefined &&
      settings.recallMaxResults > 0
    ) {
      config.recallMaxResults = settings.recallMaxResults;
    }
    if (
      settings.stalenessThresholdDays !== undefined &&
      settings.stalenessThresholdDays >= 0
    ) {
      config.stalenessThresholdDays = settings.stalenessThresholdDays;
    }
  }

  return config;
}

/**
 * Check if memory is enabled via any configuration source.
 * Lightweight check — doesn't load full config.
 */
export function isMemoryEnabled(): boolean {
  const envEnabled = process.env.CODERIX_MEMORY_ENABLED;
  if (isTruthy(envEnabled)) return true;
  if (isFalsy(envEnabled)) return false;

  const envDisabled = process.env.CODERIX_DISABLE_MEMORY;
  if (isTruthy(envDisabled)) return false;

  // Without explicit env var, default to OFF (opt-in)
  // Full settings.json check happens via loadMemoryConfig
  return false;
}

/**
 * Check if memory auto-extraction is enabled.
 */
export function isAutoExtractEnabled(config: MemoryConfig): boolean {
  return config.enabled && config.autoExtract;
}

/**
 * Check if memory recall is enabled.
 */
export function isRecallEnabled(config: MemoryConfig): boolean {
  return config.enabled && config.recallEnabled;
}
