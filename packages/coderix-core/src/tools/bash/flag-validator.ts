/**
 * Flag validation for read-only command whitelisting.
 *
 * Validates that command flags and their arguments conform to expected types
 * defined in the read-only whitelist. This is the security boundary that
 * prevents malicious flag injection through seemingly-safe commands.
 */

// ── Flag argument types ─────────────────────────────────────────────

/**
 * Expected type for a flag's argument.
 *
 * - 'none': Flag takes no argument (--color, -n)
 * - 'number': Integer argument (--context=3)
 * - 'string': Any string argument (--relative=path)
 * - 'char': Single character (delimiter)
 * - '{}': Literal "{}" only (xargs -I replace-str)
 * - 'EOF': Literal "EOF" only (heredoc delimiter)
 */
export type FlagArgType =
  | 'none'
  | 'number'
  | 'string'
  | 'char'
  | '{}'
  | 'EOF';

// ── Command config ──────────────────────────────────────────────────

export interface ExternalCommandConfig {
  /** Map of safe flag names to their expected argument type. */
  safeFlags: Record<string, FlagArgType>;

  /**
   * Optional callback for additional dangerous-command detection.
   *
   * Called after flag validation passes. Receives the raw command string
   * and the token list AFTER the command name (e.g., after "git branch").
   * Return `true` if the command is dangerous despite passing flag checks.
   */
  additionalCommandIsDangerousCallback?: (
    rawCommand: string,
    args: string[],
  ) => boolean;

  /**
   * When false, the tool does NOT honor POSIX `--` end-of-options.
   * The validator continues checking flags after `--` instead of stopping.
   * Default: true (most tools respect `--`).
   */
  respectsDoubleDash?: boolean;
}

// ── Flag pattern ────────────────────────────────────────────────────

/** Pattern for a valid flag token: starts with `-` followed by a letter, digit, `_`, or `-`. */
export const FLAG_PATTERN = /^-[a-zA-Z0-9_-]/;

// ── Argument validation ─────────────────────────────────────────────

/**
 * Validate a flag argument against its expected type.
 */
export function validateFlagArgument(
  value: string,
  argType: FlagArgType,
): boolean {
  switch (argType) {
    case 'none':
      return false;
    case 'number':
      return /^\d+$/.test(value);
    case 'string':
      return true;
    case 'char':
      return value.length === 1;
    case '{}':
      return value === '{}';
    case 'EOF':
      return value === 'EOF';
    default:
      return false;
  }
}

// ── Flag token parsing helpers ──────────────────────────────────────

interface ParsedFlag {
  /** The full flag including dashes, e.g. "--sort" or "-n" */
  raw: string;
  /** The flag name without leading dashes and inline value, e.g. "sort" or "n" */
  name: string;
  /** Whether the original token contained `=` (e.g., "--sort=refname") */
  hasInlineValue: boolean;
  /** The value after `=`, if present; empty string if `--flag=` */
  inlineValue: string;
}

/**
 * Decompose a flag token into its components.
 *
 * Handles:
 *   --flag=value  → { name: "--flag", hasInlineValue: true, inlineValue: "value" }
 *   --flag=       → { name: "--flag", hasInlineValue: true, inlineValue: "" }
 *   -n5           → { name: "-n", hasInlineValue: true, inlineValue: "5" }
 *   --verbose     → { name: "--verbose", hasInlineValue: false, inlineValue: "" }
 */
function parseFlagToken(token: string): ParsedFlag {
  // Long option with equals: --flag=value
  if (token.startsWith('--') && token.includes('=')) {
    const idx = token.indexOf('=');
    return {
      raw: token,
      name: token.slice(0, idx),
      hasInlineValue: true,
      inlineValue: token.slice(idx + 1),
    };
  }

  // Short option with attached value: -n5, -A20
  if (
    token.startsWith('-') &&
    !token.startsWith('--') &&
    token.length > 2
  ) {
    // Check if the remainder could be a numeric arg (e.g., -A20, -n5)
    const remainder = token.slice(2);
    if (/^\d+$/.test(remainder)) {
      return {
        raw: token,
        name: token.slice(0, 2),
        hasInlineValue: true,
        inlineValue: remainder,
      };
    }
    // Otherwise it's bundled short flags like -la
  }

  return {
    raw: token,
    name: token,
    hasInlineValue: false,
    inlineValue: '',
  };
}

// ── Flag validation ─────────────────────────────────────────────────

/**
 * Validate flags/arguments of a tokenized command against a whitelist config.
 *
 * Walks through tokens after the command name, checking each flag against
 * the safeFlags map and validating argument types. Rejects unknown flags,
 * missing required arguments, and type-mismatched argument values.
 *
 * Handles edge cases:
 *   - POSIX `--` end-of-options marker (unless config disables it)
 *   - Inline values with `=` (including empty: `-E=`)
 *   - Combined short flags (`-la`)
 *   - Numeric shorthand for specific commands (git -<number>)
 *
 * @param tokens - Pre-tokenized string tokens from command-tokenizer
 * @param startIndex - Where to start validating (after command tokens)
 * @param config - The safe flags configuration for this command
 * @param options - Command-specific handling
 * @returns true if all flags are valid, false otherwise
 */
export function validateFlags(
  tokens: string[],
  startIndex: number,
  config: ExternalCommandConfig,
  options?: {
    commandName?: string;
    rawCommand?: string;
  },
): boolean {
  const cmdName = options?.commandName;
  const respectsEndOfOptions = config.respectsDoubleDash !== false;

  let pos = startIndex;

  while (pos < tokens.length) {
    const token = tokens[pos];
    if (token === undefined) {
      pos++;
      continue;
    }

    // ── End-of-options marker ──────────────────────────────────
    if (token === '--') {
      if (respectsEndOfOptions) {
        // Everything after -- is positional, skip validation
        break;
      }
      // Tool does not honor -- (e.g., pyright): keep validating
      pos++;
      continue;
    }

    // ── Flag token ─────────────────────────────────────────────
    if (token.startsWith('-') && token.length > 1 && FLAG_PATTERN.test(token)) {
      const parsed = parseFlagToken(token);

      // ── Attached numeric argument (e.g., -A20 on grep/rg) ──
      if (
        parsed.hasInlineValue &&
        parsed.name.length === 2 &&
        cmdName &&
        (cmdName === 'grep' || cmdName === 'rg')
      ) {
        const argType = config.safeFlags[parsed.name];
        if (argType && (argType === 'number' || argType === 'string')) {
          if (validateFlagArgument(parsed.inlineValue, argType)) {
            pos++;
            continue;
          }
          return false;
        }
      }

      // ── Git numeric shorthand: -<number> = -n <number> ──────
      if (
        cmdName === 'git' &&
        /^-\d+$/.test(token)
      ) {
        pos++;
        continue;
      }

      // ── Combined short flags (e.g., -la = -l -a) ───────────
      if (
        !parsed.name.startsWith('--') &&
        parsed.name.length > 2 &&
        !parsed.hasInlineValue
      ) {
        // Validate each letter as a separate flag
        for (let j = 1; j < parsed.name.length; j++) {
          const singleFlag = '-' + parsed.name[j];
          const flagType = config.safeFlags[singleFlag];
          if (flagType === undefined) return false;
          // Reject any bundled flag that takes an argument —
          // the next token could be ambiguous in a bundle.
          if (flagType !== 'none') return false;
        }
        pos++;
        continue;
      }

      // ── Look up flag in whitelist ───────────────────────────
      const flagArgType = config.safeFlags[parsed.name];
      if (flagArgType === undefined) return false;

      // ── No-argument flag ────────────────────────────────────
      if (flagArgType === 'none') {
        // Reject `--flag=` (explicit empty value for no-arg flag)
        if (parsed.hasInlineValue) return false;
        pos++;
        continue;
      }

      // ── Argument-requiring flag ─────────────────────────────
      let argValue: string;
      let advanceBy: number;

      if (parsed.hasInlineValue) {
        // Use the inline value (even if empty): --flag=value or --flag=
        argValue = parsed.inlineValue;
        advanceBy = 1;
      } else {
        // Consume the next token as the argument value
        const nextToken = tokens[pos + 1];
        const nextIsFlag =
          nextToken !== undefined &&
          nextToken.startsWith('-') &&
          nextToken.length > 1 &&
          FLAG_PATTERN.test(nextToken);

        if (pos + 1 >= tokens.length || (nextIsFlag && pos + 2 > tokens.length)) {
          return false; // Missing required argument
        }

        argValue = nextToken ?? '';
        advanceBy = 2;
      }

      // ── Defense: reject values starting with `-` for string args ─
      // This prevents a flag typed as 'string' (but actually no-arg)
      // from being exploited by passing a flag as its "value".
      // Exception: git --sort allows `-` prefix for reverse sorting.
      if (flagArgType === 'string' && argValue.startsWith('-')) {
        if (
          parsed.name !== '--sort' ||
          cmdName !== 'git' ||
          !/^-[a-zA-Z]/.test(argValue)
        ) {
          return false;
        }
      }

      if (!validateFlagArgument(argValue, flagArgType)) return false;

      pos += advanceBy;
    } else {
      // Non-flag argument (revision, path, etc.) — allowed
      pos++;
    }
  }

  // ── Post-validation callback ─────────────────────────────────
  if (config.additionalCommandIsDangerousCallback) {
    const args = tokens.slice(startIndex);
    if (config.additionalCommandIsDangerousCallback(options?.rawCommand ?? '', args)) {
      return false;
    }
  }

  return true;
}
