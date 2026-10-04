/**
 * Shared diff line syntax highlighting for Write/Update renderers.
 *
 * Uses highlight.js to colorize code portions of git-style diff lines.
 * Added and context lines get syntax highlighting.
 * Deletion lines render as plain text.
 */

import hljs from 'highlight.js';
import { textWidth } from '@coderix/tui';
import { parseHtmlTokens, type HighlightToken } from '../../tui/components/highlight.js';

/** Detect highlight.js language from file extension. */
export function detectLanguage(filePath: string): string | null {
  const ext = filePath.split('.').pop()?.toLowerCase();
  if (ext && hljs.getLanguage(ext)) return ext;
  return null;
}

export interface DiffLineTokens {
  prefix: string;
  codeTokens: HighlightToken[];
  isAdd: boolean;
  isRemove: boolean;
}

/**
 * Parse a git-style diff line into prefix + syntax-highlighted code tokens.
 *
 * Diff format: "NNNN +text" / "NNNN -text" / "NNNN  text"
 * - Positions 0-3: line number
 * - Position 4: space
 * - Position 5: marker (+, -, or space)
 * - Position 6+: code text
 *
 * Only added lines (marker '+') get syntax highlighting.
 * Context and deletion lines render as plain text with default terminal color.
 */
export function highlightDiffLine(
  line: string,
  lang: string | null,
): DiffLineTokens {
  const prefix = line.slice(0, 6);
  const codeText = line.slice(6);
  const isAdd = line[5] === '+';
  const isRemove = line[5] === '-';

  let codeTokens: HighlightToken[] = [
    { text: codeText || ' ', color: '#FFFFFF' },
  ];

  // Highlight added and context lines
  if ((isAdd || (!isAdd && !isRemove)) && lang && codeText.trim()) {
    try {
      const result = hljs.highlight(codeText, {
        language: lang,
        ignoreIllegals: true,
      });
      codeTokens = parseHtmlTokens(result.value);
    } catch {
      // Fall back to plain text
    }
  }

  return { prefix, codeTokens, isAdd, isRemove };
}

/**
 * Truncate a list of highlighted code tokens so their combined terminal width
 * does not exceed `maxColumns`. When truncation occurs, an ellipsis token (`…`,
 * one column) is appended, carrying the color of the last visible token.
 *
 * Measuring in columns (via `textWidth`) rather than `.length` keeps CJK and
 * emoji from overshooting. Returns the original array when it already fits, so
 * callers can apply it unconditionally.
 */
export function truncateTokens(
  tokens: HighlightToken[],
  maxColumns: number,
): HighlightToken[] {
  if (maxColumns <= 0) return [];

  let total = 0;
  for (const t of tokens) total += textWidth(t.text);
  if (total <= maxColumns) return tokens;

  // Reserve one column for the ellipsis that signals the cut.
  const budget = maxColumns - 1;
  const out: HighlightToken[] = [];
  let used = 0;
  let lastColor: HighlightToken['color'] = tokens[0]?.color ?? '#FFFFFF';

  for (const token of tokens) {
    const w = textWidth(token.text);
    if (used + w <= budget) {
      out.push(token);
      used += w;
      lastColor = token.color;
      continue;
    }
    // Partial fit: accumulate characters up to the remaining budget.
    let partial = '';
    let partialUsed = 0;
    for (const char of token.text) {
      const cw = textWidth(char);
      if (used + partialUsed + cw > budget) break;
      partial += char;
      partialUsed += cw;
    }
    if (partial) {
      out.push({ ...token, text: partial });
      lastColor = token.color;
    }
    break;
  }

  out.push({ text: '…', color: lastColor });
  return out;
}

export interface DiffHunkGroup {
  lines: string[];
  /** How many unchanged lines were skipped before this hunk. */
  skippedBefore: number;
}

/**
 * Group diff lines into hunks around changed lines.
 *
 * Each hunk includes up to `contextLines` unchanged lines before and after
 * the changed region. Large unchanged gaps between hunks are collapsed and
 * counted as `skippedBefore` so the renderer can show "... N unchanged lines".
 */
export function groupDiffHunks(
  diffLines: string[],
  contextLines = 3,
): DiffHunkGroup[] {
  const groups: DiffHunkGroup[] = [];
  let current: string[] = [];
  let contextAfter: string[] = [];
  let skipped = 0;

  for (const line of diffLines) {
    const isChanged = line.length > 5 && (line[5] === '+' || line[5] === '-');

    if (isChanged) {
      // Flush any pending context-after into the current hunk
      if (contextAfter.length > 0) {
        current.push(...contextAfter);
        contextAfter = [];
        skipped = 0;
      }
      current.push(line);
    } else if (current.length > 0) {
      // Inside a hunk: collect trailing context
      if (contextAfter.length < contextLines) {
        contextAfter.push(line);
      } else {
        // Trailing context is full — close hunk and start skipping
        current.push(...contextAfter);
        groups.push({ lines: current, skippedBefore: skipped > 0 ? skipped : 0 });
        current = [];
        contextAfter = [];
        skipped = 1;
      }
    } else {
      // Outside any hunk: count skipped lines
      skipped++;
    }
  }

  // Last hunk
  if (current.length > 0) {
    current.push(...contextAfter);
    groups.push({ lines: current, skippedBefore: skipped > 0 ? skipped : 0 });
  }

  return groups;
}
