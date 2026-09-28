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
 *   U+23B8 ⎸  Neutral     U+23AF ⎯  Neutral     U+25B0 ▰  Neutral
 *   U+25C9 ◉  Neutral     U+2591 ░  Neutral     U+25AA ▪  Neutral
 *
 * So the fix is a substitution, not a downgrade to ASCII: pick the Neutral glyph
 * that looks closest. Widths below are from the Unicode East_Asian_Width table
 * and are asserted by the unit test alongside this file.
 *
 * SOLID VERSUS DASHED IS A FREE CHOICE; AMBIGUOUS VERSUS NEUTRAL IS NOT
 * The vertical separator was `╎` (U+254E, LIGHT DOUBLE DASH) — Neutral, but
 * visibly dashed, which read as an unfinished border. The dashes were never the
 * point: within U+2500..U+257F the dashed and half-line forms are the ONLY
 * Neutral ones, so `╎` was reached for as the nearest safe thing to `│`.
 *
 * It is not the nearest. `⎸` (U+23B8, LEFT VERTICAL BOX LINE) is a full-height
 * SOLID rule and is also Neutral, so the dashes can go without giving up the
 * width guarantee. Other solid Neutral options, if the weight ever needs
 * changing: `❘` U+2758 (light), `❙` U+2759 (medium), `❚` U+275A (heavy).
 *
 * What cannot be used, however much it is wanted, is `│` (U+2502) itself, or
 * `┃` U+2503, or `─` U+2500 for the rule — all Ambiguous. Verified against the
 * East_Asian_Width table rather than assumed; the test beside this file fails on
 * any constant that regresses to an Ambiguous code point.
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
 * Solid and full-height, unlike the dashed `╎` it replaced, and Neutral unlike
 * the `│` (U+2502) it resembles.
 */
export const VERTICAL_SEPARATOR = '⎸'; // ⎸ LEFT VERTICAL BOX LINE

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
 * Note that the ENTIRE box-drawing corner and tee repertoire (┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼
 * and the rounded ╭ ╮ ╯ ╰) is Ambiguous — within U+2500..U+257F only the dashed
 * and half-line forms are Neutral. So a frame cannot be built from box-drawing
 * characters at all without risking a wrap. These quine corners are Neutral and
 * read acceptably as a frame.
 *
 * The same constraint applies to ink's own `borderStyle` prop, which draws from
 * `cli-boxes` and is therefore Ambiguous: avoid it on chrome that repaints.
 */
export const CORNER_TOP_LEFT = '⌜'; //     ⌜ TOP LEFT CORNER
export const CORNER_TOP_RIGHT = '⌝'; //    ⌝ TOP RIGHT CORNER
export const CORNER_BOTTOM_LEFT = '⌞'; //  ⌞ BOTTOM LEFT CORNER
export const CORNER_BOTTOM_RIGHT = '⌟'; // ⌟ BOTTOM RIGHT CORNER

/**
 * Border presets for ink's `borderStyle`, which also accepts an explicit
 * `BoxStyle` object rather than only a named `cli-boxes` style.
 *
 * This matters because EVERY named style ink ships is built from Ambiguous-width
 * characters — `single` (┌─┐│┘└), `double` (╔═╗║╝╚), `round` (╭─╮│╯╰), `bold`
 * (┏━┓┃┛┗), `singleDouble`, `doubleSingle` and `arrow` (↑↓←→) alike. The sole
 * exception is `classic`, which is pure ASCII (+-|). So any bordered box in
 * chrome that repaints will wrap in a CJK-locale terminal unless it passes one
 * of these.
 *
 * `SAFE_BORDER` keeps a line-drawing look using Neutral glyphs; `SAFE_BORDER_ASCII`
 * is ink's `classic`, restated here so callers need not know that one named style
 * happens to be safe.
 */
export const SAFE_BORDER = Object.freeze({
  topLeft: CORNER_TOP_LEFT,
  top: HORIZONTAL_RULE,
  topRight: CORNER_TOP_RIGHT,
  right: VERTICAL_SEPARATOR,
  bottomRight: CORNER_BOTTOM_RIGHT,
  bottom: HORIZONTAL_RULE,
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
  '│': VERTICAL_SEPARATOR, // │ -> ╎
  '┃': VERTICAL_SEPARATOR, // ┃ -> ╎
  '┆': VERTICAL_SEPARATOR, // ┆ -> ╎
  '┊': VERTICAL_SEPARATOR, // ┊ -> ╎
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
  '┌': CORNER_TOP_LEFT, //    ┌ -> ⌜
  '╭': CORNER_TOP_LEFT, //    ╭ -> ⌜
  '┐': CORNER_TOP_RIGHT, //   ┐ -> ⌝
  '╮': CORNER_TOP_RIGHT, //   ╮ -> ⌝
  '└': CORNER_BOTTOM_LEFT, // └ -> ⌞
  '╰': CORNER_BOTTOM_LEFT, // ╰ -> ⌞
  '┘': CORNER_BOTTOM_RIGHT, //┘ -> ⌟
  '╯': CORNER_BOTTOM_RIGHT, //╯ -> ⌟
  // Tees and the cross have no Neutral box-drawing counterpart; the plain rule
  // is the least-bad substitute that keeps the line continuous.
  '┬': HORIZONTAL_RULE, //    ┬ -> ⎯
  '┴': HORIZONTAL_RULE, //    ┴ -> ⎯
  '┼': HORIZONTAL_RULE, //    ┼ -> ⎯
  '├': VERTICAL_SEPARATOR, // ├ -> ╎
  '┤': VERTICAL_SEPARATOR, // ┤ -> ╎
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
