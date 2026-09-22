/**
 * Color value types and normalization for the Coderix TUI.
 *
 * The upstream `ink` renderer (via `chalk`) already understands named colors,
 * `#hex`, `rgb(r,g,b)` and `ansi256(n)`. The only Coderix-specific spelling is
 * the `ansi:NAME` prefix, which we strip so it resolves to the chalk color
 * name. Everything else is passed through untouched.
 */

export type RgbColor = `rgb(${number},${number},${number})`;
export type HexColor = `#${string}`;
export type Ansi256Color = `ansi256(${number})`;
export type AnsiColor = `ansi:${string}`;
export type Color = RgbColor | HexColor | Ansi256Color | AnsiColor;

/** Prefix stripped from `ansi:NAME` color spellings. */
const ANSI_PREFIX = 'ansi:';

/**
 * Normalize a color string into the form `ink`'s chalk-backed colorizer
 * accepts. Idempotent for already-valid `ink` colors.
 */
export function resolveColor(color: string): string {
  if (color.startsWith(ANSI_PREFIX)) {
    return color.slice(ANSI_PREFIX.length);
  }
  return color;
}
