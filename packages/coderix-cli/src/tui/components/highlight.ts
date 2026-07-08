/**
 * Syntax highlighting for code blocks using highlight.js.
 *
 * Uses highlight.js to tokenize source code, then maps the HTML output
 * to Ink-compatible color props for terminal rendering.
 */

import hljs from 'highlight.js';

/** Get the default text color based on theme. */
function defaultColor(theme?: string): string {
  return theme === 'light' ? '#000000' : '#FFFFFF';
}

/** Mappings from highlight.js CSS classes to Ink color names. */
const COLOR_MAP: Record<string, string> = {
  'hljs-keyword': 'magenta',
  'hljs-built_in': 'yellow',
  'hljs-type': 'yellow',
  'hljs-literal': 'yellow',
  'hljs-number': 'yellow',
  'hljs-regexp': 'yellow',
  'hljs-string': 'green',
  'hljs-comment': 'grey',
  'hljs-meta': 'grey',
  'hljs-title.function_': 'cyan',
  'hljs-title.class_': 'cyan',
  'hljs-function': 'cyan',
  'hljs-attr': 'cyan',
  'hljs-attribute': 'cyan',
  'hljs-symbol': 'cyan',
  'hljs-variable.language_': 'blue',
  'hljs-params': '#FFFFFF',
  'hljs-property': '#FFFFFF',
  'hljs-selector-tag': 'magenta',
  'hljs-selector-class': 'cyan',
  'hljs-selector-id': 'yellow',
  'hljs-addition': 'green',
  'hljs-deletion': 'red',
  'hljs-subst': 'yellow',
  'hljs-template-variable': 'yellow',
  'hljs-template-expression': 'yellow',
  'default': '#FFFFFF',
};

/**
 * A flat token ready for Ink rendering.
 */
export interface HighlightToken {
  text: string;
  color: string;
  bold?: boolean;
}

/** Per-line highlight tokens. */
export interface HighlightLine {
  tokens: HighlightToken[];
}

/** Parse highlight.js HTML output into an array of tokens. */
export function parseHtmlTokens(html: string, theme?: string): HighlightToken[] {
  const tokens: HighlightToken[] = [];
  const defColor = defaultColor(theme);

  // Match both <span class="...">text</span> and plain text between spans
  const regex = /<span class="([^"]*)">((?:[^<]|<(?!\/span>))*)<\/span>|([^<]+)/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(html)) !== null) {
    if (match[3] !== undefined) {
      // Plain text
      const text = unescapeHtml(match[3]);
      if (text) tokens.push({ text, color: defColor });
    } else {
      // Span with class
      const classNames = match[1];
      const content = unescapeHtml(match[2]);

      if (!content) continue;

      // Resolve color from class names
      const classes = classNames.split(/\s+/);
      const compoundKey = classes.join('.');
      let color = defColor;

      if (COLOR_MAP[compoundKey]) {
        color = COLOR_MAP[compoundKey];
      } else {
        for (let i = classes.length - 1; i >= 0; i--) {
          if (COLOR_MAP[classes[i]]) {
            color = COLOR_MAP[classes[i]];
            break;
          }
        }
      }

      tokens.push({ text: content, color });
    }
  }

  return tokens;
}

/** Decode HTML entities commonly produced by highlight.js. */
function unescapeHtml(str: string): string {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'");
}

/**
 * Highlight source code and return per-line tokens for Ink rendering.
 *
 * @param code  - Raw source code string
 * @param lang  - Language identifier (e.g. "typescript", "python", "rust")
 * @returns Array of lines, each containing an array of colored tokens
 */
export function highlightCode(
  code: string,
  lang: string,
  theme?: string,
): HighlightLine[] {
  // Strip trailing newline for cleaner output
  const cleanCode = code.replace(/\n+$/, '');
  const defColor = defaultColor(theme);

  let html: string;

  try {
    if (lang && hljs.getLanguage(lang)) {
      const result = hljs.highlight(cleanCode, { language: lang });
      html = result.value;
    } else {
      const result = hljs.highlightAuto(cleanCode);
      html = result.value;
    }
  } catch {
    // Highlighting failed — return plain text lines
    return cleanCode.split('\n').map((line) => ({
      tokens: [{ text: line || ' ', color: defColor }],
    }));
  }

  // Split HTML by newlines (highlight.js preserves source line breaks)
  const htmlLines = html.split('\n');
  // Keep original code lines to extract leading whitespace for indentation
  const codeLines = cleanCode.split('\n');

  // Parse each HTML line into tokens, preserving indentation from original code
  return htmlLines.map((htmlLine, i) => {
    // Extract leading whitespace from the corresponding original line
    const origLine = codeLines[i] || '';
    const leadingWs = origLine.match(/^(\s*)/)?.[1] || '';

    const trimmed = htmlLine.trim();
    if (!trimmed) {
      return { tokens: [{ text: ' ', color: defColor }] };
    }

    const tokens = parseHtmlTokens(trimmed, theme);
    // Prepend leading whitespace as a plain token to preserve indentation
    if (leadingWs) {
      tokens.unshift({ text: leadingWs, color: defColor });
    }
    return { tokens };
  });
}
