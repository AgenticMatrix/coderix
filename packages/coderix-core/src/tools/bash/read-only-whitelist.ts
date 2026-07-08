/**
 * Read-only command whitelist for bash security.
 *
 * Two-tier classification:
 *
 * 1. Inherently safe commands — commands whose flags don't change outcome
 *    (cat, ls, wc, etc.). No per-flag validation needed.
 *
 * 2. Safe-with-constraints commands — commands that are safe ONLY with
 *    specific flags (git diff, rg, etc.). Each entry defines the safe flag
 *    set and optional additional checks.
 */

import type { ExternalCommandConfig } from './flag-validator.js';
import { validateFlags } from './flag-validator.js';

// ── Inherently safe commands (no flag validation needed) ────────────

/**
 * Commands that are read-only regardless of their flags.
 * These tools produce output without side effects.
 */
export const SIMPLE_READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  // Output / display
  'cat', 'head', 'tail', 'tac', 'echo', 'printf', 'yes',
  // Counting / statistics
  'wc', 'sort', 'uniq', 'cut', 'tr',
  // Search
  'grep', 'egrep', 'fgrep',
  // Listing / inspection
  'find', 'ls', 'file', 'stat',
  // Disk usage
  'du', 'df',
  // Command location / identity
  'which', 'whereis', 'type', 'command',
  'pwd', 'whoami', 'id', 'uname', 'hostname', 'arch',
  // Date / time
  'date', 'cal',
  // Path utilities
  'dirname', 'basename', 'realpath', 'readlink',
  // Conditionals
  'test', '[', 'true', 'false',
  // Math
  'expr', 'seq',
  // Text processing (read-only: no -i flag usage tracked at classification layer)
  'awk', 'sed',
  // File comparison
  'diff', 'cmp', 'comm',
  // Environment
  'printenv', 'env',
  // Version info — these are interpreters, but running with no args is read-only
  'node', 'python', 'python3', 'ruby', 'perl',
  // Windows: read-only built-in commands
  'dir', 'type', 'findstr', 'where', 'whoami',
  'tasklist', 'systeminfo', 'ver', 'hostname',
  'netstat', 'ipconfig', 'ping', 'tracert', 'nslookup',
  // PowerShell: read-only cmdlets
  'Get-ChildItem', 'Get-Content', 'Get-Process', 'Get-Service',
  'Select-String', 'Get-Location', 'Get-Date', 'Get-Help',
  'Get-Command', 'Get-Module', 'Get-Variable', 'Get-ChildItem',
]);

/**
 * Two-word commands that are inherently read-only.
 */
export const SIMPLE_READ_ONLY_TWO_WORD: ReadonlySet<string> = new Set([
  'docker ps',
  'docker images',
  'docker info',
  'docker version',
]);

// ── Flag groups (reusable across commands) ────────────────────────

type FlagSet = Record<string, import('./flag-validator.js').FlagArgType>;

const NONE = 'none' as const;
const NUM = 'number' as const;
const STR = 'string' as const;

/** Reference selection flags (branches, tags, remotes). */
function refSelectionFlags(): FlagSet {
  return {
    '--all': NONE, '--branches': NONE, '--tags': NONE, '--remotes': NONE,
  };
}

/** Date filter flags. */
function dateFilterFlags(): FlagSet {
  return {
    '--since': STR, '--after': STR, '--until': STR, '--before': STR,
  };
}

/** Log display formatting flags. */
function logDisplayFlags(): FlagSet {
  return {
    '--oneline': NONE, '--graph': NONE, '--decorate': NONE,
    '--no-decorate': NONE, '--date': STR, '--relative-date': NONE,
  };
}

/** Count limiting flags. */
function countFlags(): FlagSet {
  return { '--max-count': NUM, '-n': NUM };
}

/** Stat/diff summary flags. */
function statDisplayFlags(): FlagSet {
  return {
    '--stat': NONE, '--numstat': NONE, '--shortstat': NONE,
    '--name-only': NONE, '--name-status': NONE,
  };
}

/** Color control flags. */
function colorFlags(): FlagSet {
  return { '--color': NONE, '--no-color': NONE };
}

/** Patch display flags. */
function patchFlags(): FlagSet {
  return {
    '--patch': NONE, '-p': NONE, '--no-patch': NONE,
    '--no-ext-diff': NONE, '-s': NONE,
  };
}

/** Author / committer / message search flags. */
function authorFilterFlags(): FlagSet {
  return { '--author': STR, '--committer': STR, '--grep': STR };
}

// ── Callback: detect branch/tag creation from positional args ───────

/**
 * Build a callback that blocks positional arguments when a required flag
 * (like --list) is absent. Used for commands where positional args mean
 * "create" (git branch, git tag).
 */
function requireListFlagCallback(
  listFlagNames: ReadonlySet<string>,
): (rawCommand: string, args: string[]) => boolean {
  return (_rawCommand, args) => {
    const flagsConsumingArgs = new Set([
      '--contains', '--no-contains', '--points-at', '--sort', '--format',
      '-n',
    ]);
    const flagsWithOptionalArgs = new Set(['--merged', '--no-merged']);

    let seenList = false;
    let seenDashDash = false;
    let lastFlag = '';
    let i = 0;

    while (i < args.length) {
      const tok = args[i];
      if (!tok) { i++; continue; }

      // End-of-options
      if (tok === '--' && !seenDashDash) {
        seenDashDash = true;
        lastFlag = '';
        i++;
        continue;
      }

      if (!seenDashDash && tok.startsWith('-')) {
        // Check if this flag (or any letter in a bundle) is the list flag
        if (listFlagNames.has(tok)) {
          seenList = true;
        } else if (
          tok[0] === '-' && tok[1] !== '-' && tok.length > 2 &&
          !tok.includes('=')
        ) {
          // Short flag bundle: check if -l is in the bundle
          for (let j = 1; j < tok.length; j++) {
            if (listFlagNames.has('-' + tok[j])) {
              seenList = true;
              break;
            }
          }
        }

        // Advance past this flag and its argument
        if (tok.includes('=')) {
          lastFlag = tok.split('=')[0] ?? '';
          i++;
        } else if (flagsConsumingArgs.has(tok)) {
          lastFlag = tok;
          i += 2;
        } else {
          lastFlag = tok;
          i++;
        }
      } else {
        // Positional argument: dangerous unless list was requested
        const lastHadOptionalArg = flagsWithOptionalArgs.has(lastFlag);
        if (!seenList && !lastHadOptionalArg) {
          return true; // dangerous — would create a branch/tag
        }
        i++;
      }
    }
    return false;
  };
}

// ── Callback: block dangerous subcommands ───────────────────────────

/**
 * Build a callback that blocks specific subcommand names.
 */
function blockSubcommandsCallback(
  blockedCommands: ReadonlySet<string>,
): (rawCommand: string, args: string[]) => boolean {
  return (_rawCommand, args) => {
    for (const token of args) {
      if (!token || token.startsWith('-')) continue;
      if (blockedCommands.has(token)) return true;
      return false; // first positional determines the subcommand
    }
    return false;
  };
}

// ── Callback: allow only exact flags (no positional args) ───────────

function noPositionalArgsCallback(
  allowedFlags: ReadonlySet<string>,
): (rawCommand: string, args: string[]) => boolean {
  return (_rawCommand, args) => {
    return args.some(a => !allowedFlags.has(a));
  };
}

// ── Whitelist definition ────────────────────────────────────────────

/**
 * Commands that are read-only ONLY with restricted flag sets.
 *
 * Each entry maps a command key (e.g. "git diff") to its safe flags
 * and optional danger-detection callback.
 */
export const READ_ONLY_COMMANDS: Record<string, ExternalCommandConfig> = {
  // ═══ git diff ═══════════════════════════════════════════════════════
  'git diff': {
    safeFlags: {
      ...statDisplayFlags(),
      ...colorFlags(),
      '--dirstat': NONE, '--summary': NONE, '--patch-with-stat': NONE,
      '--word-diff': NONE, '--word-diff-regex': STR, '--color-words': NONE,
      '--no-renames': NONE, '--check': NONE, '--ws-error-highlight': STR,
      '--full-index': NONE, '--binary': NONE, '--abbrev': NUM,
      '--break-rewrites': NONE, '--find-renames': NONE,
      '--find-copies': NONE, '--find-copies-harder': NONE,
      '--irreversible-delete': NONE, '--diff-algorithm': STR,
      '--histogram': NONE, '--patience': NONE, '--minimal': NONE,
      '--ignore-space-at-eol': NONE, '--ignore-space-change': NONE,
      '--ignore-all-space': NONE, '--ignore-blank-lines': NONE,
      '--inter-hunk-context': NUM, '--function-context': NONE,
      '--exit-code': NONE, '--quiet': NONE,
      '--cached': NONE, '--staged': NONE,
      '--pickaxe-regex': NONE, '--pickaxe-all': NONE,
      '--no-index': NONE, '--relative': STR, '--diff-filter': STR,
      '-p': NONE, '-u': NONE, '-M': NONE, '-C': NONE, '-B': NONE,
      '-D': NONE, '-l': NONE, '-R': NONE,
      // String args (not none — they consume the next token):
      '-S': STR, '-G': STR, '-O': STR,
    },
  },

  // ═══ git log ════════════════════════════════════════════════════════
  'git log': {
    safeFlags: {
      ...logDisplayFlags(),
      ...refSelectionFlags(),
      ...dateFilterFlags(),
      ...countFlags(),
      ...statDisplayFlags(),
      ...colorFlags(),
      ...patchFlags(),
      ...authorFilterFlags(),
      '--abbrev-commit': NONE, '--full-history': NONE,
      '--dense': NONE, '--sparse': NONE, '--simplify-merges': NONE,
      '--ancestry-path': NONE, '--source': NONE,
      '--first-parent': NONE, '--merges': NONE, '--no-merges': NONE,
      '--reverse': NONE, '--walk-reflogs': NONE,
      '--skip': NUM, '--max-age': NUM, '--min-age': NUM,
      '--no-min-parents': NONE, '--no-max-parents': NONE,
      '--follow': NONE, '--no-walk': NONE,
      '--left-right': NONE, '--cherry-mark': NONE, '--cherry-pick': NONE,
      '--boundary': NONE, '--topo-order': NONE, '--date-order': NONE,
      '--author-date-order': NONE, '--pretty': STR, '--format': STR,
      '--diff-filter': STR,
      '-S': STR, '-G': STR, '--pickaxe-regex': NONE, '--pickaxe-all': NONE,
    },
  },

  // ═══ git show ═══════════════════════════════════════════════════════
  'git show': {
    safeFlags: {
      ...logDisplayFlags(),
      ...statDisplayFlags(),
      ...colorFlags(),
      ...patchFlags(),
      '--abbrev-commit': NONE,
      '--word-diff': NONE, '--word-diff-regex': STR, '--color-words': NONE,
      '--pretty': STR, '--format': STR,
      '--first-parent': NONE, '--raw': NONE, '--diff-filter': STR,
      '-m': NONE, '--quiet': NONE,
    },
  },

  // ═══ git status ═════════════════════════════════════════════════════
  'git status': {
    safeFlags: {
      '--short': NONE, '-s': NONE, '--branch': NONE, '-b': NONE,
      '--porcelain': NONE, '--long': NONE,
      '--verbose': NONE, '-v': NONE,
      '--untracked-files': STR, '-u': STR,
      '--ignored': NONE, '--ignore-submodules': STR,
      '--column': NONE, '--no-column': NONE,
      '--ahead-behind': NONE, '--no-ahead-behind': NONE,
      '--renames': NONE, '--no-renames': NONE,
      '--find-renames': STR, '-M': STR,
    },
  },

  // ═══ git branch (list only — creation blocked by callback) ═════════
  'git branch': {
    safeFlags: {
      '-l': NONE, '--list': NONE, '-a': NONE, '--all': NONE,
      '-r': NONE, '--remotes': NONE,
      '-v': NONE, '-vv': NONE, '--verbose': NONE,
      '--color': NONE, '--no-color': NONE,
      '--column': NONE, '--no-column': NONE,
      '--abbrev': NUM, '--no-abbrev': NONE,
      '--contains': STR, '--no-contains': STR,
      '--merged': NONE, '--no-merged': NONE,
      '--points-at': STR, '--sort': STR, '--show-current': NONE,
      '-i': NONE, '--ignore-case': NONE,
    },
    additionalCommandIsDangerousCallback: requireListFlagCallback(
      new Set(['--list', '-l']),
    ),
  },

  // ═══ git tag (list only — creation blocked by callback) ════════════
  'git tag': {
    safeFlags: {
      '-l': NONE, '--list': NONE, '-n': NUM,
      '--contains': STR, '--no-contains': STR,
      '--merged': STR, '--no-merged': STR,
      '--sort': STR, '--format': STR, '--points-at': STR,
      '--column': NONE, '--no-column': NONE,
      '-i': NONE, '--ignore-case': NONE,
    },
    additionalCommandIsDangerousCallback: requireListFlagCallback(
      new Set(['--list', '-l']),
    ),
  },

  // ═══ git stash list ════════════════════════════════════════════════
  'git stash list': {
    safeFlags: {
      ...logDisplayFlags(), ...refSelectionFlags(), ...countFlags(),
    },
  },

  // ═══ git reflog (show only — expire/delete blocked) ════════════════
  'git reflog': {
    safeFlags: {
      ...logDisplayFlags(),
      ...refSelectionFlags(),
      ...dateFilterFlags(),
      ...countFlags(),
      ...authorFilterFlags(),
    },
    additionalCommandIsDangerousCallback: blockSubcommandsCallback(
      new Set(['expire', 'delete', 'exists']),
    ),
  },

  // ═══ git blame ══════════════════════════════════════════════════════
  'git blame': {
    safeFlags: {
      ...colorFlags(),
      '-L': STR, '--porcelain': NONE, '-p': NONE,
      '--line-porcelain': NONE, '--incremental': NONE,
      '--root': NONE, '--show-stats': NONE,
      '--show-name': NONE, '--show-number': NONE,
      '-n': NONE, '--show-email': NONE, '-e': NONE,
      '-f': NONE, '--date': STR, '-w': NONE,
      '--ignore-rev': STR, '--ignore-revs-file': STR,
      '-M': NONE, '-C': NONE, '--score-debug': NONE,
      '--abbrev': NUM, '-s': NONE, '-l': NONE, '-t': NONE,
    },
  },

  // ═══ git ls-files ═══════════════════════════════════════════════════
  'git ls-files': {
    safeFlags: {
      '--cached': NONE, '-c': NONE, '--deleted': NONE, '-d': NONE,
      '--modified': NONE, '-m': NONE, '--others': NONE, '-o': NONE,
      '--ignored': NONE, '-i': NONE, '--stage': NONE, '-s': NONE,
      '--killed': NONE, '-k': NONE, '--unmerged': NONE, '-u': NONE,
      '--directory': NONE, '--no-empty-directory': NONE,
      '--eol': NONE, '--full-name': NONE, '--abbrev': NUM,
      '--debug': NONE, '-z': NONE, '-t': NONE, '-v': NONE, '-f': NONE,
      '--exclude': STR, '-x': STR, '--exclude-from': STR, '-X': STR,
      '--exclude-per-directory': STR, '--exclude-standard': NONE,
      '--error-unmatch': NONE, '--recurse-submodules': NONE,
    },
  },

  // ═══ git ls-remote ══════════════════════════════════════════════════
  'git ls-remote': {
    safeFlags: {
      '--branches': NONE, '-b': NONE, '--tags': NONE, '-t': NONE,
      '--heads': NONE, '-h': NONE, '--refs': NONE,
      '--quiet': NONE, '-q': NONE, '--exit-code': NONE,
      '--get-url': NONE, '--symref': NONE, '--sort': STR,
      // --server-option / -o excluded: transmits to remote server
    },
  },

  // ═══ git remote (show only — subcommands blocked) ══════════════════
  'git remote': {
    safeFlags: { '-v': NONE, '--verbose': NONE },
    additionalCommandIsDangerousCallback: noPositionalArgsCallback(
      new Set(['-v', '--verbose']),
    ),
  },

  // ═══ git grep ═══════════════════════════════════════════════════════
  'git grep': {
    safeFlags: {
      '-e': STR, '-E': NONE, '--extended-regexp': NONE,
      '-G': NONE, '--basic-regexp': NONE,
      '-F': NONE, '--fixed-strings': NONE,
      '-P': NONE, '--perl-regexp': NONE,
      '-i': NONE, '--ignore-case': NONE,
      '-v': NONE, '--invert-match': NONE,
      '-w': NONE, '--word-regexp': NONE,
      '-n': NONE, '--line-number': NONE,
      '-c': NONE, '--count': NONE,
      '-l': NONE, '--files-with-matches': NONE,
      '-L': NONE, '--files-without-match': NONE,
      '-h': NONE, '-H': NONE, '--heading': NONE, '--break': NONE,
      '--full-name': NONE, '--color': NONE, '--no-color': NONE,
      '-o': NONE, '--only-matching': NONE,
      '-A': NUM, '--after-context': NUM,
      '-B': NUM, '--before-context': NUM,
      '-C': NUM, '--context': NUM,
      '--and': NONE, '--or': NONE, '--not': NONE,
      '--max-depth': NUM, '--untracked': NONE, '--no-index': NONE,
      '--recurse-submodules': NONE, '--cached': NONE,
      '--threads': NUM, '-q': NONE, '--quiet': NONE,
    },
  },

  // ═══ git rev-parse ══════════════════════════════════════════════════
  'git rev-parse': {
    safeFlags: {
      '--verify': NONE, '--short': STR, '--abbrev-ref': NONE,
      '--symbolic': NONE, '--symbolic-full-name': NONE,
      '--show-toplevel': NONE, '--show-cdup': NONE, '--show-prefix': NONE,
      '--git-dir': NONE, '--git-common-dir': NONE, '--absolute-git-dir': NONE,
      '--show-superproject-working-tree': NONE,
      '--is-inside-work-tree': NONE, '--is-inside-git-dir': NONE,
      '--is-bare-repository': NONE, '--is-shallow-repository': NONE,
      '--path-prefix': NONE,
    },
  },

  // ═══ git rev-list ═══════════════════════════════════════════════════
  'git rev-list': {
    safeFlags: {
      ...refSelectionFlags(), ...dateFilterFlags(), ...countFlags(),
      ...authorFilterFlags(),
      '--count': NONE, '--reverse': NONE, '--first-parent': NONE,
      '--ancestry-path': NONE, '--merges': NONE, '--no-merges': NONE,
      '--min-parents': NUM, '--max-parents': NUM,
      '--no-min-parents': NONE, '--no-max-parents': NONE,
      '--skip': NUM, '--max-age': NUM, '--min-age': NUM,
      '--walk-reflogs': NONE, '--oneline': NONE, '--abbrev-commit': NONE,
      '--pretty': STR, '--format': STR, '--abbrev': NUM,
      '--full-history': NONE, '--dense': NONE, '--sparse': NONE,
      '--source': NONE, '--graph': NONE,
    },
  },

  // ═══ git describe ═══════════════════════════════════════════════════
  'git describe': {
    safeFlags: {
      '--tags': NONE, '--match': STR, '--exclude': STR,
      '--long': NONE, '--abbrev': NUM, '--always': NONE,
      '--contains': NONE, '--first-match': NONE, '--exact-match': NONE,
      '--candidates': NUM, '--dirty': NONE, '--broken': NONE,
    },
  },

  // ═══ git shortlog ═══════════════════════════════════════════════════
  'git shortlog': {
    safeFlags: {
      ...refSelectionFlags(), ...dateFilterFlags(),
      '-s': NONE, '--summary': NONE, '-n': NONE, '--numbered': NONE,
      '-e': NONE, '--email': NONE, '-c': NONE, '--committer': NONE,
      '--group': STR, '--format': STR, '--no-merges': NONE,
      '--author': STR,
    },
  },

  // ═══ git merge-base ═════════════════════════════════════════════════
  'git merge-base': {
    safeFlags: {
      '--is-ancestor': NONE, '--fork-point': NONE,
      '--octopus': NONE, '--independent': NONE, '--all': NONE,
    },
  },

  // ═══ git config --get ═══════════════════════════════════════════════
  'git config --get': {
    safeFlags: {
      '--local': NONE, '--global': NONE, '--system': NONE,
      '--worktree': NONE, '--default': STR, '--type': STR,
      '--bool': NONE, '--int': NONE, '--bool-or-int': NONE,
      '--path': NONE, '--expiry-date': NONE,
      '-z': NONE, '--null': NONE, '--name-only': NONE,
      '--show-origin': NONE, '--show-scope': NONE,
    },
  },

  // ═══ git for-each-ref ═══════════════════════════════════════════════
  'git for-each-ref': {
    safeFlags: {
      '--format': STR, '--sort': STR, '--count': NUM,
      '--contains': STR, '--no-contains': STR,
      '--merged': STR, '--no-merged': STR, '--points-at': STR,
    },
  },

  // ═══ git cat-file ═══════════════════════════════════════════════════
  'git cat-file': {
    safeFlags: {
      '-t': NONE, '-s': NONE, '-p': NONE, '-e': NONE,
      '--batch-check': NONE, '--allow-undetermined-type': NONE,
    },
  },

  // ═══ ripgrep ════════════════════════════════════════════════════════
  'rg': {
    safeFlags: {
      // Pattern
      '-e': STR, '--regexp': STR, '-f': STR,
      // Case
      '-i': NONE, '--ignore-case': NONE,
      '-S': NONE, '--smart-case': NONE,
      // Match mode
      '-F': NONE, '--fixed-strings': NONE,
      '-w': NONE, '--word-regexp': NONE,
      '-v': NONE, '--invert-match': NONE,
      // Output
      '-c': NONE, '--count': NONE,
      '-l': NONE, '--files-with-matches': NONE,
      '--files-without-match': NONE,
      '-n': NONE, '--line-number': NONE,
      '-o': NONE, '--only-matching': NONE,
      // Context
      '-A': NUM, '--after-context': NUM,
      '-B': NUM, '--before-context': NUM,
      '-C': NUM, '--context': NUM,
      // Display
      '-H': NONE, '-h': NONE, '--heading': NONE, '--no-heading': NONE,
      '-q': NONE, '--quiet': NONE, '--column': NONE,
      // File filtering
      '-g': STR, '--glob': STR,
      '-t': STR, '--type': STR,
      '-T': STR, '--type-not': STR,
      '--type-list': NONE, '--hidden': NONE,
      '--no-ignore': NONE, '-u': NONE,
      // Limits
      '-m': NUM, '--max-count': NUM,
      '-d': NUM, '--max-depth': NUM,
      // Misc
      '-a': NONE, '--text': NONE, '-z': NONE, '-L': NONE,
      '--follow': NONE,
      '--color': STR, '--json': NONE, '--stats': NONE,
      '--help': NONE, '--version': NONE, '--debug': NONE,
      '--': NONE,
    },
  },
};

// ── Classification helpers ──────────────────────────────────────────

export interface ReadOnlyMatchResult {
  isReadOnly: boolean;
  reason: string;
}

/**
 * Check if a tokenized command is on the read-only whitelist.
 *
 * Matching is attempted in order:
 *   1. Simple single-word commands (inherently safe)
 *   2. Simple two-word commands (inherently safe)
 *   3. Multi-word commands with flag validation
 *   4. Single-word commands with flag validation
 *
 * @param tokens - Tokenized command tokens
 * @param rawCommand - Original raw command string
 * @returns Match result with isReadOnly flag and human-readable reason
 */
export function matchReadOnlyCommand(
  tokens: string[],
  rawCommand: string,
): ReadOnlyMatchResult {
  if (tokens.length === 0) {
    return { isReadOnly: false, reason: 'Empty command' };
  }

  const firstToken = tokens[0] ?? '';

  // Level 1: Single-word inherently safe
  if (SIMPLE_READ_ONLY_COMMANDS.has(firstToken)) {
    return {
      isReadOnly: true,
      reason: `'${firstToken}' is a read-only command`,
    };
  }

  // Level 2: Two-word inherently safe
  if (tokens.length >= 2) {
    const twoWord = `${firstToken} ${tokens[1]}`;
    if (SIMPLE_READ_ONLY_TWO_WORD.has(twoWord)) {
      return {
        isReadOnly: true,
        reason: `'${twoWord}' is a read-only command`,
      };
    }
  }

  // Level 3: Commands requiring flag validation
  const bestMatch = findBestCommandMatch(tokens, firstToken);
  if (!bestMatch) {
    return {
      isReadOnly: false,
      reason: 'Command not in read-only whitelist',
    };
  }

  const config = READ_ONLY_COMMANDS[bestMatch.key];
  if (!config) {
    return { isReadOnly: false, reason: 'Whitelist entry missing config' };
  }

  // Run flag validation
  const valid = validateFlags(tokens, bestMatch.skipTokens, config, {
    commandName: firstToken,
    rawCommand,
  });

  if (valid) {
    return {
      isReadOnly: true,
      reason: `'${bestMatch.key}' with validated flags is read-only`,
    };
  }

  return {
    isReadOnly: false,
    reason: `'${bestMatch.key}' has flags not in safe flag list`,
  };
}

/**
 * Find the best matching command key from the whitelist.
 *
 * Tries progressively shorter command keys:
 *   1. Three tokens: "git config --get", "git stash list"
 *   2. Two tokens: "git diff", "git log"
 *   3. One token: "rg"
 *
 * Returns the matched key and how many tokens to skip for flag validation.
 */
function findBestCommandMatch(
  tokens: string[],
  firstToken: string,
): { key: string; skipTokens: number } | null {
  // Try: first + second + third
  if (tokens.length >= 3) {
    const threeWord = `${firstToken} ${tokens[1]} ${tokens[2]}`;
    if (READ_ONLY_COMMANDS[threeWord]) {
      return { key: threeWord, skipTokens: 3 };
    }
  }

  // Try: first + second
  if (tokens.length >= 2) {
    const twoWord = `${firstToken} ${tokens[1]}`;
    if (READ_ONLY_COMMANDS[twoWord]) {
      return { key: twoWord, skipTokens: 2 };
    }
  }

  // Try: first only (e.g., "rg")
  if (READ_ONLY_COMMANDS[firstToken]) {
    return { key: firstToken, skipTokens: 1 };
  }

  return null;
}
