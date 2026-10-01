import { ClipboardAddon } from '@xterm/addon-clipboard';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import type { ILink, ILinkHandler, ITheme, IWindowsPty } from '@xterm/xterm';
import { ClipboardPaste, Copy } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../../i18n/index.js';
import { getHttpLinksForTerminalBufferLine } from './terminalLinks.js';
import { mergeTerminalTheme, observeTerminalTheme } from './terminalTheme.js';

// xterm ships its own stylesheet — required for cursor/blink and row rendering.
import '@xterm/xterm/css/xterm.css';

const DEFAULT_TERMINAL_FONT_FAMILY =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Monaco, Consolas, 'Cascadia Mono', 'JetBrains Mono', 'MesloLGS NF', 'Hack Nerd Font', monospace";

function normalizeWindowsPtyOption(windowsPty: IWindowsPty | undefined): IWindowsPty | undefined {
  if (!windowsPty) return undefined;
  return windowsPty.buildNumber
    ? { backend: windowsPty.backend, buildNumber: windowsPty.buildNumber }
    : { backend: windowsPty.backend };
}

function normalizeTerminalFontSize(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 6 || value > 72) {
    return undefined;
  }
  return value;
}

function formatShellLabel(shell: string | null): string | null {
  if (!shell) {
    return null;
  }

  const shellParts = shell.split(/[\\/]/);
  const lastPart = shellParts[shellParts.length - 1];
  const name = lastPart?.replace(/\.exe$/i, '').toLowerCase();
  if (!name) {
    return shell;
  }
  if (name === 'powershell' || name === 'pwsh') {
    return 'PowerShell';
  }
  return name;
}

function isHttpTerminalUrl(text: string): boolean {
  return /^https?:\/\//i.test(text);
}

export interface TerminalProps {
  /** Stable UI session id (tab identity, separate from the main-process PTY id). */
  sessionId: string;
  cwd?: string;
  isVisible: boolean;
  onShellLabelChange?: (shellLabel: string | null) => void;
  onExit?: (exitCode: number) => void;
  onOpenBrowserUrl?: (url: string) => void;
}

/**
 * Terminal — a single xterm.js session backed by a main-process PTY.
 *
 * Keeps xterm + PTY alive across tab switches (the parent keeps inactive tabs
 * mounted but hidden via CSS). Creates the PTY through `window.coderixAPI.terminal`,
 * inherits the system terminal font/theme from the main process, and wires
 * clipboard, http-link opening, and shell-label reporting.
 */
export default function Terminal({
  sessionId,
  cwd,
  isVisible,
  onShellLabelChange,
  onExit,
  onOpenBrowserUrl,
}: TerminalProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef<string | null>(null);
  const isVisibleRef = useRef(isVisible);
  const profileThemeRef = useRef<ITheme | undefined>(undefined);
  const lastSentSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const resizeRAFRef = useRef(0);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  const exitHandlerRef = useRef(onExit);
  const openBrowserUrlRef = useRef(onOpenBrowserUrl);
  const shellLabelRef = useRef(onShellLabelChange);
  exitHandlerRef.current = onExit;
  openBrowserUrlRef.current = onOpenBrowserUrl;
  shellLabelRef.current = onShellLabelChange;
  isVisibleRef.current = isVisible;

  const flushResize = useCallback(() => {
    const terminalId = terminalIdRef.current;
    const term = termRef.current;
    if (!terminalId || !term) return;
    const size = { cols: term.cols, rows: term.rows };
    const last = lastSentSizeRef.current;
    if (last && last.cols === size.cols && last.rows === size.rows) return;
    lastSentSizeRef.current = size;
    window.coderixAPI?.terminal.resize(terminalId, size.rows, size.cols);
  }, []);

  const fitAndResize = useCallback(() => {
    const el = containerRef.current;
    const term = termRef.current;
    const fit = fitAddonRef.current;
    if (!isVisibleRef.current || !el || !term || !fit || el.clientWidth <= 0 || el.clientHeight <= 0) {
      return;
    }
    try {
      fit.fit();
    } catch {
      return;
    }
    flushResize();
  }, [flushResize]);

  // ── Create xterm + PTY on mount ─────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let disposed = false;
    profileThemeRef.current = undefined;

    const term = new XTerm({
      fontSize: 13,
      fontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
      theme: mergeTerminalTheme(undefined),
      linkHandler: {
        allowNonHttpProtocols: false,
        activate(event, text) {
          if (!isHttpTerminalUrl(text)) return;
          event.preventDefault();
          openBrowserUrlRef.current?.(text);
        },
      } satisfies ILinkHandler,
    });
    termRef.current = term;

    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    term.loadAddon(fitAddon);
    // ClipboardAddon enables OSC 52 and copies selections to the system clipboard.
    term.loadAddon(new ClipboardAddon());
    term.open(el);

    // First visible fit so the PTY starts with real cols/rows, not xterm defaults.
    if (isVisibleRef.current && el.clientWidth > 0 && el.clientHeight > 0) {
      try {
        fitAddon.fit();
      } catch {
        // zero-size container — retry on the next resize observer tick
      }
    }

    // Intercept Cmd/Ctrl+C (copy selection) and Cmd/Ctrl+V (paste).
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      if (!(e.metaKey || e.ctrlKey)) return true;
      const key = e.key.toLowerCase();
      if (key === 'c' && term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection()).catch(() => {});
        return false;
      }
      if (key === 'v') {
        // Prevent xterm from also writing `^V`; paste once via the system clipboard.
        e.preventDefault();
        e.stopPropagation();
        navigator.clipboard
          .readText()
          .then((text) => {
            if (text) term.paste(text);
          })
          .catch(() => {});
        return false;
      }
      return true;
    });

    // Follow the app's data-theme changes without recreating the instance.
    const unsubscribeTheme = observeTerminalTheme(() => {
      term.options.theme = mergeTerminalTheme(profileThemeRef.current);
    });

    // http links are not React DOM; resolve them from the terminal buffer.
    const linkProvider = term.registerLinkProvider({
      provideLinks(bufferLineNumber, callback) {
        const links = getHttpLinksForTerminalBufferLine(
          term.buffer.active,
          bufferLineNumber,
          term.cols,
        )?.map(
          (link): ILink => ({
            ...link,
            activate(event, text) {
              event.preventDefault();
              openBrowserUrlRef.current?.(text);
            },
          }),
        );
        callback(links);
      },
    });

    const cleanupFns: Array<() => void> = [];

    const api = window.coderixAPI?.terminal;
    if (!api) {
      term.write('\r\n[Terminal unavailable — preload missing]\r\n');
    } else {
      const initialSize = { cols: term.cols, rows: term.rows };

      api
        .create({ cwd, cols: initialSize.cols, rows: initialSize.rows })
        .then(({ terminalId, shell, fontFamily, fontSize, theme, windowsPty }) => {
          if (disposed) {
            api.destroy(terminalId);
            return;
          }
          terminalIdRef.current = terminalId;
          term.options.windowsPty = normalizeWindowsPtyOption(windowsPty);
          term.options.fontFamily = fontFamily || DEFAULT_TERMINAL_FONT_FAMILY;
          const nextFontSize = normalizeTerminalFontSize(fontSize);
          if (nextFontSize) {
            term.options.fontSize = nextFontSize;
          }
          profileThemeRef.current = theme as ITheme | undefined;
          term.options.theme = mergeTerminalTheme(profileThemeRef.current);
          shellLabelRef.current?.(formatShellLabel(shell));
          flushResize();

          cleanupFns.push(
            api.onData(terminalId, (data) => {
              term.write(data);
            }),
          );
          cleanupFns.push(
            api.onExit(terminalId, (exitCode) => {
              if (exitHandlerRef.current) {
                exitHandlerRef.current(exitCode);
                return;
              }
              term.write(`\r\n${t('terminal.exited')}\r\n`);
            }),
          );
          term.onData((data) => {
            api.write(terminalId, data);
          });
        })
        .catch((error) => {
          if (disposed) return;
          const message = error instanceof Error ? error.message : String(error);
          term.write(`\r\n[Terminal failed to start]\r\n${message}\r\n`);
        });
    }

    const resizeObserver = new ResizeObserver(() => {
      if (!isVisibleRef.current) return;
      if (resizeRAFRef.current) cancelAnimationFrame(resizeRAFRef.current);
      resizeRAFRef.current = requestAnimationFrame(() => fitAndResize());
    });
    resizeObserver.observe(el);

    if (isVisibleRef.current) {
      requestAnimationFrame(() => {
        if (!disposed && isVisibleRef.current) term.focus();
      });
    }

    return () => {
      disposed = true;
      unsubscribeTheme();
      linkProvider.dispose();
      resizeObserver.disconnect();
      if (resizeRAFRef.current) cancelAnimationFrame(resizeRAFRef.current);
      cleanupFns.forEach((fn) => fn());
      const terminalId = terminalIdRef.current;
      if (terminalId) window.coderixAPI?.terminal.destroy(terminalId);
      terminalIdRef.current = null;
      fitAddonRef.current = null;
      term.dispose();
      termRef.current = null;
    };
  }, [cwd, sessionId, fitAndResize]);

  // Refit + focus when becoming visible (tab switch / panel reopen).
  useEffect(() => {
    isVisibleRef.current = isVisible;
    if (isVisible) {
      fitAndResize();
      requestAnimationFrame(() => {
        if (isVisibleRef.current) termRef.current?.focus();
      });
    }
  }, [isVisible, fitAndResize]);

  // ── Context menu ───────────────────────────────────────────
  const handleCopy = useCallback(() => {
    const term = termRef.current;
    if (!term?.hasSelection()) return;
    void navigator.clipboard.writeText(term.getSelection()).catch(() => {});
  }, []);

  const handlePaste = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    navigator.clipboard
      .readText()
      .then((text) => text && term.paste(text))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('resize', close);
    };
  }, [contextMenu]);

  return (
    <>
      <div
        ref={containerRef}
        className="terminal-xterm-shell h-full min-h-0 w-full overflow-hidden"
        onContextMenu={(e) => {
          e.preventDefault();
          setContextMenu({ x: e.clientX, y: e.clientY });
        }}
      />
      {contextMenu && (
        <div
          className="fixed z-[900] min-w-[140px] py-1 rounded-[var(--radius-md)] border border-[var(--color-separator)] bg-[var(--color-bg-primary)] shadow-lg"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              handleCopy();
              setContextMenu(null);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)]"
          >
            <Copy size={14} className="text-[var(--color-text-tertiary)]" />
            {t('terminal.contextMenu.copy')}
          </button>
          <button
            type="button"
            onClick={() => {
              handlePaste();
              setContextMenu(null);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)]"
          >
            <ClipboardPaste size={14} className="text-[var(--color-text-tertiary)]" />
            {t('terminal.contextMenu.paste')}
          </button>
        </div>
      )}
    </>
  );
}

Terminal.displayName = 'Terminal';
