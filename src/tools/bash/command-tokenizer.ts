/**
 * Shell command tokenization using shell-quote.
 *
 * Wraps shell-quote parse/quote functions with graceful error handling.
 * This is the critical primitive used by all subsequent security phases
 * to safely decompose shell commands into tokens for classification,
 * flag validation, and dangerous-pattern detection.
 */

import { parse, type ParseEntry } from 'shell-quote';

export type { ParseEntry } from 'shell-quote';

// ── Tokenization result types ──────────────────────────────────────

export interface TokenizeSuccess {
  success: true;
  /** Raw shell-quote ParseEntry array (strings, globs, operators, etc.) */
  entries: ParseEntry[];
}

export interface TokenizeError {
  success: false;
  error: string;
}

export type TokenizeResult = TokenizeSuccess | TokenizeError;

// ── Shell operators ─────────────────────────────────────────────────

/**
 * Shell operators that should be skipped when extracting command tokens.
 * These do not represent executable commands or arguments.
 */
const SHELL_OPERATORS = new Set([
  '|',
  '|&',
  '||',
  '&&',
  '&',
  ';',
  ';;',
  ';&',
  ';;&',
  '>',
  '>>',
  '<',
  '<<',
  '<>',
  '>&',
  '<&',
  '>>&',
  '>|',
]);

// ── Tokenization ────────────────────────────────────────────────────

/**
 * Tokenize a shell command string into ParseEntry components.
 *
 * Wraps shell-quote's parse() with error handling. Malformed commands
 * (unclosed quotes, etc.) return `success: false` with an error message
 * rather than throwing.
 */
export function tokenizeCommand(command: string): TokenizeResult {
  try {
    const entries = parse(command);
    return { success: true, entries };
  } catch (err) {
    return {
      success: false,
      error: `Failed to parse command: ${(err as Error).message}`,
    };
  }
}

// ── Token extraction ────────────────────────────────────────────────

/**
 * Extract flat string tokens from ParseEntry[], skipping shell operators
 * (|, ;, &&, ||, etc.) and ignoring glob patterns / control operators.
 *
 * This produces the "command and arguments" list used by the flag
 * validator and dangerous-pattern detector.
 *
 * Example:
 *   parse("git log --oneline | head -n 5")
 *   → entries: ["git", "log", "--oneline", {op: "|"}, "head", "-n", "5"]
 *   → extractCommandTokens: ["git", "log", "--oneline", "head", "-n", "5"]
 */
export function extractCommandTokens(entries: ParseEntry[]): string[] {
  const tokens: string[] = [];

  for (const entry of entries) {
    // Plain string tokens
    if (typeof entry === 'string') {
      tokens.push(entry);
      continue;
    }

    // Shell operator objects: {op: "|"}, {op: "&&"}, etc.
    if (typeof entry === 'object' && entry !== null && 'op' in entry) {
      const op = (entry as { op: string }).op;
      // Skip operators — they aren't command arguments
      if (SHELL_OPERATORS.has(op)) {
        continue;
      }
      // Some operators like '(' and ')' are used for grouping, skip them
      if (op === '(' || op === ')' || op === '{' || op === '}') {
        continue;
      }
      continue;
    }

    // Glob patterns: {glob: "*.ts"} — skip, they resolve to filenames
    if (typeof entry === 'object' && entry !== null && 'glob' in entry) {
      continue;
    }

    // Comment objects: {comment: "..."} — skip
    if (typeof entry === 'object' && entry !== null && 'comment' in entry) {
      continue;
    }

    // Environment assignments: VAR=value — include as tokens
    // These appear as strings in shell-quote output, already handled above
  }

  return tokens;
}

// ── Command extraction helpers ──────────────────────────────────────

/**
 * Extract the multi-word command key from tokens for whitelist lookup.
 *
 * For example, tokens ["git", "diff", "--name-only"] returns "git diff".
 * tokens ["docker", "ps"] returns "docker ps".
 * tokens ["ls", "-la"] returns "ls".
 *
 * This mirrors the command-key scheme in claude-code-best's
 * readOnlyCommandValidation.ts.
 */
export function extractCommandKey(tokens: string[]): string {
  if (tokens.length === 0) return '';

  const first = tokens[0] ?? '';

  // Skip leading environment assignments (VAR=value)
  let i = 0;
  while (i < tokens.length && tokens[i]?.includes('=') && !tokens[i]?.startsWith('-')) {
    i++;
  }

  if (i >= tokens.length) return '';

  const cmd = tokens[i] ?? '';
  const next = tokens[i + 1];

  // If the next token is a subcommand (not a flag), include it
  if (next && !next.startsWith('-') && !next.includes('=')) {
    return `${cmd} ${next}`;
  }

  return cmd;
}
