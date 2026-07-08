/**
 * Native Terminal — node-pty based PTY session manager
 *
 * ADR-001 §3.2: Creates actual PTY sessions via node-pty for the
 * integrated terminal (xterm.js in renderer).
 *
 * Each terminal session runs in its own PTY, with data piped
 * to the renderer via IPC push events.
 *
 * Dependencies: node-pty (npm package)
 *
 * NOTE: node-pty must be added to package.json dependencies:
 *   pnpm add node-pty --filter @coderix/desktop
 */

import type { IPty } from 'node-pty';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TerminalSessionConfig {
  /** Working directory for the shell. */
  cwd: string;
  /** Initial terminal rows. */
  rows: number;
  /** Initial terminal columns. */
  cols: number;
  /** Shell to use. Defaults to $SHELL or /bin/zsh. */
  shell?: string;
  /** Callback when PTY emits data. */
  onData: (data: string) => void;
  /** Callback when PTY process exits. */
  onExit: (exitCode: number) => void;
}

export interface TerminalSession {
  id: string;
  pty: IPty;
  cwd: string;
  createdAt: number;
}

export interface TerminalManager {
  /** Create a new terminal session. */
  create(id: string, config: TerminalSessionConfig): Promise<string>;
  /** Write input to a terminal session. */
  write(id: string, data: string): void;
  /** Resize a terminal session. */
  resize(id: string, rows: number, cols: number): void;
  /** Destroy a terminal session. */
  destroy(id: string): void;
  /** Get a terminal session by ID. */
  get(id: string): TerminalSession | undefined;
  /** List all active terminal sessions. */
  list(): TerminalSession[];
  /** Destroy all sessions (cleanup on app quit). */
  destroyAll(): void;
}

// ---------------------------------------------------------------------------
// createTerminalManager
// ---------------------------------------------------------------------------

export function createTerminalManager(): TerminalManager {
  const sessions = new Map<string, TerminalSession>();
  let nodePtyModule: typeof import('node-pty') | null = null;

  async function getNodePty(): Promise<typeof import('node-pty')> {
    if (nodePtyModule) return nodePtyModule;
    nodePtyModule = await import('node-pty');
    return nodePtyModule!;
  }

  function getDefaultShell(): string {
    // Respect user's preferred shell
    if (process.env['SHELL']) return process.env['SHELL'];

    // Platform defaults
    if (process.platform === 'win32') {
      // Prefer PowerShell 7 (pwsh), then PowerShell 5, then COMSPEC (cmd)
      try {
        require('node:fs').accessSync('C:\\Program Files\\PowerShell\\7\\pwsh.exe');
        return 'pwsh.exe';
      } catch {}
      try {
        require('node:fs').accessSync(
          'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        );
        return 'powershell.exe';
      } catch {}
      return process.env['COMSPEC'] ?? 'cmd.exe';
    }

    return '/bin/zsh';
  }

  return {
    async create(id: string, config: TerminalSessionConfig): Promise<string> {
      const nodePty = await getNodePty();

      // Clean up any existing session with the same ID
      if (sessions.has(id)) {
        this.destroy(id);
      }

      const shell = config.shell ?? getDefaultShell();

      const ptyProcess = nodePty.spawn(shell, [], {
        // Windows ConPTY ignores TERM; passing undefined lets the system choose
        name: process.platform === 'win32' ? undefined : 'xterm-256color',
        cols: config.cols,
        rows: config.rows,
        cwd: config.cwd
          ?? process.env['HOME']
          ?? (process.platform === 'win32' ? process.env['USERPROFILE'] : '/'),
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          // Ensure color support
          COLORTERM: 'truecolor',
          // Disable bracketed paste mode initially (let xterm.js handle it)
          // TERM_PROGRAM: 'Coderix',
        },
      });

      const session: TerminalSession = {
        id,
        pty: ptyProcess,
        cwd: config.cwd,
        createdAt: Date.now(),
      };

      // Forward PTY output to the renderer
      ptyProcess.onData((data: string) => {
        config.onData(data);
      });

      // Handle process exit
      ptyProcess.onExit(({ exitCode, signal }) => {
        const code = typeof exitCode === 'number' ? exitCode : -1;
        config.onExit(code);
        sessions.delete(id);
      });

      sessions.set(id, session);
      return id;
    },

    write(id: string, data: string): void {
      const session = sessions.get(id);
      if (session) {
        try {
          session.pty.write(data);
        } catch (err) {
          console.error(`[TerminalManager] Write error for session ${id}:`, err);
        }
      }
    },

    resize(id: string, rows: number, cols: number): void {
      const session = sessions.get(id);
      if (session) {
        try {
          session.pty.resize(cols, rows);
        } catch (err) {
          console.error(`[TerminalManager] Resize error for session ${id}:`, err);
        }
      }
    },

    destroy(id: string): void {
      const session = sessions.get(id);
      if (session) {
        try {
          // Kill the PTY process
          session.pty.kill();
        } catch (err) {
          console.error(`[TerminalManager] Kill error for session ${id}:`, err);
        }
        sessions.delete(id);
      }
    },

    get(id: string): TerminalSession | undefined {
      return sessions.get(id);
    },

    list(): TerminalSession[] {
      return Array.from(sessions.values());
    },

    destroyAll(): void {
      for (const [id, session] of sessions) {
        try {
          session.pty.kill();
        } catch (err) {
          console.error(`[TerminalManager] Kill error for session ${id}:`, err);
        }
      }
      sessions.clear();
    },
  };
}
