import React, { useEffect, useRef, useCallback } from 'react';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';

// Import xterm CSS — it ships with the npm package
import 'xterm/css/xterm.css';

export interface TerminalProps {
  /** Optional PTY session ID from the main process (via terminal:create) */
  ptySessionId?: string;
  /** Called when the terminal is ready (the xterm instance is available) */
  onReady?: (term: XTerm) => void;
  /** Called when user types into the terminal */
  onData?: (data: string) => void;
  /** If true, the terminal is in a collapsed/read-only state */
  readOnly?: boolean;
}

/**
 * Terminal — xterm.js terminal component with macOS-style appearance.
 *
 * Features:
 *   - Creates and manages an xterm.js instance in the DOM
 *   - Uses xterm-addon-fit for automatic container resizing
 *   - macOS-style: semi-transparent background, backdrop blur, rounded corners
 *   - Manages PTY lifecycle via useEffect
 *   - Single-tab design (multi-tab can be added later with TerminalTabs wrapper)
 *
 * PTY Integration (when main process handlers are added):
 *   1. Main process creates a PTY via `terminal:create` IPC
 *   2. Returns a ptySessionId
 *   3. Renderer listens on `terminal:{ptySessionId}:data` for terminal output
 *   4. Renderer sends `terminal:resize` with cols/rows when the terminal resizes
 *   5. Renderer sends `terminal:{ptySessionId}:write` when user types
 *
 * For the current MVP, the terminal can operate in local-echo mode
 * (writing directly to xterm) until PTY IPC is fully wired.
 */
export default function Terminal({
  ptySessionId: _ptySessionId,
  onReady,
  onData,
  readOnly = false,
}: TerminalProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  // ── Initialize xterm ──────────────────────────────────────
  const initTerminal = useCallback(() => {
    if (!containerRef.current || termRef.current) return;

    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;

    const term = new XTerm({
      // macOS-style appearance
      theme: {
        background: 'rgba(28, 28, 30, 0.85)',
        foreground: '#f5f5f7',
        cursor: '#0a84ff',
        cursorAccent: '#1c1c1e',
        selectionBackground: '#0a84ff',
        selectionForeground: '#ffffff',
        // ANSI colors — macOS Terminal.app palette
        black: '#1c1c1e',
        red: '#ff453a',
        green: '#30d158',
        yellow: '#ff9f0a',
        blue: '#0a84ff',
        magenta: '#ff375f',
        cyan: '#5ac8fa',
        white: '#f5f5f7',
        brightBlack: '#636366',
        brightRed: '#ff6961',
        brightGreen: '#32d74b',
        brightYellow: '#ffd426',
        brightBlue: '#409cff',
        brightMagenta: '#ff6482',
        brightCyan: '#70d7ff',
        brightWhite: '#ffffff',
      },
      fontSize: 13,
      fontFamily: "'SF Mono', 'JetBrains Mono', 'Fira Code', ui-monospace, monospace",
      cursorBlink: true,
      cursorStyle: 'bar',
      allowProposedApi: true,
      disableStdin: readOnly,
      // Rounded corners via padding
      rows: 24,
      cols: 80,
      smoothScrollDuration: 100,
    });

    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    // Auto-fit on mount
    setTimeout(() => {
      try {
        fitAddon.fit();
      } catch {
        // Fit may fail if container has zero dimensions — retry later
      }
    }, 50);

    // Forward user input
    if (onData) {
      term.onData(onData);
    }

    termRef.current = term;
    onReady?.(term);
  }, [readOnly, onReady, onData]);

  // ── Lifecycle ──────────────────────────────────────────────
  useEffect(() => {
    initTerminal();

    return () => {
      // Dispose xterm instance on unmount
      if (termRef.current) {
        termRef.current.dispose();
        termRef.current = null;
        fitAddonRef.current = null;
      }
    };
  }, [initTerminal]);

  // ── Resize Handling ────────────────────────────────────────
  useEffect(() => {
    const handleResize = (): void => {
      if (fitAddonRef.current) {
        try {
          fitAddonRef.current.fit();
        } catch {
          // Container may be hidden — ignore
        }
      }
    };

    const observer = new ResizeObserver(() => {
      handleResize();
    });

    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => observer.disconnect();
  }, []);

  // ── Render ─────────────────────────────────────────────────
  return (
    <div
      ref={containerRef}
      className="terminal-container"
      style={{
        width: '100%',
        height: '100%',
        borderRadius: 'var(--radius-lg, 8px)',
        overflow: 'hidden',
        // macOS translucent bg + blur — terminal stays dark for readability
        background: 'var(--color-terminal-bg, #29261B)',
        backdropFilter: 'saturate(180%) blur(20px)',
        WebkitBackdropFilter: 'saturate(180%) blur(20px)',
      }}
    />
  );
}

/**
 * Write data to the terminal (e.g., from PTY output or simulated commands).
 */
export function writeToTerminal(term: XTerm | null, data: string): void {
  if (term) {
    term.write(data);
  }
}

/**
 * Resize the terminal programmatically.
 */
export function resizeTerminal(term: XTerm | null, cols: number, rows: number): void {
  if (term) {
    term.resize(cols, rows);
  }
}

Terminal.displayName = 'Terminal';
