import React, { useState, useRef, useCallback } from 'react';
import Terminal, {
  writeToTerminal,
  resizeTerminal,
} from './Terminal.js';
import type { Terminal as XTerm } from 'xterm';

export interface TerminalPanelProps {
  /** Whether the panel is open (visible) */
  isOpen: boolean;
  /** Called to toggle the panel open/closed */
  onToggle: () => void;
}

/**
 * TerminalPanel — collapsible/expandable terminal panel container.
 *
 * Features:
 *   - Collapsible panel with smooth height animation
 *   - macOS-style header bar with close/expand buttons
 *   - Single-tab terminal (multi-tab via TerminalTabs wrapper in future)
 *   - Manages the xterm instance and exposes read/write/resize methods
 *
 * Design follows the Apple HIG: translucent background with blur,
 * rounded corners, and minimal chrome.
 */
export default function TerminalPanel({
  isOpen,
  onToggle,
}: TerminalPanelProps): React.ReactElement {
  const [term, setTerm] = useState<XTerm | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const ptyIdRef = useRef<string | null>(null);

  const handleReady = useCallback(async (t: XTerm) => {
    termRef.current = t;
    setTerm(t);

    writeToTerminal(t, '\x1b[1;36m╭────────────────────────────────────────────╮\x1b[0m\r\n');
    writeToTerminal(t, '\x1b[1;36m│\x1b[0m  \x1b[1mCoderix Terminal\x1b[0m                          \x1b[1;36m│\x1b[0m\r\n');

    // Create PTY session via IPC
    const api = window.coderixAPI;
    if (api?.terminal?.create) {
      try {
        const result = await api.terminal.create({ cwd: undefined, rows: 24, cols: 80 });
        ptyIdRef.current = result.terminalId;

        // Pipe PTY output → terminal
        api.terminal.onData(result.terminalId, (data: string) => {
          writeToTerminal(t, data);
        });

        // Handle PTY exit
        api.terminal.onExit(result.terminalId, (exitCode: number) => {
          writeToTerminal(t, `\r\n\x1b[33mProcess exited with code ${exitCode}\x1b[0m\r\n`);
        });

        writeToTerminal(t, '\x1b[1;36m│\x1b[0m  PTY connected — type commands below         \x1b[1;36m│\x1b[0m\r\n');
      } catch (e) {
        writeToTerminal(t, `\x1b[1;31m│\x1b[0m  PTY error: ${String(e).slice(0, 40)}  \x1b[1;31m│\x1b[0m\r\n`);
      }
    } else {
      writeToTerminal(t, '\x1b[1;33m│\x1b[0m  PTY API not available (preload missing?)    \x1b[1;33m│\x1b[0m\r\n');
    }
    writeToTerminal(t, '\x1b[1;36m│\x1b[0m  \x1b[2mCtrl+`\x1b[0m to toggle  ·  \x1b[2mCmd+K\x1b[0m for commands  \x1b[1;36m│\x1b[0m\r\n');
    writeToTerminal(t, '\x1b[1;36m╰────────────────────────────────────────────╯\x1b[0m\r\n\r\n');
  }, []);

  const handleData = useCallback(
    (data: string) => {
      // Send keystrokes to PTY
      const api = window.coderixAPI;
      if (ptyIdRef.current && api?.terminal?.write) {
        api.terminal.write(ptyIdRef.current, data);
      }
    },
    [],
  );

  return (
    <div
      className="terminal-panel"
      style={{
        flex: isOpen ? '0 0 35%' : '0 0 0px',
        minHeight: isOpen ? '120px' : '0px',
        overflow: 'hidden',
        transition: 'flex 250ms cubic-bezier(0, 0, 0.58, 1), min-height 250ms cubic-bezier(0, 0, 0.58, 1)',
        borderTop: isOpen
          ? '1px solid var(--color-separator, rgba(0,0,0,0.08))'
          : 'none',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Header Bar */}
      {isOpen && (
        <div
          className="terminal-header"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '4px 12px',
            height: '28px',
            flexShrink: 0,
            background: 'var(--color-bg-secondary, #F4F2EB)',
            borderBottom: '1px solid var(--color-separator, rgba(0,0,0,0.08))',
          }}
        >
          <span
            style={{
              fontSize: '11px',
              fontWeight: 600,
              color: 'var(--color-text-secondary, #656358)',
              letterSpacing: '0.5px',
              textTransform: 'uppercase',
            }}
          >
            Terminal
          </span>
          <button
            onClick={onToggle}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--color-text-tertiary, #9E9B8F)',
              cursor: 'pointer',
              fontSize: '14px',
              padding: '2px 6px',
              borderRadius: 'var(--radius-sm, 4px)',
              lineHeight: 1,
            }}
            title="Close terminal (Ctrl+`)"
            aria-label="Close terminal"
          >
            ×
          </button>
        </div>
      )}

      {/* Terminal Area — only render when open to avoid xterm.js crash on zero-size container */}
      {isOpen && (
        <div
          style={{
            flex: 1,
            overflow: 'hidden',
            padding: '4px',
          }}
        >
          <Terminal
            onReady={handleReady}
            onData={handleData}
            onResize={(cols, rows) => {
              if (ptyIdRef.current && window.coderixAPI?.terminal?.resize) {
                window.coderixAPI.terminal.resize(ptyIdRef.current, rows, cols);
              }
            }}
          />
        </div>
      )}
    </div>
  );
}

TerminalPanel.displayName = 'TerminalPanel';
