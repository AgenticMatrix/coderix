/**
 * Bash security check — combines tokenizer, classifier, whitelist,
 * flag-validator, and dangerous-pattern detectors into a single
 * pre-execution safety check.
 *
 * This is installed as the PreExecSecurityCheck hook in executor.ts
 * via index.ts at plugin load time.
 *
 * ## Two-tier architecture
 *
 * **Hard blocks** (executor-level, never ask):
 *   Patterns so dangerous they must never execute: fork bombs,
 *   command/process substitution, dangerous redirects, privilege
 *   escalation, and dangerous Git operations (force push, hard reset).
 *   These are blocked unconditionally — the LLM gets an error.
 *
 * **Soft blocks** (delegated to permission layer, can ask):
 *   Code exec interpreters, dangerous builtins, destructive commands,
 *   and network exfil commands.  These are NOT blocked by this check.
 *   Instead they are classified as CODE_EXEC / DESTRUCTIVE / NETWORK
 *   and the permission engine in query.ts decides:
 *   - PLAN mode → deny
 *   - ASK mode → prompt user for confirmation
 *   - AUTO mode → allow
 */

import { CommandCategory } from './command-classifier.js';
import type { ClassificationResult } from './command-classifier.js';
import type { PreExecSecurityCheck, SecurityCheckResult } from './executor.js';
import { matchReadOnlyCommand } from './read-only-whitelist.js';
import {
  checkDangerousPatterns,
  startsWithCodeInterpreter,
  startsWithDangerousBuiltin,
  startsWithDestructiveCommand,
  isNetworkExfilCommand,
  containsCommandSubstitution,
  containsProcessSubstitution,
} from './dangerous-patterns.js';

// ── Security check factory ──────────────────────────────────────────

export interface SecurityCheckOptions {
  /** When true, commands that fall through all checks are allowed
   *  as MUTATION rather than being blocked. Default: true. */
  allowUnknownCommands?: boolean;

  /** When true, command substitution is hard-blocked. Default: true. */
  blockCommandSubstitution?: boolean;

  /** When true, process substitution is hard-blocked. Default: true. */
  blockProcessSubstitution?: boolean;
}

/**
 * Create the pre-execution security check function.
 *
 * ## Check order
 *
 * ### Hard blocks — blocked unconditionally, never ask
 * 1. Fork bombs → BLOCKED (DESTRUCTIVE)
 * 2. Command substitution $(…) / backticks → BLOCKED (CODE_EXEC)
 * 3. Process substitution <() / >() → BLOCKED (CODE_EXEC)
 * 4. Dangerous redirects (> /dev/sda, >> /etc/passwd) → BLOCKED (DESTRUCTIVE)
 * 5. Privilege escalation (chmod +s, chown root) → BLOCKED (DESTRUCTIVE)
 * 6. Dangerous Git operations (force push, hard reset, amend) → BLOCKED (DESTRUCTIVE)
 *
 * ### Soft classification — passed to permission layer for ASK
 * 7. Code exec interpreters (python, node, bash -c, etc.) → ALLOWED,
 *    classified CODE_EXEC → permission layer shows ASK prompt
 * 8. Dangerous builtins (eval, sudo, xargs) → ALLOWED,
 *    classified CODE_EXEC/DESTRUCTIVE → permission layer shows ASK prompt
 * 9. Destructive commands (rm, dd) → ALLOWED,
 *    classified DESTRUCTIVE → permission layer shows ASK prompt
 * 10. Network exfil commands (curl POST, nc, ssh) → ALLOWED,
 *     classified NETWORK → permission layer shows ASK prompt
 *
 * ### Safe
 * 11. Read-only whitelist match → ALLOWED (READ_ONLY, concurrency-safe)
 * 12. Default → ALLOWED as MUTATION (unless allowUnknownCommands=false)
 */
export function createBashSecurityCheck(
  options?: SecurityCheckOptions,
): PreExecSecurityCheck {
  const opts: Required<SecurityCheckOptions> = {
    allowUnknownCommands: options?.allowUnknownCommands ?? true,
    blockCommandSubstitution: options?.blockCommandSubstitution ?? true,
    blockProcessSubstitution: options?.blockProcessSubstitution ?? true,
  };

  return (
    command: string,
    tokens: string[],
    _cwd: string,
  ): SecurityCheckResult => {
    // ═══════════════════════════════════════════════════════════════
    // HARD BLOCKS — unconditionally denied, never reach ASK
    // ═══════════════════════════════════════════════════════════════

    // ── 1. Fork bombs, dangerous redirects, privilege escalation, git danger ─
    const dangerous = checkDangerousPatterns(command, tokens);
    if (dangerous?.dangerous) {
      return {
        allowed: false,
        reason: dangerous.reason || 'Dangerous command pattern detected',
        classification: {
          category: CommandCategory.DESTRUCTIVE,
          isReadOnly: false,
          isConcurrencySafe: false,
          reason: dangerous.reason || 'Dangerous command pattern detected',
        },
      };
    }

    // ── 2. Command substitution $(…) / backticks ─────────────────
    if (opts.blockCommandSubstitution && containsCommandSubstitution(command)) {
      return {
        allowed: false,
        reason: 'Command substitution is not allowed ($(...) or backticks)',
        classification: {
          category: CommandCategory.CODE_EXEC,
          isReadOnly: false,
          isConcurrencySafe: false,
          reason: 'Command substitution detected',
        },
      };
    }

    // ── 3. Process substitution <() / >() ────────────────────────
    if (opts.blockProcessSubstitution && containsProcessSubstitution(command)) {
      return {
        allowed: false,
        reason: 'Process substitution is not allowed (<() or >())',
        classification: {
          category: CommandCategory.CODE_EXEC,
          isReadOnly: false,
          isConcurrencySafe: false,
          reason: 'Process substitution detected',
        },
      };
    }

    // ═══════════════════════════════════════════════════════════════
    // SOFT BLOCKS — allowed here, classified for permission layer
    //
    // These commands are NOT blocked at the executor level. Instead
    // they are classified with their danger category and the
    // permission engine in query.ts decides based on the current mode:
    //   PLAN → deny with explanation
    //   ASK  → show user a confirmation prompt
    //   AUTO → allow
    // ═══════════════════════════════════════════════════════════════

    // ── 4. Code exec interpreters (python -c, node -e, bash -c…) ──
    if (startsWithCodeInterpreter(tokens)) {
      const interpreter = tokens[0] || 'unknown';
      const detail = interpreter === 'env'
        ? `env with code interpreter (${tokens.slice(1).filter(t => !t.includes('=')).join(' ')})`
        : interpreter;
      return {
        allowed: true,
        classification: {
          category: CommandCategory.CODE_EXEC,
          isReadOnly: false,
          isConcurrencySafe: false,
          reason: `Code execution via '${detail}' — ${interpreter} is a code interpreter`,
        },
      };
    }

    // ── 5. Dangerous builtins (eval, sudo, xargs…) ────────────────
    if (startsWithDangerousBuiltin(tokens)) {
      const builtin = tokens[0] || 'unknown';
      const category =
        builtin === 'sudo' || builtin === 'su' || builtin === 'pkexec'
          ? CommandCategory.DESTRUCTIVE
          : CommandCategory.CODE_EXEC;
      return {
        allowed: true,
        classification: {
          category,
          isReadOnly: false,
          isConcurrencySafe: false,
          reason: `'${builtin}' is a dangerous command — ${category === CommandCategory.CODE_EXEC ? 'code execution' : 'privilege escalation'} risk`,
        },
      };
    }

    // ── 6. Destructive commands (rm, dd, mkfs…) ───────────────────
    if (startsWithDestructiveCommand(tokens)) {
      const cmd = tokens[0] || 'unknown';
      return {
        allowed: true,
        classification: {
          category: CommandCategory.DESTRUCTIVE,
          isReadOnly: false,
          isConcurrencySafe: false,
          reason: `'${cmd}' can cause data loss`,
        },
      };
    }

    // ── 7. Network exfiltration (curl POST, nc, ssh…) ─────────────
    if (isNetworkExfilCommand(tokens, command)) {
      const cmd = tokens[0] || 'unknown';
      return {
        allowed: true,
        classification: {
          category: CommandCategory.NETWORK,
          isReadOnly: false,
          isConcurrencySafe: false,
          reason: `'${cmd}' can send data over the network`,
        },
      };
    }

    // ═══════════════════════════════════════════════════════════════
    // SAFE — whitelist match or fall-through
    // ═══════════════════════════════════════════════════════════════

    // ── 8. Read-only whitelist ────────────────────────────────────
    const whitelistResult = matchReadOnlyCommand(tokens, command);
    if (whitelistResult.isReadOnly) {
      return {
        allowed: true,
        classification: {
          category: CommandCategory.READ_ONLY,
          isReadOnly: true,
          isConcurrencySafe: true,
          reason: whitelistResult.reason,
        },
      };
    }

    // ── 9. Default: unknown command ───────────────────────────────
    if (!opts.allowUnknownCommands) {
      return {
        allowed: false,
        reason: 'Command not on the read-only whitelist (strict mode)',
        classification: {
          category: CommandCategory.UNKNOWN,
          isReadOnly: false,
          isConcurrencySafe: false,
          reason: whitelistResult.reason,
        },
      };
    }

    // Allow as MUTATION — permission layer decides
    return {
      allowed: true,
      classification: {
        category: CommandCategory.UNKNOWN,
        isReadOnly: false,
        isConcurrencySafe: false,
        reason: 'Command not classified — treated as mutation',
      },
    };
  };
}
