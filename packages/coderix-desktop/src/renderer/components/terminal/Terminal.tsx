import React, { useEffect, useRef, useCallback } from 'react';
import { Terminal as XTerm, type ITheme } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { useUIStore } from '../../store/uiStore';

// Import xterm CSS — it ships with the npm package
import 'xterm/css/xterm.css';

/** xterm color palettes — track the desktop light/dark theme. */
const TERMINAL_THEMES: Record<'light' | 'dark', ITheme> = {
  light: {
    background: '#FAF9F5',
    foreground: '#29261B',
    cursor: '#D97757',
    cursorAccent: '#FAF9F5',
    selectionBackground: '#D97757',
    selectionForeground: '#FFFFFF',
    black: '#29261B',
    red: '#C93B1F',
    green: '#1E7D32',
    yellow: '#A86A00',
    blue: '#0A66C2',
    magenta: '#9C27B0',
    cyan: '#00696E',
    white: '#FAF9F5',
    brightBlack: '#656358',
    brightRed: '#E5484D',
    brightGreen: '#30A46C',
    brightYellow: '#C77D00',
    brightBlue: '#0A84FF',
    brightMagenta: '#B066C8',
    brightCyan: '#0E818C',
    brightWhite: '#FFFFFF',
  },
  dark: {
    background: '#262624',
    foreground: '#EDEBE0',
    cursor: '#D97757',
    cursorAccent: '#262624',
    selectionBackground: '#D97757',
    selectionForeground: '#262624',
    black: '#262624',
    red: '#FF453A',
    green: '#30D158',
    yellow: '#FFD60A',
    blue: '#0A84FF',
    magenta: '#FF375F',
    cyan: '#5AC8FA',
    white: '#EDEBE0',
    brightBlack: '#6B6860',
    brightRed: '#FF6961',
    brightGreen: '#32D74B',
    brightYellow: '#FFD426',
    brightBlue: '#409CFF',
    brightMagenta: '#FF6482',
    brightCyan: '#70D7FF',
    brightWhite: '#FFFFFF',
  },
};

export interface TerminalProps {
  /** Optional PTY session ID from the main process (via terminal:create) */
  ptySessionId?: string;
  /** Called when the terminal is ready (the xterm instance is available) */
  onReady?: (term: XTerm) => void;
  /** Called when user types into the terminal */
  onData?: (data: string) => void;
  /** Called when terminal is resized (cols, rows) */
  onResize?: (cols: number, rows: number) => void;
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
  onResize,
  readOnly = false,
}: TerminalProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  const theme = useUIStore((s) => s.theme);
  const themeRef = useRef<typeof theme>(theme);
  themeRef.current = theme;

  // ── Initialize xterm ──────────────────────────────────────
  const initTerminal = useCallback(() => {
    if (!containerRef.current || termRef.current) return;

    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;

    const term = new XTerm({
      // macOS-style appearance, palette follows the desktop light/dark theme
      theme: TERMINAL_THEMES[themeRef.current],
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
      if (onResize && termRef.current) {
        onResize(termRef.current.cols, termRef.current.rows);
      }
    });

    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => observer.disconnect();
  }, [onResize]);

  // ── Theme sync ─────────────────────────────────────────────
  // Update the live xterm palette on theme change without recreating the
  // instance (which would drop the PTY connection).
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = TERMINAL_THEMES[theme];
    }
  }, [theme]);

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
        // macOS translucent bg + blur — background follows the desktop theme
        background: TERMINAL_THEMES[theme].background,
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
