/**
 * Column-stable glyphs for persistent terminal chrome.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Ink decides how many rows it drew by measuring each line with `string-width`,
 * then moves the cursor up by exactly that many rows to repaint. If the terminal
 * disagrees with `string-width` about how wide a single character is, the line
 * physically soft-wraps onto an extra row that ink does not know about. Ink then
 * moves up too few rows, and the tail of the previous frame is never erased —
 * so the old frame stays on screen and the new one is drawn below it. With a
 * once-per-second status bar you get a visible stack of stale status bars.
 *
 * The disagreement is not a bug in either party. Unicode annex #11 assigns some
 * characters the width class **Ambiguous**: narrow in a Western locale, wide in
 * an East Asian one. `string-width` resolves Ambiguous to 1 column. Terminals in
 * a CJK locale (iTerm2, Terminal.app, WezTerm with "ambiguous = double-width")
 * resolve it to 2. Both are correct per the spec; they just disagree.
 *
 * Box-drawing characters are the trap, because the obvious choices are all
 * Ambiguous:
 *
 *   U+2502 │  Ambiguous   U+2500 ─  Ambiguous   U+2588 █  Ambiguous
 *   U+25CF ●  Ambiguous   U+25CB ○  Ambiguous   U+00B7 ·  Ambiguous
 *
 * while visually-similar alternatives are **Neutral**, meaning 1 column in every
 * terminal regardless of locale:
 *
 *   U+2759 ❙  Neutral     U+23AF ⎯  Neutral     U+25B0 ▰  Neutral
 *   U+25C9 ◉  Neutral     U+2591 ░  Neutral     U+25AA ▪  Neutral
 *
 * So the fix is a substitution, not a downgrade to ASCII: pick the Neutral glyph
 * that looks closest. Widths below are from the Unicode East_Asian_Width table
 * and are asserted by the unit test alongside this file.
 *
 * SOLID VERSUS DASHED, AND THE ONE DELIBERATE AMBIGUOUS EXCEPTION
 * The vertical separator was `╎` (U+254E, LIGHT DOUBLE DASH) — Neutral, but
 * visibly dashed, which read as an unfinished border. It was then tried as `⎸`
 * (U+23B8) and the `❘❙❚` (U+2758..A) dingbat bars: all Neutral, but every one of
 * them renders as a short centered stroke with blank space above and below, so
 * stacked rows show gaps and the frame still reads as dashed. The only glyph
 * that draws a genuinely full-height, continuous, thin vertical line is `│`
 * (U+2502) itself.
 *
 * `│` is East-Asian **Ambiguous**, so this is a deliberate, eyes-open exception
 * to the Neutral-only rule: in a CJK-locale terminal that resolves Ambiguous to
 * 2 columns it can wrap repainted chrome. It is accepted here because every
 * Neutral alternative looks broken, and the unit test beside this file carves
 * `VERTICAL_SEPARATOR` out explicitly rather than letting the exception spread.
 * The horizontal rule and corners stay Neutral; do NOT reach for `┃` U+2503 or
 * `─` U+2500 — they are Ambiguous with no redeeming full-height payoff.
 *
 * WHEN TO USE THIS
 * ----------------
 * Use these for anything that repaints in place: the status bar, dividers,
 * spinners, input prompts, header rules — every row ink has to erase and redraw.
 *
 * You do NOT need them for transcript content that scrolls away and is never
 * repainted, nor for genuine CJK text, where being wide is the point.
 */

/**
 * Vertical separator for framed chrome and status-bar fields.
 *
 * `│` (U+2502) — the only glyph that renders as a full-height continuous thin
 * line. It is East-Asian Ambiguous (see the deliberate-exception note in the
 * file header); the unit test carves it out by name rather than banning it.
 */
export const VERTICAL_SEPARATOR = '│'; // │ BOX DRAWINGS LIGHT VERTICAL (U+2502)

/** Horizontal rule for dividers. Neutral, unlike ─ (U+2500). */
export const HORIZONTAL_RULE = '⎯'; // ⎯ HORIZONTAL LINE EXTENSION

/** Filled cell of a progress/gauge bar. Neutral, unlike █ (U+2588). */
export const GAUGE_FILLED = '▰'; // ▰ BLACK PARALLELOGRAM

/** Empty cell of a progress/gauge bar. U+2591 ░ is already Neutral. */
export const GAUGE_EMPTY = '░'; // ░ LIGHT SHADE

/** Small solid marker for list bullets / state dots. Neutral, unlike ● (U+25CF). */
export const MARKER_SOLID = '▪'; // ▪ BLACK SMALL SQUARE

/** Small hollow marker, the counterpart to MARKER_SOLID. Neutral, unlike ○ (U+25CB). */
export const MARKER_HOLLOW = '▱'; // ▱ WHITE PARALLELOGRAM

/** Interpunct-style dot for inline separators. Neutral, unlike · (U+00B7). */
export const DOT_SEPARATOR = '∙'; // ∙ BULLET OPERATOR

/** Truncation ellipsis. Neutral, unlike … (U+2026). */
export const ELLIPSIS = '⋯'; // ⋯ MIDLINE HORIZONTAL ELLIPSIS

/**
 * Arrows for key hints ("↑↓ to select"). The plain arrows U+2190..U+2193 are all
 * Ambiguous; these U+2B60 block equivalents are Neutral and near-identical.
 */
export const ARROW_UP = '⭡'; //    ⭡ UPWARDS TRIANGLE-HEADED ARROW
export const ARROW_DOWN = '⭣'; //  ⭣ DOWNWARDS TRIANGLE-HEADED ARROW
export const ARROW_LEFT = '⭠'; //  ⭠ LEFTWARDS TRIANGLE-HEADED ARROW
export const ARROW_RIGHT = '⭢'; // ⭢ RIGHTWARDS TRIANGLE-HEADED ARROW

/**
 * Box corners for framed chrome.
 *
 * These are the ordinary box-drawing corners `┌ ┐ └ ┘`. The ENTIRE box-drawing
 * corner/tee repertoire is East-Asian **Ambiguous**, so — like `VERTICAL_SEPARATOR`
 * — this is a deliberate, eyes-open exception to the Neutral-only rule: a frame
 * built from the Neutral "quine" corners (`⌜ ⌝ ⌞ ⌟`) reads as four detached
 * brackets rather than a connected table, which is worse than the wrap risk here.
 * In a CJK-locale terminal that resolves Ambiguous to 2 columns these can wrap
 * repainted chrome; that cost is accepted so the frame looks like a normal table.
 *
 * Note: ink's own named `borderStyle` presets are all Ambiguous too (and `classic`
 * is pure ASCII); `SAFE_BORDER` below restates a box-drawing frame explicitly.
 */
export const CORNER_TOP_LEFT = '┌'; //     ┌ BOX DRAWINGS LIGHT DOWN AND RIGHT
export const CORNER_TOP_RIGHT = '┐'; //    ┐ BOX DRAWINGS LIGHT DOWN AND LEFT
export const CORNER_BOTTOM_LEFT = '└'; //  └ BOX DRAWINGS LIGHT UP AND RIGHT
export const CORNER_BOTTOM_RIGHT = '┘'; // ┘ BOX DRAWINGS LIGHT UP AND LEFT

/**
 * Horizontal rule used for the top/bottom of `SAFE_BORDER`.
 *
 * This is `─` (U+2500), NOT the Neutral `HORIZONTAL_RULE` (`⎯`, U+23AF). The
 * Neutral glyph floats at the character cell's mid-height, so it would leave a
 * visible gap between the top rule and the `┌ ┐ └ ┘` corners. `─` is top-aligned
 * and meets the corners cleanly, at the cost of being Ambiguous-width — the same
 * deliberate exception the corners and `VERTICAL_SEPARATOR` already take. Kept
 * separate from `HORIZONTAL_RULE` so the Neutral rule stays available for the
 * `Divider` primitive, which does not need to connect to corners.
 */
const FRAME_RULE = '─'; // ─ BOX DRAWINGS LIGHT HORIZONTAL (U+2500)

/**
 * Border presets for ink's `borderStyle`, which also accepts an explicit
 * `BoxStyle` object rather than only a named `cli-boxes` style.
 *
 * `SAFE_BORDER` is an ordinary light box-drawing frame (`┌─┐│┘└`). Its glyphs are
 * Ambiguous-width — a deliberate exception (see the corner and `VERTICAL_SEPARATOR`
 * notes) taken so framed chrome looks like a normal connected table rather than
 * detached brackets. `SAFE_BORDER_ASCII` is ink's `classic` (pure ASCII `+-|`),
 * restated here for callers that want a guaranteed Neutral/Narrow frame.
 */
export const SAFE_BORDER = Object.freeze({
  topLeft: CORNER_TOP_LEFT,
  top: FRAME_RULE,
  topRight: CORNER_TOP_RIGHT,
  right: VERTICAL_SEPARATOR,
  bottomRight: CORNER_BOTTOM_RIGHT,
  bottom: FRAME_RULE,
  bottomLeft: CORNER_BOTTOM_LEFT,
  left: VERTICAL_SEPARATOR,
});

export const SAFE_BORDER_ASCII = Object.freeze({
  topLeft: '+',
  top: '-',
  topRight: '+',
  right: '|',
  bottomRight: '+',
  bottom: '-',
  bottomLeft: '+',
  left: '|',
});

/**
 * Ambiguous-width glyphs commonly reached for in terminal chrome, mapped to the
 * Neutral glyph that looks closest. Exported so a lint rule or test can flag a
 * regression, and so callers can migrate a string wholesale via `toSafeGlyphs`.
 */
export const AMBIGUOUS_TO_SAFE: Readonly<Record<string, string>> = Object.freeze({
  // Vertical bars (│ ┃ ┆ ┊ ├ ┤) are intentionally NOT remapped: the only glyph
  // that renders as a full-height continuous line is `│` itself, which is also
  // Ambiguous, so there is no Neutral target to map them to. See the header's
  // deliberate-exception note — chrome keeps `│` as-is.
  '─': HORIZONTAL_RULE, //    ─ -> ⎯
  '━': HORIZONTAL_RULE, //    ━ -> ⎯
  '┄': HORIZONTAL_RULE, //    ┄ -> ⎯
  '┈': HORIZONTAL_RULE, //    ┈ -> ⎯
  '█': GAUGE_FILLED, //       █ -> ▰
  '▓': GAUGE_FILLED, //       ▓ -> ▰
  '▒': GAUGE_EMPTY, //        ▒ -> ░
  '■': MARKER_SOLID, //       ■ -> ▪
  '●': MARKER_SOLID, //       ● -> ▪
  '○': MARKER_HOLLOW, //      ○ -> ▱
  '◎': MARKER_HOLLOW, //      ◎ -> ▱
  '·': DOT_SEPARATOR, //      · -> ∙
  '•': DOT_SEPARATOR, //      • -> ∙
  '…': ELLIPSIS, //           … -> ⋯
  '↑': ARROW_UP, //           ↑ -> ⭡
  '↓': ARROW_DOWN, //         ↓ -> ⭣
  '←': ARROW_LEFT, //         ← -> ⭠
  '→': ARROW_RIGHT, //        → -> ⭢
  // Corners (┌ ╭ ┐ ╮ └ ╰ ┘ ╯) are intentionally NOT remapped: the frame now uses
  // the ordinary box-drawing corners, which are themselves Ambiguous, so there is
  // no Neutral target to map them to (mapping `┌`->`┌` would be a self-map). Same
  // deliberate exception as the vertical bar — see the header note.
  // Tees and the cross have no Neutral box-drawing counterpart; the plain rule
  // is the least-bad substitute that keeps the line continuous.
  '┬': HORIZONTAL_RULE, //    ┬ -> ⎯
  '┴': HORIZONTAL_RULE, //    ┴ -> ⎯
  '┼': HORIZONTAL_RULE, //    ┼ -> ⎯
});

/**
 * Replace every known Ambiguous-width chrome glyph in `text` with its Neutral
 * equivalent, leaving all other characters — including real CJK text — alone.
 *
 * Intended for strings assembled at runtime (tool output, model names, file
 * paths) that land in repainted chrome. Static literals should just use the
 * constants above directly, so the intent is visible at the call site.
 */
export function toSafeGlyphs(text: string): string {
  let out = '';
  for (const ch of text) out += AMBIGUOUS_TO_SAFE[ch] ?? ch;
  return out;
}
