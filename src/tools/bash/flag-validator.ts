/**
 * Flag validation for read-only command whitelisting.
 *
 * Ported from claude-code-best's readOnlyCommandValidation.ts.
 * Validates that command flags/arguments are within the set of
 * known-safe flags defined in the read-only whitelist.
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
   * When false, the tool does NOT respect POSIX `--` end-of-options.
   * validateFlags will continue checking flags after `--` instead of breaking.
   * Default: true (most tools respect `--`).
   */
  respectsDoubleDash?: boolean;
}

// ── Flag pattern ────────────────────────────────────────────────────

/** Regex pattern to match valid flag names (letters, digits, underscores, hyphens). */
export const FLAG_PATTERN = /^-[a-zA-Z0-9_-]/;

// ── Argument validation ─────────────────────────────────────────────

/**
 * Validate a flag argument based on its expected type.
 */
export function validateFlagArgument(
  value: string,
  argType: FlagArgType,
): boolean {
  switch (argType) {
    case 'none':
      return false; // Should not have been called for 'none' type
    case 'number':
      return /^\d+$/.test(value);
    case 'string':
      return true; // Any string including empty is valid
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

// ── Flag validation ─────────────────────────────────────────────────

/**
 * Validates the flags/arguments portion of a tokenized command against a config.
 *
 * This is the flag-walking loop. It advances through tokens checking each
 * flag against the safeFlags map and validating argument types.
 *
 * Ported from claude-code-best's validateFlags() with the same parser-differential
 * fixes for security-critical edge cases.
 *
 * @param tokens - Pre-tokenized string tokens (from command-tokenizer.ts)
 * @param startIndex - Where to start validating (after command tokens, e.g. 2 for "git diff")
 * @param config - The safe flags config for this command
 * @param options - Command-specific handling
 * @returns true if all flags are valid, false otherwise
 */
export function validateFlags(
  tokens: string[],
  startIndex: number,
  config: ExternalCommandConfig,
  options?: {
    /** The first token (for command-specific handling like git numeric shorthand). */
    commandName?: string;
    /** Raw command string passed to additionalCommandIsDangerousCallback. */
    rawCommand?: string;
  },
): boolean {
  let i = startIndex;

  while (i < tokens.length) {
    const token = tokens[i];
    if (!token) {
      i++;
      continue;
    }

    // `--` end-of-options
    if (token === '--') {
      // SECURITY: Only break if the tool respects POSIX `--` (default: true).
      // Tools like pyright don't respect `--` — they treat it as a file path
      // and continue processing subsequent tokens as flags. Breaking here
      // would let `pyright -- --createstub os` auto-approve a file-write flag.
      if (config.respectsDoubleDash !== false) {
        i++;
        break; // Everything after -- is positional arguments
      }
      // Tool doesn't respect --: treat as positional arg, keep validating
      i++;
      continue;
    }

    // Flag token (starts with -)
    if (token.startsWith('-') && token.length > 1 && FLAG_PATTERN.test(token)) {
      // Handle --flag=value format
      // SECURITY: Track whether the token CONTAINS `=` separately from
      // whether the value is non-empty. `-E=` has `hasEquals=true` but
      // `inlineValue=''` (falsy). Without `hasEquals`, the falsy check
      // would fall through to "consume next token" — but GNU getopt
      // for short options with mandatory arg sees `-E=` as `-E` with
      // ATTACHED arg `=` (it doesn't strip `=` for short options).
      // Parser differential: validator advances 2 tokens, GNU advances 1.
      //
      // Fix: when hasEquals is true, use inlineValue (even if empty) as the
      // provided arg. validateFlagArgument('', 'EOF') → false → rejected.
      const hasEquals = token.includes('=');
      const [flag, ...valueParts] = token.split('=');
      const inlineValue = valueParts.join('=');

      if (!flag) {
        return false;
      }

      const flagArgType = config.safeFlags[flag];

      if (!flagArgType) {
        // Special case: git commands support -<number> as shorthand for -n <number>
        if (options?.commandName === 'git' && /^-\d+$/.test(flag)) {
          // This is equivalent to -n flag which is safe for git log/diff/show
          i++;
          continue;
        }

        // Handle flags with directly attached numeric arguments (e.g., -A20, -B10)
        // Only apply this special handling to grep and rg commands
        if (
          (options?.commandName === 'grep' || options?.commandName === 'rg') &&
          !flag.startsWith('--') &&
          flag.length > 2
        ) {
          const potentialFlag = flag.substring(0, 2); // e.g., '-A' from '-A20'
          const potentialValue = flag.substring(2); // e.g., '20' from '-A20'

          if (config.safeFlags[potentialFlag] && /^\d+$/.test(potentialValue)) {
            const attachedArgType = config.safeFlags[potentialFlag];
            if (attachedArgType === 'number' || attachedArgType === 'string') {
              if (validateFlagArgument(potentialValue, attachedArgType)) {
                i++;
                continue;
              } else {
                return false;
              }
            }
          }
        }

        // Handle combined single-letter flags like -la
        // SECURITY: We must NOT allow any bundled flag that takes an argument.
        // GNU getopt bundling semantics: when an arg-taking option appears LAST
        // in a bundle with no trailing chars, the NEXT argv element is consumed
        // as its argument. Our handler doesn't model this — reject any bundle
        // containing an arg-taking flag.
        if (!flag.startsWith('--') && flag.length > 2) {
          for (let j = 1; j < flag.length; j++) {
            const singleFlag = '-' + flag[j];
            const flagType = config.safeFlags[singleFlag];
            if (!flagType) {
              return false; // One of the combined flags is not safe
            }
            // SECURITY: Bundled flags must be no-arg type. An arg-taking flag
            // in a bundle consumes the NEXT token in GNU getopt, which our
            // handler doesn't model. Reject to avoid parser differential.
            if (flagType !== 'none') {
              return false; // Arg-taking flag in a bundle — cannot safely validate
            }
          }
          i++;
          continue;
        }

        return false; // Unknown flag
      }

      // Validate flag arguments
      if (flagArgType === 'none') {
        // SECURITY: hasEquals covers `-FLAG=` (empty inline). Without it,
        // `-FLAG=` with 'none' type would pass (inlineValue='' is falsy).
        if (hasEquals) {
          return false; // Flag should not have a value
        }
        i++;
      } else {
        let argValue: string;
        // SECURITY: Use hasEquals (not inlineValue truthiness). `-E=` must
        // NOT consume next token — the user explicitly provided empty value.
        if (hasEquals) {
          argValue = inlineValue;
          i++;
        } else {
          // Check if next token is the argument
          if (
            i + 1 >= tokens.length ||
            (tokens[i + 1] &&
              tokens[i + 1]!.startsWith('-') &&
              tokens[i + 1]!.length > 1 &&
              FLAG_PATTERN.test(tokens[i + 1]!))
          ) {
            return false; // Missing required argument
          }
          argValue = tokens[i + 1] || '';
          i += 2;
        }

        // Defense-in-depth: For string arguments, reject values that start with '-'
        // This prevents type confusion attacks where a flag marked as 'string'
        // but actually takes no arguments could be used to inject dangerous flags.
        // Exception: git's --sort flag can have values starting with '-' for reverse sorting.
        if (flagArgType === 'string' && argValue.startsWith('-')) {
          // Special case: git's --sort flag allows - prefix for reverse sorting
          if (
            flag === '--sort' &&
            options?.commandName === 'git' &&
            /^-[a-zA-Z]/.test(argValue)
          ) {
            // This looks like a reverse sort (e.g., -refname, -version:refname)
            // Allow it
          } else {
            return false;
          }
        }

        // Validate argument based on type
        if (!validateFlagArgument(argValue, flagArgType)) {
          return false;
        }
      }
    } else {
      // Non-flag argument (like revision specs, file paths, etc.) — this is allowed
      i++;
    }
  }

  // If there's an additional dangerous callback, run it now
  if (config.additionalCommandIsDangerousCallback) {
    const args = tokens.slice(startIndex);
    if (config.additionalCommandIsDangerousCallback(options?.rawCommand ?? '', args)) {
      return false;
    }
  }

  return true;
}
