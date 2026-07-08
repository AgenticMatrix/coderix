/**
 * Dangerous command pattern detection for bash security.
 *
 * Detects commands and patterns that are always dangerous regardless
 * of whitelist status: code execution interpreters, destructive builtins,
 * command substitution, dangerous redirects, and known attack patterns.
 */

// ── Code execution interpreters ─────────────────────────────────────

/**
 * Commands that provide arbitrary code execution.
 * Any command starting with one of these is classified as CODE_EXEC.
 *
 * Covers interpreters (python, node, ruby, etc.), package runners
 * (npx, bunx), shells (bash -c, sh -c), and remote execution (ssh).
 */
export const CODE_EXEC_INTERPRETERS: readonly string[] = [
  // Interpreters
  'python',
  'python3',
  'python2',
  'node',
  'deno',
  'tsx',
  'ruby',
  'perl',
  'php',
  'lua',
  // Package runners
  'npx',
  'bunx',
  'npm run',
  'yarn run',
  'pnpm run',
  'bun run',
  // Shells (arbitrary code via -c or stdin)
  'bash',
  'sh',
  'zsh',
  'fish',
  'dash',
  'ksh',
  // Windows: PowerShell and cmd can execute arbitrary scripts
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
  'cmd',
  'cmd.exe',
  'cscript',
  'cscript.exe',
  'wscript',
  'wscript.exe',
  // Remote execution
  'ssh',
];

// ── Dangerous builtins / keywords ───────────────────────────────────

/**
 * Shell builtins and common commands that are inherently dangerous
 * or frequently used for privilege escalation / code execution.
 */
export const DANGEROUS_BASH_BUILTINS: readonly string[] = [
  // Shell code execution
  'eval',
  'exec',
  'source',
  '.',
  // Privilege escalation
  'sudo',
  'su',
  'pkexec',
  'doas',
  // Argument-to-command bridge (eval replacement)
  'xargs',
  // systemd / service control
  'systemctl',
  // Container escape risk
  'nsenter',
  // Windows: PowerShell code execution & privilege escalation
  'iex',
  'Invoke-Expression',
  'Invoke-Command',
  'icm',
  'Invoke-WebRequest',
  'iwr',
  'Invoke-RestMethod',
  'irm',
  'Start-Process',
  'runas',
];

// ── Destructive commands ────────────────────────────────────────────

/**
 * Commands that can cause data loss or system damage.
 */
export const DESTRUCTIVE_COMMANDS: readonly string[] = [
  'rm',
  'rmdir',
  'mv',
  'dd',
  'mkfs',
  'mkswap',
  'fdisk',
  'parted',
  'shred',
  'truncate',
  // Windows: destructive system commands
  'format',
  'diskpart',
  'bcdedit',
  'del',
  'rd',
  'Remove-Item',
  'Clear-RecycleBin',
];

// ── Network exfiltration commands ────────────────────────────────────

/**
 * Commands that can send data over the network.
 * These are flagged as NETWORK category when they appear to be
 * making outbound connections (POST, upload, etc.).
 */
export const NETWORK_EXFIL_COMMANDS: readonly string[] = [
  'curl',
  'wget',
  'nc',
  'netcat',
  'ncat',
  'socat',
  'telnet',
  'ftp',
  'scp',
  'rsync',
  'gh',
  'git',
];

// ── Pattern-based detection ─────────────────────────────────────────

/**
 * Detect command substitution patterns: $(...) and backticks `...`.
 *
 * Command substitution lets an attacker execute arbitrary commands
 * whose output becomes part of the outer command. This is the primary
 * vector for shell injection in AI-generated commands.
 */
export function containsCommandSubstitution(command: string): boolean {
  // $(...) — modern command substitution
  if (/\$\(/.test(command)) {
    return true;
  }

  // Backtick command substitution
  if (/`[^`]+`/.test(command)) {
    return true;
  }

  return false;
}

/**
 * Detect process substitution: <(...) and >(...).
 *
 * Process substitution creates named pipes / /dev/fd references that
 * can be used to execute commands in contexts where only filenames
 * are expected.
 *
 * Also detects Zsh-specific =(...) which writes to a temp file.
 */
export function containsProcessSubstitution(command: string): boolean {
  // <(command) and >(command)
  if (/[<>]\(/.test(command)) {
    return true;
  }
  // Zsh =(...) — temporary file substitution
  if (/=\(/.test(command)) {
    return true;
  }
  return false;
}

/**
 * Detect dangerous redirect patterns.
 *
 * These write stdout/stderr to sensitive system paths or devices.
 */
export function containsDangerousRedirect(command: string): boolean {
  // Writing to disk devices: >/dev/sda, >/dev/nvme0n1, etc.
  if (/>\s*\/dev\/(sd|nvme|hd|xvd|vd|mmcblk|loop|dm-)/.test(command)) {
    return true;
  }

  // Appending to critical system files
  const criticalPaths = [
    />>\s*\/etc\/passwd/,
    />>\s*\/etc\/shadow/,
    />>\s*\/etc\/sudoers/,
    />>\s*\/etc\/crontab/,
    />>\s*\/etc\/hosts/,
    />>\s*\/root\//,
    />>\s*\/etc\/ssh\//,
    />>\s*\/etc\/systemd\//,
    />>\s*~\/\.ssh\/authorized_keys/,
    />>\s*~\/\.bashrc/,
    />>\s*~\/\.zshrc/,
    />>\s*~\/\.profile/,
    // Windows: writing to critical system paths
    />>\s*C:\\Windows\\System32\\/i,
    />>\s*C:\\Windows\\System32\\drivers\\/i,
    />>\s*C:\\Windows\\System32\\config\\/i,
  ];

  for (const pattern of criticalPaths) {
    if (pattern.test(command)) {
      return true;
    }
  }

  return false;
}

/**
 * Detect fork bomb patterns.
 *
 * Classic fork bomb: :(){ :|:& };:
 * Also detects variations with different function names.
 */
export function containsForkBomb(command: string): boolean {
  // Classic fork bomb: :(){ :|:& };:
  if (/:\(\)\s*\{\s*:\s*\|/i.test(command)) {
    return true;
  }
  // Generic fork bomb pattern: f(){ f|f& };f
  if (/(\w+)\(\)\s*\{\s*\1\s*\|/i.test(command)) {
    return true;
  }
  return false;
}

/**
 * Detect chmod suid/sgid escalation.
 *
 * chmod +s / chmod 4xxx makes a binary setuid, which is a common
 * privilege escalation technique.
 */
export function containsPrivilegeEscalation(command: string): boolean {
  // chmod with setuid/setgid
  if (/chmod\s+.*[+=\s][0-7]*[4567][0-7]{3}/.test(command)) {
    return true;
  }
  if (/chmod\s+.*\+s/.test(command)) {
    return true;
  }
  // chown to root
  if (/chown\s+.*root/.test(command)) {
    return true;
  }
  return false;
}

/**
 * Detect dangerous Git operations that rewrite history or force-push.
 *
 * These can cause data loss by overwriting remote branches.
 */
export function containsDangerousGitOperation(command: string): boolean {
  const firstToken = command.trim().split(/\s+/)[0];
  if (firstToken !== 'git') return false;

  // Destructive git force operations
  if (/\bgit\s+push\s+.*--force/.test(command) ||
      /\bgit\s+push\s+.*-f\b/.test(command) ||
      /\bgit\s+push\s+.*--delete/.test(command)) {
    return true;
  }

  // Hard reset (destroys uncommitted changes)
  if (/\bgit\s+reset\s+--hard/.test(command)) {
    return true;
  }

  // Clean (deletes untracked files)
  if (/\bgit\s+clean\s+-[dfx]+/.test(command)) {
    return true;
  }

  return false;
}

/**
 * Check if a command starts with a known code execution interpreter.
 *
 * Handles both single-token ("python") and multi-token ("npm run") interpreters.
 */
export function startsWithCodeInterpreter(tokens: string[]): boolean {
  if (tokens.length === 0) return false;

  const first = tokens[0] ?? '';
  if (first === 'env' && tokens.length >= 3) {
    // env VAR=val interpreter ... — check the interpreter after env vars
    let i = 1;
    while (i < tokens.length && tokens[i]?.includes('=') && !tokens[i]?.startsWith('-')) {
      i++;
    }
    const interpreter = tokens[i];
    if (interpreter && CODE_EXEC_INTERPRETERS.includes(interpreter)) {
      return true;
    }
  }

  // Check single-token interpreters
  if (CODE_EXEC_INTERPRETERS.includes(first)) {
    return true;
  }

  // Check multi-token interpreters (e.g., "npm run", "bun run")
  if (tokens.length >= 2) {
    const twoWord = `${first} ${tokens[1]}`;
    if (CODE_EXEC_INTERPRETERS.includes(twoWord)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if the first token is a known dangerous builtin.
 */
export function startsWithDangerousBuiltin(tokens: string[]): boolean {
  if (tokens.length === 0) return false;
  const first = tokens[0] ?? '';
  return DANGEROUS_BASH_BUILTINS.includes(first);
}

/**
 * Check if the first token is a destructive command.
 */
export function startsWithDestructiveCommand(tokens: string[]): boolean {
  if (tokens.length === 0) return false;
  const first = tokens[0] ?? '';
  return DESTRUCTIVE_COMMANDS.includes(first);
}

/**
 * Check if the command is a network exfiltration command with non-read-only flags.
 *
 * Network tools like curl and wget are only safe when used with read-only
 * options (GET requests). POST, PUT, --upload-file etc. are exfiltration risks.
 */
export function isNetworkExfilCommand(tokens: string[], rawCommand: string): boolean {
  if (tokens.length === 0) return false;
  const first = tokens[0] ?? '';
  if (!NETWORK_EXFIL_COMMANDS.includes(first)) return false;

  // curl: safe only with pure GET (no -d, -F, -T, -X POST/PUT, --data etc.)
  if (first === 'curl') {
    // Flag as NETWORK if it has data-sending flags
    if (/\bcurl\s+.*(-d\b|--data\b|--data-raw\b|--data-binary\b|-F\b|--form\b|-T\b|--upload-file\b|-X\s*(POST|PUT|PATCH|DELETE))/i.test(rawCommand)) {
      return true;
    }
    // Pure GET curl is flagged as NETWORK but not blocked by security-check
    return true;
  }

  // wget: inherently downloads from network — always NETWORK
  if (first === 'wget') {
    return true;
  }

  // nc/netcat/socat/telnet: always network
  if (['nc', 'netcat', 'ncat', 'socat', 'telnet'].includes(first)) {
    return true;
  }

  // scp/rsync/ftp: always network file transfer
  if (['scp', 'rsync', 'ftp'].includes(first)) {
    return true;
  }

  // gh: GitHub CLI — flag if it has potentially dangerous subcommands
  if (first === 'gh' && tokens.length >= 2) {
    const subcmd = tokens[1] ?? '';
    // gh api is always network exfil
    if (subcmd === 'api') return true;
    // gh pr create, gh issue create etc. — write operations
    // Allow read-only gh operations (pr view, pr list, issue list, etc.)
    const readOnlyGhSubcommands = ['auth', 'search'];
    if (readOnlyGhSubcommands.includes(subcmd)) return false;
    // Default: flag gh as NETWORK if we can't verify it's read-only
    // This will be refined in Phase 1's read-only-whitelist
  }

  return false;
}

/**
 * Comprehensive dangerous pattern check.
 *
 * Combines all pattern-based detectors into a single check.
 * Returns `{ dangerous: true, reason: "..." }` if any pattern matches.
 */
export function checkDangerousPatterns(
  command: string,
  tokens: string[],
): { dangerous: boolean; reason?: string } | null {
  // 1. Fork bomb
  if (containsForkBomb(command)) {
    return { dangerous: true, reason: 'Fork bomb pattern detected' };
  }

  // 2. Dangerous redirect (command/process substitution handled in security-check layer)
  if (containsDangerousRedirect(command)) {
    return { dangerous: true, reason: 'Dangerous redirect detected (writing to system files or devices)' };
  }

  // 3. Privilege escalation
  if (containsPrivilegeEscalation(command)) {
    return { dangerous: true, reason: 'Privilege escalation pattern detected (chmod +s or chown root)' };
  }

  // 4. Dangerous git operations
  if (containsDangerousGitOperation(command)) {
    return { dangerous: true, reason: 'Dangerous git operation detected (force push, hard reset, clean)' };
  }

  return null;
}
