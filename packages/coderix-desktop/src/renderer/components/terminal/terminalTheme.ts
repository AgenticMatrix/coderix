import type { ITheme } from '@xterm/xterm';

function readTerminalColor(style: CSSStyleDeclaration, name: string, fallback: string) {
  return style.getPropertyValue(name).trim() || fallback;
}

/**
 * xterm's `css.toColor` rejects `color-mix()`, `var()`, and modern
 * `rgb(r g b / a)` syntax. Resolve through a hidden element + canvas so the
 * result is normalized to an old-style `rgba(r, g, b, a)` string xterm accepts.
 */
const colorResolverEl: HTMLSpanElement | null =
  typeof document === 'undefined' ? null : document.createElement('span');
const colorNormalizeCtx: CanvasRenderingContext2D | null = (() => {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (ctx) ctx.globalCompositeOperation = 'copy';
  return ctx;
})();

function normalizeCssColor(raw: string, fallback: string): string {
  if (!raw || !colorResolverEl || !colorNormalizeCtx || !document.body) {
    return raw || fallback;
  }
  try {
    document.body.appendChild(colorResolverEl);
    colorResolverEl.style.color = '';
    colorResolverEl.style.color = raw;
    const resolved = getComputedStyle(colorResolverEl).color;
    colorNormalizeCtx.fillStyle = '#000';
    colorNormalizeCtx.fillStyle = resolved;
    colorNormalizeCtx.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 255] = colorNormalizeCtx.getImageData(0, 0, 1, 1).data;
    return `rgba(${r}, ${g}, ${b}, ${+(a / 255).toFixed(3)})`;
  } catch {
    return fallback;
  } finally {
    colorResolverEl.remove();
  }
}

const TERMINAL_THEME_TOKENS = {
  background: ['--color-terminal-bg', '#171717'],
  foreground: ['--color-terminal-fg', '#e5e5e5'],
  cursor: ['--color-terminal-cursor', '#e5e5e5'],
  cursorAccent: ['--color-terminal-cursor-accent', '#171717'],
  selectionBackground: ['--color-terminal-selection', 'rgba(125, 125, 125, 0.3)'],
  selectionInactiveBackground: ['--color-terminal-selection-inactive', 'rgba(125, 125, 125, 0.2)'],
  black: ['--color-terminal-black', '#1f2937'],
  red: ['--color-terminal-red', '#ef4444'],
  green: ['--color-terminal-green', '#22c55e'],
  yellow: ['--color-terminal-yellow', '#eab308'],
  blue: ['--color-terminal-blue', '#3b82f6'],
  magenta: ['--color-terminal-magenta', '#a855f7'],
  cyan: ['--color-terminal-cyan', '#06b6d4'],
  white: ['--color-terminal-white', '#e5e7eb'],
  brightBlack: ['--color-terminal-bright-black', '#6b7280'],
  brightRed: ['--color-terminal-bright-red', '#f87171'],
  brightGreen: ['--color-terminal-bright-green', '#4ade80'],
  brightYellow: ['--color-terminal-bright-yellow', '#facc15'],
  brightBlue: ['--color-terminal-bright-blue', '#60a5fa'],
  brightMagenta: ['--color-terminal-bright-magenta', '#c084fc'],
  brightCyan: ['--color-terminal-bright-cyan', '#22d3ee'],
  brightWhite: ['--color-terminal-bright-white', '#f9fafb'],
} satisfies Partial<Record<keyof ITheme, readonly [string, string]>>;

/** Read the terminal theme from CSS variables, following the app's data-theme. */
function getTerminalTheme() {
  const style = getComputedStyle(document.documentElement);
  return Object.fromEntries(
    Object.entries(TERMINAL_THEME_TOKENS).map(([key, [tokenName, fallback]]) => [
      key,
      normalizeCssColor(readTerminalColor(style, tokenName, fallback), fallback),
    ]),
  ) as ITheme;
}

function restrictInheritedTerminalTheme(profileTheme: ITheme | undefined): ITheme | undefined {
  if (!profileTheme) {
    return undefined;
  }

  const inheritedTheme = { ...profileTheme };
  // A macOS iTerm2 / Terminal profile carries background/foreground/cursor, which
  // would override the app theme and render a dark terminal block inside a light
  // app (or a cursor that clashes with the current background). These readability
  // colors must always follow the app theme; only ANSI / selection details inherit.
  delete inheritedTheme.background;
  delete inheritedTheme.foreground;
  delete inheritedTheme.cursor;
  delete inheritedTheme.cursorAccent;

  return Object.keys(inheritedTheme).length > 0 ? inheritedTheme : undefined;
}

export function mergeTerminalTheme(profileTheme: ITheme | undefined): ITheme {
  const appTheme = getTerminalTheme();
  const inheritedTheme = restrictInheritedTerminalTheme(profileTheme);
  return inheritedTheme ? { ...appTheme, ...inheritedTheme } : appTheme;
}

/** Observe `data-theme` changes (coderix uses an attribute, not a class). */
export function observeTerminalTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  return () => observer.disconnect();
}
