/**
 * Shared diff line syntax highlighting for Write/Update renderers.
 *
 * Uses highlight.js to colorize code portions of git-style diff lines.
 * Added and context lines get syntax highlighting.
 * Deletion lines render as plain text.
 */

import hljs from 'highlight.js';
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
