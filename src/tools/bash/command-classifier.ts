/**
 * Bash command classification system.
 *
 * Classifies every bash command into a category for dynamic risk assessment
 * and concurrency-safety determination.
 *
 * The classifier combines:
 * 1. Read-only whitelist matching (from read-only-whitelist.ts)
 * 2. Dangerous pattern detection (from dangerous-patterns.ts)
 * 3. Heuristic fallback for unknown commands
 */

import { matchReadOnlyCommand } from './read-only-whitelist.js';
import {
  startsWithCodeInterpreter,
  startsWithDangerousBuiltin,
  startsWithDestructiveCommand,
  isNetworkExfilCommand,
} from './dangerous-patterns.js';

// ── Command categories ──────────────────────────────────────────────

export enum CommandCategory {
  /** Intrinsically safe read operations: ls, cat, grep, git diff, etc. */
  READ_ONLY = 'read_only',

  /** Modifies state but isn't inherently destructive: npm install, git commit */
  MUTATION = 'mutation',

  /** Potentially destructive: rm -rf, git push --force, chmod -R, fork bombs */
  DESTRUCTIVE = 'destructive',

  /** Arbitrary code execution: python -c, node -e, bash -c, eval */
  CODE_EXEC = 'code_exec',

  /** Network operations: curl POST, gh api, wget (potentially exfiltrating data) */
  NETWORK = 'network',

  /** Cannot be classified — treated as MUTATION for safety */
  UNKNOWN = 'unknown',
}

// ── Classification result ───────────────────────────────────────────

export interface ClassificationResult {
  category: CommandCategory;

  /** Shorthand: true when category is READ_ONLY */
  isReadOnly: boolean;

  /** True when the command is safe to run concurrently with other commands. */
  isConcurrencySafe: boolean;

  /** Human-readable explanation for the classification decision. */
  reason: string;
}

// ── Classifier options ──────────────────────────────────────────────

export interface ClassifyOptions {
  /**
   * 'strict' — whitelist-only mode. Any command not on the read-only whitelist
   *   is treated as potentially dangerous. Used in PLAN mode.
   * 'default' — whitelist-first, but unknown commands are allowed as MUTATION.
   */
  mode?: 'strict' | 'default';
}

// ── Classifier implementation ──────────────────────────────────────

/**
 * Classify a bash command into a category.
 *
 * Classification priority:
 * 1. Code exec interpreters (python -c, node -e, etc.) → CODE_EXEC
 * 2. Dangerous builtins (eval, sudo, xargs, etc.) → DESTRUCTIVE/CODE_EXEC
 * 3. Destructive commands (rm, dd, etc.) → DESTRUCTIVE
 * 4. Network exfil commands (curl POST, nc, etc.) → NETWORK
 * 5. Read-only whitelist match → READ_ONLY
 * 6. Default → UNKNOWN (treated as MUTATION)
 *
 * @param command - Raw command string from the LLM
 * @param tokens - Pre-tokenized tokens from command-tokenizer.ts
 * @param options - Classification mode ('strict' or 'default')
 */
export function classifyCommand(
  command: string,
  tokens: string[],
  options?: ClassifyOptions,
): ClassificationResult {
  // ── 1. Code exec interpreters ──────────────────────────────────
  if (startsWithCodeInterpreter(tokens)) {
    const interpreter = tokens[0] || 'unknown';
    return {
      category: CommandCategory.CODE_EXEC,
      isReadOnly: false,
      isConcurrencySafe: false,
      reason: `Command starts with code execution interpreter '${interpreter}'`,
    };
  }

  // ── 2. Dangerous builtins ──────────────────────────────────────
  if (startsWithDangerousBuiltin(tokens)) {
    const builtin = tokens[0] || 'unknown';
    const category =
      builtin === 'sudo' || builtin === 'su' || builtin === 'pkexec'
        ? CommandCategory.DESTRUCTIVE
        : CommandCategory.CODE_EXEC;
    return {
      category,
      isReadOnly: false,
      isConcurrencySafe: false,
      reason: `'${builtin}' is a dangerous command`,
    };
  }

  // ── 3. Destructive commands ────────────────────────────────────
  if (startsWithDestructiveCommand(tokens)) {
    const cmd = tokens[0] || 'unknown';
    return {
      category: CommandCategory.DESTRUCTIVE,
      isReadOnly: false,
      isConcurrencySafe: false,
      reason: `'${cmd}' is a destructive command`,
    };
  }

  // ── 4. Network exfil commands ──────────────────────────────────
  if (isNetworkExfilCommand(tokens, command)) {
    const cmd = tokens[0] || 'unknown';
    return {
      category: CommandCategory.NETWORK,
      isReadOnly: false,
      isConcurrencySafe: false,
      reason: `'${cmd}' is a network command that may exfiltrate data`,
    };
  }

  // ── 5. Read-only whitelist ─────────────────────────────────────
  const whitelistResult = matchReadOnlyCommand(tokens, command);
  if (whitelistResult.isReadOnly) {
    return {
      category: CommandCategory.READ_ONLY,
      isReadOnly: true,
      isConcurrencySafe: true,
      reason: whitelistResult.reason,
    };
  }

  // ── 6. Strict mode: unknown commands are unsafe ────────────────
  const mode = options?.mode ?? 'default';
  if (mode === 'strict' && tokens.length > 0) {
    return {
      category: CommandCategory.DESTRUCTIVE,
      isReadOnly: false,
      isConcurrencySafe: false,
      reason: 'Command not on the read-only whitelist (strict mode)',
    };
  }

  // ── 7. Default: unknown ────────────────────────────────────────
  return {
    category: CommandCategory.UNKNOWN,
    isReadOnly: false,
    isConcurrencySafe: false,
    reason: whitelistResult.reason || 'Unclassified command',
  };
}
