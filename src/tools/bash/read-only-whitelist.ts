/**
 * Read-only command whitelist for bash security.
 *
 * Defines two levels of read-only commands:
 *
 * 1. SIMPLE_READ_ONLY_COMMANDS — commands with no dangerous flags
 *    (ls, cat, grep, etc.). No flag validation needed.
 *
 * 2. READ_ONLY_COMMANDS — commands that require flag validation
 *    (git diff, rg, etc.). Each entry defines safeFlags and
 *    optional additionalCommandIsDangerousCallback.
 *
 * Structure mirrors claude-code-best's readOnlyCommandValidation.ts
 * but with a pragmatic subset of the most common developer commands.
 */

import type { ExternalCommandConfig, FlagArgType } from './flag-validator.js';
import {
  validateFlags,
} from './flag-validator.js';

// ── Simple read-only commands (no flag validation needed) ────────────

/**
 * Commands that are inherently read-only and have no dangerous flags.
 * These are safe to run in any mode without additional validation.
 */
export const SIMPLE_READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  // File output
  'cat', 'head', 'tail', 'tac',
  // Counting / statistics
  'wc', 'sort', 'uniq', 'cut', 'tr',
  // Text search
  'grep', 'egrep', 'fgrep',
  // File listing
  'find', 'ls', 'file', 'stat',
  // Disk usage
  'du', 'df',
  // Command location
  'which', 'whereis', 'type', 'command',
  // System info
  'pwd', 'whoami', 'id', 'uname', 'hostname', 'arch',
  // Output
  'echo', 'printf', 'yes',
  // Date / time
  'date', 'cal',
  // Path utilities
  'dirname', 'basename', 'realpath', 'readlink',
  // Conditionals and basic utils
  'test', '[', 'true', 'false',
  // Math
  'expr', 'seq',
  // Text processing (read-only usage: no -i flag)
  'awk', 'sed',
  // File comparison
  'diff', 'cmp', 'comm',
  // Environment
  'printenv', 'env',
  // Version info
  'node',
  'python', 'python3',
  'ruby',
  'perl',
]);

// ── Simple read-only two-word commands ───────────────────────────────

/**
 * Two-word commands that are inherently read-only.
 * These don't need flag validation.
 */
export const SIMPLE_READ_ONLY_TWO_WORD: ReadonlySet<string> = new Set([
  'docker ps',
  'docker images',
  'docker info',
  'docker version',
]);

// ── Shared flag groups (reusable across git commands) ────────────────

const GIT_REF_SELECTION_FLAGS: Record<string, FlagArgType> = {
  '--all': 'none',
  '--branches': 'none',
  '--tags': 'none',
  '--remotes': 'none',
};

const GIT_DATE_FILTER_FLAGS: Record<string, FlagArgType> = {
  '--since': 'string',
  '--after': 'string',
  '--until': 'string',
  '--before': 'string',
};

const GIT_LOG_DISPLAY_FLAGS: Record<string, FlagArgType> = {
  '--oneline': 'none',
  '--graph': 'none',
  '--decorate': 'none',
  '--no-decorate': 'none',
  '--date': 'string',
  '--relative-date': 'none',
};

const GIT_COUNT_FLAGS: Record<string, FlagArgType> = {
  '--max-count': 'number',
  '-n': 'number',
};

const GIT_STAT_FLAGS: Record<string, FlagArgType> = {
  '--stat': 'none',
  '--numstat': 'none',
  '--shortstat': 'none',
  '--name-only': 'none',
  '--name-status': 'none',
};

const GIT_COLOR_FLAGS: Record<string, FlagArgType> = {
  '--color': 'none',
  '--no-color': 'none',
};

const GIT_PATCH_FLAGS: Record<string, FlagArgType> = {
  '--patch': 'none',
  '-p': 'none',
  '--no-patch': 'none',
  '--no-ext-diff': 'none',
  '-s': 'none',
};

const GIT_AUTHOR_FILTER_FLAGS: Record<string, FlagArgType> = {
  '--author': 'string',
  '--committer': 'string',
  '--grep': 'string',
};

// ── Read-only command whitelist ─────────────────────────────────────

export const READ_ONLY_COMMANDS: Record<string, ExternalCommandConfig> = {
  // ── Git commands ──────────────────────────────────────────────

  'git diff': {
    safeFlags: {
      ...GIT_STAT_FLAGS,
      ...GIT_COLOR_FLAGS,
      '--dirstat': 'none',
      '--summary': 'none',
      '--patch-with-stat': 'none',
      '--word-diff': 'none',
      '--word-diff-regex': 'string',
      '--color-words': 'none',
      '--no-renames': 'none',
      '--no-ext-diff': 'none',
      '--check': 'none',
      '--ws-error-highlight': 'string',
      '--full-index': 'none',
      '--binary': 'none',
      '--abbrev': 'number',
      '--break-rewrites': 'none',
      '--find-renames': 'none',
      '--find-copies': 'none',
      '--find-copies-harder': 'none',
      '--irreversible-delete': 'none',
      '--diff-algorithm': 'string',
      '--histogram': 'none',
      '--patience': 'none',
      '--minimal': 'none',
      '--ignore-space-at-eol': 'none',
      '--ignore-space-change': 'none',
      '--ignore-all-space': 'none',
      '--ignore-blank-lines': 'none',
      '--inter-hunk-context': 'number',
      '--function-context': 'none',
      '--exit-code': 'none',
      '--quiet': 'none',
      '--cached': 'none',
      '--staged': 'none',
      '--pickaxe-regex': 'none',
      '--pickaxe-all': 'none',
      '--no-index': 'none',
      '--relative': 'string',
      '--diff-filter': 'string',
      '-p': 'none',
      '-u': 'none',
      '-s': 'none',
      '-M': 'none',
      '-C': 'none',
      '-B': 'none',
      '-D': 'none',
      '-l': 'none',
      // SECURITY: -S/-G/-O take REQUIRED string arguments, not 'none'.
      // Previously 'none' caused a parser differential with git:
      // `git diff -S -- --output=/tmp/pwned` — validator sees -S as no-arg,
      // git consumes `--` as the -S arg → --output unchecked → arbitrary file write.
      '-S': 'string',
      '-G': 'string',
      '-O': 'string',
      '-R': 'none',
    },
  },

  'git log': {
    safeFlags: {
      ...GIT_LOG_DISPLAY_FLAGS,
      ...GIT_REF_SELECTION_FLAGS,
      ...GIT_DATE_FILTER_FLAGS,
      ...GIT_COUNT_FLAGS,
      ...GIT_STAT_FLAGS,
      ...GIT_COLOR_FLAGS,
      ...GIT_PATCH_FLAGS,
      ...GIT_AUTHOR_FILTER_FLAGS,
      '--abbrev-commit': 'none',
      '--full-history': 'none',
      '--dense': 'none',
      '--sparse': 'none',
      '--simplify-merges': 'none',
      '--ancestry-path': 'none',
      '--source': 'none',
      '--first-parent': 'none',
      '--merges': 'none',
      '--no-merges': 'none',
      '--reverse': 'none',
      '--walk-reflogs': 'none',
      '--skip': 'number',
      '--max-age': 'number',
      '--min-age': 'number',
      '--no-min-parents': 'none',
      '--no-max-parents': 'none',
      '--follow': 'none',
      '--no-walk': 'none',
      '--left-right': 'none',
      '--cherry-mark': 'none',
      '--cherry-pick': 'none',
      '--boundary': 'none',
      '--topo-order': 'none',
      '--date-order': 'none',
      '--author-date-order': 'none',
      '--pretty': 'string',
      '--format': 'string',
      '--diff-filter': 'string',
      '-S': 'string',
      '-G': 'string',
      '--pickaxe-regex': 'none',
      '--pickaxe-all': 'none',
    },
  },

  'git show': {
    safeFlags: {
      ...GIT_LOG_DISPLAY_FLAGS,
      ...GIT_STAT_FLAGS,
      ...GIT_COLOR_FLAGS,
      ...GIT_PATCH_FLAGS,
      '--abbrev-commit': 'none',
      '--word-diff': 'none',
      '--word-diff-regex': 'string',
      '--color-words': 'none',
      '--pretty': 'string',
      '--format': 'string',
      '--first-parent': 'none',
      '--raw': 'none',
      '--diff-filter': 'string',
      '-m': 'none',
      '--quiet': 'none',
    },
  },

  'git status': {
    safeFlags: {
      '--short': 'none',
      '-s': 'none',
      '--branch': 'none',
      '-b': 'none',
      '--porcelain': 'none',
      '--long': 'none',
      '--verbose': 'none',
      '-v': 'none',
      '--untracked-files': 'string',
      '-u': 'string',
      '--ignored': 'none',
      '--ignore-submodules': 'string',
      '--column': 'none',
      '--no-column': 'none',
      '--ahead-behind': 'none',
      '--no-ahead-behind': 'none',
      '--renames': 'none',
      '--no-renames': 'none',
      '--find-renames': 'string',
      '-M': 'string',
    },
  },

  'git branch': {
    safeFlags: {
      '-l': 'none',
      '--list': 'none',
      '-a': 'none',
      '--all': 'none',
      '-r': 'none',
      '--remotes': 'none',
      '-v': 'none',
      '-vv': 'none',
      '--verbose': 'none',
      '--color': 'none',
      '--no-color': 'none',
      '--column': 'none',
      '--no-column': 'none',
      '--abbrev': 'number',
      '--no-abbrev': 'none',
      '--contains': 'string',
      '--no-contains': 'string',
      '--merged': 'none',
      '--no-merged': 'none',
      '--points-at': 'string',
      '--sort': 'string',
      '--show-current': 'none',
      '-i': 'none',
      '--ignore-case': 'none',
    },
    // Block branch creation via positional args: "git branch newbranch"
    additionalCommandIsDangerousCallback: (
      _rawCommand: string,
      args: string[],
    ): boolean => {
      const flagsWithArgs = new Set([
        '--contains',
        '--no-contains',
        '--points-at',
        '--sort',
      ]);
      const flagsWithOptionalArgs = new Set(['--merged', '--no-merged']);
      let i = 0;
      let lastFlag = '';
      let seenListFlag = false;
      let seenDashDash = false;

      while (i < args.length) {
        const token = args[i];
        if (!token) { i++; continue; }

        if (token === '--' && !seenDashDash) {
          seenDashDash = true;
          lastFlag = '';
          i++;
          continue;
        }

        if (!seenDashDash && token.startsWith('-')) {
          if (token === '--list' || token === '-l') {
            seenListFlag = true;
          } else if (
            token[0] === '-' &&
            token[1] !== '-' &&
            token.length > 2 &&
            !token.includes('=') &&
            token.slice(1).includes('l')
          ) {
            seenListFlag = true;
          }

          if (token.includes('=')) {
            lastFlag = token.split('=')[0] || '';
            i++;
          } else if (flagsWithArgs.has(token)) {
            lastFlag = token;
            i += 2;
          } else {
            lastFlag = token;
            i++;
          }
        } else {
          const lastFlagHasOptionalArg = flagsWithOptionalArgs.has(lastFlag);
          if (!seenListFlag && !lastFlagHasOptionalArg) {
            return true; // Positional arg without --list = branch creation
          }
          i++;
        }
      }
      return false;
    },
  },

  'git tag': {
    safeFlags: {
      '-l': 'none',
      '--list': 'none',
      '-n': 'number',
      '--contains': 'string',
      '--no-contains': 'string',
      '--merged': 'string',
      '--no-merged': 'string',
      '--sort': 'string',
      '--format': 'string',
      '--points-at': 'string',
      '--column': 'none',
      '--no-column': 'none',
      '-i': 'none',
      '--ignore-case': 'none',
    },
    // Block tag creation: "git tag foo" creates .git/refs/tags/foo
    additionalCommandIsDangerousCallback: (
      _rawCommand: string,
      args: string[],
    ): boolean => {
      const flagsWithArgs = new Set([
        '--contains', '--no-contains', '--merged',
        '--no-merged', '--points-at', '--sort', '--format', '-n',
      ]);
      let i = 0;
      let seenListFlag = false;
      let seenDashDash = false;

      while (i < args.length) {
        const token = args[i];
        if (!token) { i++; continue; }

        if (token === '--' && !seenDashDash) {
          seenDashDash = true;
          i++;
          continue;
        }

        if (!seenDashDash && token.startsWith('-')) {
          if (token === '--list' || token === '-l') {
            seenListFlag = true;
          } else if (
            token[0] === '-' && token[1] !== '-' &&
            token.length > 2 && !token.includes('=') &&
            token.slice(1).includes('l')
          ) {
            seenListFlag = true;
          }

          if (token.includes('=')) { i++; }
          else if (flagsWithArgs.has(token)) { i += 2; }
          else { i++; }
        } else {
          if (!seenListFlag) return true; // positional without --list = tag creation
          i++;
        }
      }
      return false;
    },
  },

  'git stash list': {
    safeFlags: {
      ...GIT_LOG_DISPLAY_FLAGS,
      ...GIT_REF_SELECTION_FLAGS,
      ...GIT_COUNT_FLAGS,
    },
  },

  'git reflog': {
    safeFlags: {
      ...GIT_LOG_DISPLAY_FLAGS,
      ...GIT_REF_SELECTION_FLAGS,
      ...GIT_DATE_FILTER_FLAGS,
      ...GIT_COUNT_FLAGS,
      ...GIT_AUTHOR_FILTER_FLAGS,
    },
    // Block `git reflog expire`, `git reflog delete` — they write
    additionalCommandIsDangerousCallback: (
      _rawCommand: string,
      args: string[],
    ): boolean => {
      const DANGEROUS_SUBCOMMANDS = new Set(['expire', 'delete', 'exists']);
      for (const token of args) {
        if (!token || token.startsWith('-')) continue;
        if (DANGEROUS_SUBCOMMANDS.has(token)) return true;
        return false; // First positional is safe (show/HEAD/ref)
      }
      return false;
    },
  },

  'git blame': {
    safeFlags: {
      ...GIT_COLOR_FLAGS,
      '-L': 'string',
      '--porcelain': 'none',
      '-p': 'none',
      '--line-porcelain': 'none',
      '--incremental': 'none',
      '--root': 'none',
      '--show-stats': 'none',
      '--show-name': 'none',
      '--show-number': 'none',
      '-n': 'none',
      '--show-email': 'none',
      '-e': 'none',
      '-f': 'none',
      '--date': 'string',
      '-w': 'none',
      '--ignore-rev': 'string',
      '--ignore-revs-file': 'string',
      '-M': 'none',
      '-C': 'none',
      '--score-debug': 'none',
      '--abbrev': 'number',
      '-s': 'none',
      '-l': 'none',
      '-t': 'none',
    },
  },

  'git ls-files': {
    safeFlags: {
      '--cached': 'none',
      '-c': 'none',
      '--deleted': 'none',
      '-d': 'none',
      '--modified': 'none',
      '-m': 'none',
      '--others': 'none',
      '-o': 'none',
      '--ignored': 'none',
      '-i': 'none',
      '--stage': 'none',
      '-s': 'none',
      '--killed': 'none',
      '-k': 'none',
      '--unmerged': 'none',
      '-u': 'none',
      '--directory': 'none',
      '--no-empty-directory': 'none',
      '--eol': 'none',
      '--full-name': 'none',
      '--abbrev': 'number',
      '--debug': 'none',
      '-z': 'none',
      '-t': 'none',
      '-v': 'none',
      '-f': 'none',
      '--exclude': 'string',
      '-x': 'string',
      '--exclude-from': 'string',
      '-X': 'string',
      '--exclude-per-directory': 'string',
      '--exclude-standard': 'none',
      '--error-unmatch': 'none',
      '--recurse-submodules': 'none',
    },
  },

  'git ls-remote': {
    safeFlags: {
      '--branches': 'none',
      '-b': 'none',
      '--tags': 'none',
      '-t': 'none',
      '--heads': 'none',
      '-h': 'none',
      '--refs': 'none',
      '--quiet': 'none',
      '-q': 'none',
      '--exit-code': 'none',
      '--get-url': 'none',
      '--symref': 'none',
      '--sort': 'string',
      // SECURITY: --server-option and -o intentionally excluded
      // They transmit arbitrary strings to the remote server
    },
  },

  'git remote': {
    safeFlags: {
      '-v': 'none',
      '--verbose': 'none',
    },
    additionalCommandIsDangerousCallback: (
      _rawCommand: string,
      args: string[],
    ): boolean => {
      return args.some(a => a !== '-v' && a !== '--verbose');
    },
  },

  'git grep': {
    safeFlags: {
      '-e': 'string',
      '-E': 'none',
      '--extended-regexp': 'none',
      '-G': 'none',
      '--basic-regexp': 'none',
      '-F': 'none',
      '--fixed-strings': 'none',
      '-P': 'none',
      '--perl-regexp': 'none',
      '-i': 'none',
      '--ignore-case': 'none',
      '-v': 'none',
      '--invert-match': 'none',
      '-w': 'none',
      '--word-regexp': 'none',
      '-n': 'none',
      '--line-number': 'none',
      '-c': 'none',
      '--count': 'none',
      '-l': 'none',
      '--files-with-matches': 'none',
      '-L': 'none',
      '--files-without-match': 'none',
      '-h': 'none',
      '-H': 'none',
      '--heading': 'none',
      '--break': 'none',
      '--full-name': 'none',
      '--color': 'none',
      '--no-color': 'none',
      '-o': 'none',
      '--only-matching': 'none',
      '-A': 'number',
      '--after-context': 'number',
      '-B': 'number',
      '--before-context': 'number',
      '-C': 'number',
      '--context': 'number',
      '--and': 'none',
      '--or': 'none',
      '--not': 'none',
      '--max-depth': 'number',
      '--untracked': 'none',
      '--no-index': 'none',
      '--recurse-submodules': 'none',
      '--cached': 'none',
      '--threads': 'number',
      '-q': 'none',
      '--quiet': 'none',
    },
  },

  'git rev-parse': {
    safeFlags: {
      '--verify': 'none',
      '--short': 'string',
      '--abbrev-ref': 'none',
      '--symbolic': 'none',
      '--symbolic-full-name': 'none',
      '--show-toplevel': 'none',
      '--show-cdup': 'none',
      '--show-prefix': 'none',
      '--git-dir': 'none',
      '--git-common-dir': 'none',
      '--absolute-git-dir': 'none',
      '--show-superproject-working-tree': 'none',
      '--is-inside-work-tree': 'none',
      '--is-inside-git-dir': 'none',
      '--is-bare-repository': 'none',
      '--is-shallow-repository': 'none',
      '--is-shallow-update': 'none',
      '--path-prefix': 'none',
    },
  },

  'git rev-list': {
    safeFlags: {
      ...GIT_REF_SELECTION_FLAGS,
      ...GIT_DATE_FILTER_FLAGS,
      ...GIT_COUNT_FLAGS,
      ...GIT_AUTHOR_FILTER_FLAGS,
      '--count': 'none',
      '--reverse': 'none',
      '--first-parent': 'none',
      '--ancestry-path': 'none',
      '--merges': 'none',
      '--no-merges': 'none',
      '--min-parents': 'number',
      '--max-parents': 'number',
      '--no-min-parents': 'none',
      '--no-max-parents': 'none',
      '--skip': 'number',
      '--max-age': 'number',
      '--min-age': 'number',
      '--walk-reflogs': 'none',
      '--oneline': 'none',
      '--abbrev-commit': 'none',
      '--pretty': 'string',
      '--format': 'string',
      '--abbrev': 'number',
      '--full-history': 'none',
      '--dense': 'none',
      '--sparse': 'none',
      '--source': 'none',
      '--graph': 'none',
    },
  },

  'git describe': {
    safeFlags: {
      '--tags': 'none',
      '--match': 'string',
      '--exclude': 'string',
      '--long': 'none',
      '--abbrev': 'number',
      '--always': 'none',
      '--contains': 'none',
      '--first-match': 'none',
      '--exact-match': 'none',
      '--candidates': 'number',
      '--dirty': 'none',
      '--broken': 'none',
    },
  },

  'git shortlog': {
    safeFlags: {
      ...GIT_REF_SELECTION_FLAGS,
      ...GIT_DATE_FILTER_FLAGS,
      '-s': 'none',
      '--summary': 'none',
      '-n': 'none',
      '--numbered': 'none',
      '-e': 'none',
      '--email': 'none',
      '-c': 'none',
      '--committer': 'none',
      '--group': 'string',
      '--format': 'string',
      '--no-merges': 'none',
      '--author': 'string',
    },
  },

  'git merge-base': {
    safeFlags: {
      '--is-ancestor': 'none',
      '--fork-point': 'none',
      '--octopus': 'none',
      '--independent': 'none',
      '--all': 'none',
    },
  },

  'git config --get': {
    safeFlags: {
      '--local': 'none',
      '--global': 'none',
      '--system': 'none',
      '--worktree': 'none',
      '--default': 'string',
      '--type': 'string',
      '--bool': 'none',
      '--int': 'none',
      '--bool-or-int': 'none',
      '--path': 'none',
      '--expiry-date': 'none',
      '-z': 'none',
      '--null': 'none',
      '--name-only': 'none',
      '--show-origin': 'none',
      '--show-scope': 'none',
    },
  },

  'git for-each-ref': {
    safeFlags: {
      '--format': 'string',
      '--sort': 'string',
      '--count': 'number',
      '--contains': 'string',
      '--no-contains': 'string',
      '--merged': 'string',
      '--no-merged': 'string',
      '--points-at': 'string',
    },
  },

  'git cat-file': {
    safeFlags: {
      '-t': 'none',
      '-s': 'none',
      '-p': 'none',
      '-e': 'none',
      '--batch-check': 'none',
      '--allow-undetermined-type': 'none',
    },
  },

  // ── Ripgrep ──────────────────────────────────────────────────

  'rg': {
    safeFlags: {
      '-e': 'string',
      '--regexp': 'string',
      '-f': 'string',
      '-i': 'none',
      '--ignore-case': 'none',
      '-S': 'none',
      '--smart-case': 'none',
      '-F': 'none',
      '--fixed-strings': 'none',
      '-w': 'none',
      '--word-regexp': 'none',
      '-v': 'none',
      '--invert-match': 'none',
      '-c': 'none',
      '--count': 'none',
      '-l': 'none',
      '--files-with-matches': 'none',
      '--files-without-match': 'none',
      '-n': 'none',
      '--line-number': 'none',
      '-o': 'none',
      '--only-matching': 'none',
      '-A': 'number',
      '--after-context': 'number',
      '-B': 'number',
      '--before-context': 'number',
      '-C': 'number',
      '--context': 'number',
      '-H': 'none',
      '-h': 'none',
      '--heading': 'none',
      '--no-heading': 'none',
      '-q': 'none',
      '--quiet': 'none',
      '--column': 'none',
      '-g': 'string',
      '--glob': 'string',
      '-t': 'string',
      '--type': 'string',
      '-T': 'string',
      '--type-not': 'string',
      '--type-list': 'none',
      '--hidden': 'none',
      '--no-ignore': 'none',
      '-u': 'none',
      '-m': 'number',
      '--max-count': 'number',
      '-d': 'number',
      '--max-depth': 'number',
      '-a': 'none',
      '--text': 'none',
      '-z': 'none',
      '-L': 'none',
      '--follow': 'none',
      '--color': 'string',
      '--json': 'none',
      '--stats': 'none',
      '--help': 'none',
      '--version': 'none',
      '--debug': 'none',
      '--': 'none',
    },
  },
};

// ── Classification helpers ──────────────────────────────────────────

/**
 * Result from trying to match a command against the read-only whitelist.
 */
export interface ReadOnlyMatchResult {
  /** True if the command is on the whitelist and all flags validated. */
  isReadOnly: boolean;
  /** Human-readable reason for the decision. */
  reason: string;
}

/**
 * Check if a tokenized command is on the read-only whitelist.
 *
 * @param tokens - Tokenized command tokens (from extractCommandTokens)
 * @param rawCommand - Original raw command string
 * @returns Match result with isReadOnly and reason
 */
export function matchReadOnlyCommand(
  tokens: string[],
  rawCommand: string,
): ReadOnlyMatchResult {
  if (tokens.length === 0) {
    return { isReadOnly: false, reason: 'Empty command' };
  }

  const firstToken = tokens[0] ?? '';

  // Check simple read-only commands (single word, no flag validation)
  if (SIMPLE_READ_ONLY_COMMANDS.has(firstToken)) {
    return {
      isReadOnly: true,
      reason: `'${firstToken}' is a read-only command`,
    };
  }

  // Check simple two-word commands
  if (tokens.length >= 2) {
    const twoWord = `${firstToken} ${tokens[1]}`;
    if (SIMPLE_READ_ONLY_TWO_WORD.has(twoWord)) {
      return {
        isReadOnly: true,
        reason: `'${twoWord}' is a read-only command`,
      };
    }
  }

  // Check commands that need flag validation
  // Build the command key: try progressively longer prefixes
  let bestMatch: string | null = null;

  // Try two-word key first (e.g., "git diff", "git log")
  if (tokens.length >= 2) {
    const twoWordKey = `${firstToken} ${tokens[1]}`;
    if (READ_ONLY_COMMANDS[twoWordKey]) {
      bestMatch = twoWordKey;
    }
  }

  // Try three-word key (e.g., "git config --get", "git stash list")
  if (!bestMatch && tokens.length >= 3) {
    const threeWordKey = `${firstToken} ${tokens[1]} ${tokens[2]}`;
    if (READ_ONLY_COMMANDS[threeWordKey]) {
      bestMatch = threeWordKey;
    }
  }

  // Try single-token key (e.g., "rg" which requires flag validation)
  if (!bestMatch) {
    if (READ_ONLY_COMMANDS[firstToken]) {
      bestMatch = firstToken;
    }
  }

  if (bestMatch) {
    const config = READ_ONLY_COMMANDS[bestMatch];
    if (!config) {
      return { isReadOnly: false, reason: 'Whitelist entry missing config' };
    }

    // Determine start index for flag validation
    const keyParts = bestMatch.split(' ');
    const startIndex = keyParts.length;

    // Run flag validation
    if (validateFlags(tokens, startIndex, config, {
      commandName: firstToken,
      rawCommand,
    })) {
      return {
        isReadOnly: true,
        reason: `'${bestMatch}' with validated flags is read-only`,
      };
    }

    return {
      isReadOnly: false,
      reason: `'${bestMatch}' has flags not in safe flag list`,
    };
  }

  return {
    isReadOnly: false,
    reason: 'Command not in read-only whitelist',
  };
}
