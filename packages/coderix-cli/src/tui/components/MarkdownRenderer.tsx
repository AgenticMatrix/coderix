import React, { useState, useEffect } from 'react';
import { Box, Text, useStdout } from 'ink';

import { renderLatex } from './latex-to-unicode.js';
import { highlightCode } from './highlight.js';

// ─── Token types ───────────────────────────────────────────────────────────

type InlineToken =
  | { type: 'text'; content: string }
  | { type: 'bold'; content: string }
  | { type: 'italic'; content: string }
  | { type: 'strikethrough'; content: string }
  | { type: 'code'; content: string }
  | { type: 'math'; content: string }
  | { type: 'link'; content: string; url: string };

type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; tokens: InlineToken[] }
  | { type: 'code_block'; language: string; code: string }
  | { type: 'math_block'; content: string }
  | { type: 'list_item'; tokens: InlineToken[] }
  | { type: 'horizontal_rule' }
  | { type: 'table'; headers: string[]; alignments: ('left' | 'center' | 'right')[]; rows: string[][] }
  | { type: 'blockquote'; lines: { level: number; tokens: InlineToken[] }[] };

// ─── Inline parser ─────────────────────────────────────────────────────────

/**
 * Parse a single line of text into inline tokens.
 * Handles: **bold**, *italic*, `code`, $math$, and plain text.
 */
function parseInline(line: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  const regex =
    /(`[^`]+`)|(\$\$[^$]+\$\$)|(\$[^$]+\$)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(~~[^~]+~~)|(\[([^\]]+)\]\(([^)]+)\))|([^`$*~[]+)/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(line)) !== null) {
    const [full] = match;

    if (match[1]) {
      tokens.push({ type: 'code', content: full.slice(1, -1) });
    } else if (match[2]) {
      tokens.push({ type: 'math', content: full.slice(2, -2) });
    } else if (match[3]) {
      tokens.push({ type: 'math', content: full.slice(1, -1) });
    } else if (match[4]) {
      tokens.push({ type: 'bold', content: full.slice(2, -2) });
    } else if (match[5]) {
      tokens.push({ type: 'italic', content: full.slice(1, -1) });
    } else if (match[6]) {
      tokens.push({ type: 'strikethrough', content: full.slice(2, -2) });
    } else if (match[7]) {
      tokens.push({ type: 'link', content: match[8]!, url: match[9]! });
    } else if (match[10]) {
      tokens.push({ type: 'text', content: full });
    }
  }

  return tokens;
}

/**
 * Try to parse a group of lines as a markdown table.
 * Returns a table block if the lines form a valid table, or null otherwise.
 *
 * Recognizes:
 *   | Header 1 | Header 2 |
 *   |----------|----------|
 *   | Cell 1   | Cell 2   |
 *
 * With optional alignment indicators: :--- (left), :---: (center), ---: (right)
 */
function detectAndParseTable(lines: string[]): Block | null {
  if (lines.length < 2) return null;

  // All lines in the group must contain a pipe to be considered a table
  if (!lines.every((l) => l.includes('|'))) return null;

  // Second line must be a separator row
  if (!isTableSeparator(lines[1])) return null;

  // Parse header
  const headers = splitTableCells(lines[0]);

  // Parse alignments from separator
  const alignments = parseTableAlignments(lines[1]);

  // Normalize column count
  const colCount = headers.length;

  // Parse data rows
  const rows: string[][] = [];
  for (let i = 2; i < lines.length; i++) {
    const cells = splitTableCells(lines[i]);
    // Pad missing columns with empty strings, trim extra columns
    while (cells.length < colCount) cells.push('');
    rows.push(cells.slice(0, colCount));
  }

  return { type: 'table', headers, alignments, rows };
}

/** Check if a line is a table separator row (e.g. |---|---| or |:---:|) */
function isTableSeparator(line: string): boolean {
  const cells = splitTableCells(line);
  if (cells.length === 0) return false;
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

/** Parse alignment indicators from a separator row. */
function parseTableAlignments(line: string): ('left' | 'center' | 'right')[] {
  return splitTableCells(line).map((cell) => {
    const trimmed = cell.trim();
    const left = trimmed.startsWith(':');
    const right = trimmed.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return 'left';
  });
}

/** Split a table row into cell strings, stripping leading/trailing pipes and whitespace. */
function splitTableCells(line: string): string[] {
  let trimmed = line.trim();
  // Strip leading pipe
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  // Strip trailing pipe
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  // Split on remaining pipes
  return trimmed.split('|').map((c) => c.trim());
}

/** Get the visible display width of a string for terminal column alignment.
 *  Follows wcwidth conventions: CJK, emoji, fullwidth chars = 2, ASCII = 1. */
function displayWidth(str: string): number {
  let width = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0) ?? 0;
    // Zero-width characters — do not advance cursor
    if (
      (cp >= 0x0300 && cp <= 0x036F) ||  // Combining Diacritical Marks
      (cp >= 0x0483 && cp <= 0x0489) ||  // Cyrillic Combining
      (cp >= 0x0591 && cp <= 0x05BD) ||  // Hebrew Combining
      cp === 0x05BF ||
      (cp >= 0x05C1 && cp <= 0x05C2) ||
      (cp >= 0x05C4 && cp <= 0x05C5) ||
      cp === 0x05C7 ||
      cp === 0x0610 || cp === 0x061A ||
      (cp >= 0x064B && cp <= 0x065F) ||  // Arabic Combining
      cp === 0x0670 ||
      (cp >= 0x06D6 && cp <= 0x06DC) ||
      (cp >= 0x06DF && cp <= 0x06E4) ||
      (cp >= 0x06E7 && cp <= 0x06E8) ||
      (cp >= 0x06EA && cp <= 0x06ED) ||
      cp === 0x0711 ||
      (cp >= 0x0730 && cp <= 0x074A) ||
      (cp >= 0x07A6 && cp <= 0x07B0) ||
      (cp >= 0x0900 && cp <= 0x0902) ||  // Devanagari
      cp === 0x093A || cp === 0x093C ||
      (cp >= 0x0941 && cp <= 0x0948) ||
      cp === 0x094D ||
      (cp >= 0x0E31 && cp <= 0x0E3A) ||  // Thai
      (cp >= 0x0E47 && cp <= 0x0E4E) ||
      cp === 0x200B ||  // Zero Width Space
      cp === 0x200C ||  // Zero Width Non-Joiner
      cp === 0x200D ||  // Zero Width Joiner
      (cp >= 0x200E && cp <= 0x200F) ||  // LRM / RLM
      (cp >= 0x2028 && cp <= 0x202E) ||  // Line/Paragraph Separator, LRE/RLE/PDF/LRO/RLO
      cp === 0x2060 ||  // Word Joiner
      (cp >= 0xFE00 && cp <= 0xFE0F) ||  // Variation Selectors 1-16
      cp === 0xFEFF     // BOM / ZWNBSP
    ) continue;
    // Wide characters (terminal renders as 2 columns)
    if (
      (cp >= 0x1100 && cp <= 0x115F) ||  // Hangul Jamo
      (cp >= 0x231A && cp <= 0x23FF) ||  // Misc Technical (⌚⌛⏳⏰ etc.)
      (cp >= 0x2600 && cp <= 0x27BF) ||  // Misc Symbols, Dingbats (emoji ✅✔️❌⭐ etc.)
      (cp >= 0x2E80 && cp <= 0xA4CF) ||  // CJK Radicals → Yi
      cp === 0xA960 || cp === 0xA961 ||   // Hangul Jamo Extended
      cp === 0xA963 || cp === 0xA96C ||
      (cp >= 0xAC00 && cp <= 0xD7A3) ||  // Hangul Syllables
      (cp >= 0xF900 && cp <= 0xFAFF) ||  // CJK Compat
      (cp >= 0xFE10 && cp <= 0xFE19) ||  // Vertical Forms
      (cp >= 0xFE30 && cp <= 0xFE6F) ||  // CJK Compat Forms
      (cp >= 0xFF01 && cp <= 0xFF60) ||  // Fullwidth Latin
      (cp >= 0xFFE0 && cp <= 0xFFE6) ||  // Fullwidth Signs
      (cp >= 0x1F000 && cp <= 0x1F9FF) || // Emoji & Symbols range
      (cp >= 0x1FA00 && cp <= 0x1FAFF) || // Chess Symbols, etc.
      (cp >= 0x20000 && cp <= 0x2FFFD) || // CJK Ext B+
      (cp >= 0x30000 && cp <= 0x3FFFD)    // CJK Ext G+
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

/** Pad a string to a target display width (right-pad for left-aligned). */
function padToWidth(str: string, targetWidth: number, align: 'left' | 'center' | 'right'): string {
  const dw = displayWidth(str);
  if (dw >= targetWidth) return str;
  const diff = targetWidth - dw;

  if (align === 'right') return ' '.repeat(diff) + str;
  if (align === 'center') {
    const leftPad = Math.floor(diff / 2);
    const rightPad = diff - leftPad;
    return ' '.repeat(leftPad) + str + ' '.repeat(rightPad);
  }
  return str + ' '.repeat(diff);
}
// ─── Block parser ──────────────────────────────────────────────────────────

/**
 * Split raw markdown text into blocks.
 *
 * Strategy:
 * 1. Split on ``` fences to extract code blocks
 * 2. Split remaining text on blank lines to get paragraphs
 * 3. Detect tables, headings, lists, math blocks within paragraphs
 * 4. Parse inline formatting
 */
function parseBlocks(raw: string): Block[] {
  if (!raw?.trim()) return [];

  const blocks: Block[] = [];

  // Step 1: Split into segments alternating text / code
  // Only detect fences at line start to avoid splitting tables
  const segments = splitByLineStartFence(raw, '```');
  let inCodeBlock = false;

  // Step 1b: Also handle $$ math blocks
  const allSegments: { type: 'text' | 'code' | 'math_block'; content: string; lang?: string }[] = [];

  for (const seg of segments) {
    if (inCodeBlock) {
      const newlineIdx = seg.indexOf('\n');
      const lang = newlineIdx > 0 ? seg.slice(0, newlineIdx).trim() : '';
      const code = newlineIdx > 0 ? seg.slice(newlineIdx + 1) : seg;
      allSegments.push({ type: 'code', content: code, lang });
      inCodeBlock = false;
    } else {
      // Split this text segment by $$ fences for math blocks
      const mathSegs = splitByLineStartFence(seg, '$$');
      let inMathBlock = false;
      for (const mseg of mathSegs) {
        if (inMathBlock) {
          allSegments.push({ type: 'math_block', content: mseg.trim() });
          inMathBlock = false;
        } else {
          allSegments.push({ type: 'text', content: mseg });
          inMathBlock = true;
        }
      }
      // Only toggle if we actually had a $$ fence
      if (mathSegs.length % 2 === 0) inMathBlock = !inMathBlock;
      inCodeBlock = true;
    }
  }

  // Step 2: Parse text segments into paragraphs/headings/lists
  for (const seg of allSegments) {
    if (seg.type === 'code') {
      blocks.push({ type: 'code_block', language: seg.lang ?? '', code: seg.content });
      continue;
    }
    if (seg.type === 'math_block') {
      blocks.push({ type: 'math_block', content: seg.content });
      continue;
    }

    // Split text by blank lines
    const paragraphs = seg.content.split(/\n{2,}/).filter((p) => p.trim());
    for (const para of paragraphs) {
      const lines = para.split('\n').filter((l) => l.trim());

      // Try to detect and parse a table first (2+ lines with pipes & separator)
      const tableBlock = detectAndParseTable(lines);
      if (tableBlock) {
        blocks.push(tableBlock);
        continue;
      }

      // Blockquote: lines starting with >
      if (lines.every((l) => /^>+\s/.test(l))) {
        blocks.push({
          type: 'blockquote',
          lines: lines.map((l) => {
            const match = l.match(/^(>+)\s?(.*)/);
            const level = match?.[1]?.length ?? 1;
            const content = match?.[2] ?? '';
            return { level, tokens: parseInline(content) };
          }),
        });
        continue;
      }

      for (const line of lines) {
        const trimmed = line.trim();

        // Horizontal rule: ---, ***, ___ (3+ of the same char, optional spaces)
        if (/^[-*_]{3,}\s*$/.test(trimmed)) {
          blocks.push({ type: 'horizontal_rule' });
          continue;
        }

        // Heading: #, ##, ###, etc.
        const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)/);
        if (headingMatch) {
          blocks.push({
            type: 'heading',
            level: headingMatch[1].length,
            text: headingMatch[2],
          });
          continue;
        }

        // Unordered list: - item or * item
        const listMatch = trimmed.match(/^[-*]\s+(.+)/);
        if (listMatch) {
          blocks.push({
            type: 'list_item',
            tokens: parseInline(listMatch[1]),
          });
          continue;
        }

        // Regular paragraph line
        blocks.push({
          type: 'paragraph',
          tokens: parseInline(trimmed),
        });
      }
    }
  }

  return blocks;
}

/**
 * Split text by a fence delimiter (``` or $$).
 * Returns alternating [normal, fenced, normal, fenced, ...] segments.
 */
/** Split text by a fence that must appear at the start of a line (with optional whitespace).
 *  Used for ``` code fences and $$ math blocks to avoid splitting inside table cells. */
function splitByLineStartFence(text: string, fence: string): string[] {
  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    const re = new RegExp(`^\\s*${escapeRegex(fence)}`, 'm');
    const match = re.exec(remaining);
    if (!match) {
      parts.push(remaining);
      break;
    }
    const idx = match.index;
    parts.push(remaining.slice(0, idx));
    remaining = remaining.slice(idx + match[0].length);
    const nextMatch = re.exec(remaining);
    if (!nextMatch) {
      parts.push(remaining);
      break;
    }
    const nextIdx = nextMatch.index;
    parts.push(remaining.slice(0, nextIdx));
    remaining = remaining.slice(nextIdx + nextMatch[0].length);
  }

  return parts;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Word-wrap helpers ─────────────────────────────────────────────────────

/** Split text into word segments, keeping trailing whitespace with each word. */
function splitIntoWords(text: string): string[] {
  const parts = text.split(/(?<=\s)/);
  return parts.length > 0 ? parts : [text];
}

/** Compute the display width of an inline token. */
function tokenWidth(token: InlineToken): number {
  if (token.type === 'link') return displayWidth(token.content) + displayWidth(token.url) + 3; // " (url)"
  return displayWidth(token.content);
}

/**
 * Word-wrap inline tokens to fit within maxWidth.
 * Returns arrays of tokens, each representing one wrapped line.
 */
function wordWrapTokens(tokens: InlineToken[], maxWidth: number): InlineToken[][] {
  const lines: InlineToken[][] = [];
  let curLine: InlineToken[] = [];
  let curWidth = 0;

  function flushLine() {
    if (curLine.length > 0) {
      lines.push(curLine);
      curLine = [];
      curWidth = 0;
    }
  }

  for (const token of tokens) {
    if (token.type === 'text') {
      const segments = splitIntoWords(token.content);
      for (const seg of segments) {
        const segWidth = displayWidth(seg);
        if (curWidth === 0 || curWidth + segWidth <= maxWidth) {
          const last = curLine[curLine.length - 1];
          if (last && last.type === 'text') {
            last.content += seg;
          } else {
            curLine.push({ type: 'text', content: seg });
          }
          curWidth += segWidth;
        } else {
          flushLine();
          const trimmed = seg.replace(/^\s+/, '');
          if (trimmed) {
            curLine.push({ type: 'text', content: trimmed });
            curWidth = displayWidth(trimmed);
          }
        }
      }
    } else {
      const tw = tokenWidth(token);
      if (curWidth === 0 || curWidth + tw <= maxWidth) {
        curLine.push(token);
        curWidth += tw;
      } else {
        flushLine();
        curLine.push(token);
        curWidth = tw;
      }
    }
  }

  flushLine();
  return lines.length > 0 ? lines : [[]];
}

// ─── Inline renderer ───────────────────────────────────────────────────────

/**
 * Render a single inline token as an Ink <Text> element.
 */
function InlineTokenElement({ token }: { token: InlineToken }) {
  const { type, content } = token;

  if (type === 'code') {
    return <Text>{content}</Text>;
  }

  if (type === 'math') {
    return (
      <Text italic color="cyan">
        {renderLatex(content)}
      </Text>
    );
  }

  if (type === 'bold') {
    return <Text bold>{content}</Text>;
  }

  if (type === 'italic') {
    return <Text italic>{content}</Text>;
  }

  if (type === 'strikethrough') {
    return <Text strikethrough>{content}</Text>;
  }

  if (type === 'link') {
    return (
      <Text dimColor>
        {content}
        {' '}
        <Text dimColor>({token.url})</Text>
      </Text>
    );
  }

  return <Text>{content}</Text>;
}


/**
 * Render an array of inline tokens as a single line.
 */
function InlineLine({ tokens }: { tokens: InlineToken[] }) {
  return (
    <Text>
      {tokens.map((token, i) => (
        <InlineTokenElement key={i} token={token} />
      ))}
    </Text>
  );
}

// ─── Block renderer ────────────────────────────────────────────────────────

/**
 * Render a single block.
 */
function BlockElement({ block, termWidth, theme, textColor }: { block: Block; termWidth: number; theme?: string; textColor: string }) {
  switch (block.type) {
    case 'heading':
      return (
        <Box marginY={block.level === 1 ? 1 : 0}>
          <Text bold>
            {block.text}
          </Text>
        </Box>
      );

    case 'paragraph': {
      const lines = wordWrapTokens(block.tokens, termWidth);
      return (
        <Box flexDirection="column" width={termWidth}>
          {lines.map((lineTokens, i) => (
            <InlineLine key={i} tokens={lineTokens} />
          ))}
        </Box>
      );
    }

    case 'code_block': {
      const highlighted = highlightCode(block.code, block.language, theme);
      return (
        <Box
          flexDirection="column"
          marginY={1}
          paddingX={2}
          paddingY={1}
          borderStyle="single"
          borderColor="grey"
        >
          {block.language ? (
            <Text dimColor color="yellow">
              {block.language}
            </Text>
          ) : null}
          {highlighted.map((line, i) => (
            <Text key={i}>
              {line.tokens.map((t, j) => (
                <Text key={j} color={t.color}>
                  {t.text}
                </Text>
              ))}
            </Text>
          ))}
        </Box>
      );
    }

    case 'math_block': {
      // Render the entire block through LaTeX→Unicode, then split lines
      const rendered = renderLatex(block.content);
      const lines = rendered.split('\n');
      return (
        <Box
          marginY={1}
          paddingX={2}
          paddingY={1}
          borderStyle="round"
          borderColor="cyan"
          flexDirection="column"
        >
          {lines.map((line, i) => (
            <Text key={i} italic color="cyan">
              {line || ' '}
            </Text>
          ))}
        </Box>
      );
    }

    case 'list_item': {
      const bulletWidth = 4;
      const lines = wordWrapTokens(block.tokens, termWidth - bulletWidth);
      return (
        <Box marginLeft={2} flexDirection="column">
          {lines.map((lineTokens, i) => (
            <Text key={i}>
              <Text>{i === 0 ? '  • ' : '    '}</Text>
              <InlineLine tokens={lineTokens} />
            </Text>
          ))}
        </Box>
      );
    }

    case 'horizontal_rule':
      return (
        <Box marginY={1}>
          <Text dimColor color="grey">
            {'─'.repeat(40)}
          </Text>
        </Box>
      );

    case 'table': {
      const { headers, alignments, rows } = block;
      const allRows = [headers, ...rows];
      const colCount = headers.length;

      // Calculate natural column widths based on max content width per column
      const naturalWidths: number[] = Array.from({ length: colCount }, (_, ci) =>
        Math.max(...allRows.map((r) => displayWidth(r[ci] || ''))),
      );

      const pad = 1;
      const naturalInnerWidths = naturalWidths.map((w) => w + pad * 2);
      const naturalTotal = naturalInnerWidths.reduce((a, b) => a + b, 0) + colCount + 1;

      const maxWidth = Math.max(20, termWidth);

      // Scale down if the table is wider than the terminal
      let colWidths = naturalWidths;
      if (naturalTotal > maxWidth) {
        const borderOverhead = colCount * 3 + 1;
        const available = maxWidth - borderOverhead;
        const totalNatural = naturalWidths.reduce((a, b) => a + b, 0);
        // Shrink min column width when there are too many columns to fit at 3
        const minColWidth = Math.min(3, Math.max(2, Math.floor(available / colCount)));
        colWidths = naturalWidths.map((w) =>
          Math.max(minColWidth, Math.floor((w / totalNatural) * available)),
        );
        // Correct overflow caused by Math.max clamping small columns up to minColWidth
        let allocated = colWidths.reduce((a, b) => a + b, 0);
        if (allocated > available) {
          const byWidth = colWidths
            .map((w, i) => ({ w, i }))
            .sort((a, b) => b.w - a.w);
          for (const item of byWidth) {
            if (allocated <= available) break;
            const reduce = Math.min(item.w - minColWidth, allocated - available);
            colWidths[item.i] -= reduce;
            allocated -= reduce;
          }
        }
      }

      const innerWidths = colWidths.map((w) => w + pad * 2);

      // Border helpers
      const topBorder = '┌' + innerWidths.map((w) => '─'.repeat(w)).join('┬') + '┐';
      const sepBorder = '├' + innerWidths.map((w) => '─'.repeat(w)).join('┼') + '┤';
      const botBorder = '└' + innerWidths.map((w) => '─'.repeat(w)).join('┴') + '┘';

      // Wrap cell text to fit a given display width
      const wrapCell = (text: string, width: number): string[] => {
        const lines: string[] = [];
        let cur = '';
        let curW = 0;
        for (const ch of text) {
          const chW = displayWidth(ch);
          if (curW + chW > width && cur.length > 0) {
            lines.push(cur);
            cur = ch;
            curW = chW;
          } else {
            cur += ch;
            curW += chW;
          }
        }
        if (cur.length > 0) lines.push(cur);
        return lines.length > 0 ? lines : [''];
      };

      // Render a row into an array of lines (multi-line if any cell wraps)
      const renderRowLines = (cells: string[]): string[][] => {
        const wrapped = cells.map((cell, ci) => wrapCell(cell, colWidths[ci]!));
        const maxLines = Math.max(...wrapped.map((w) => w.length), 1);
        const result: string[][] = [];
        for (let li = 0; li < maxLines; li++) {
          const lineCells = cells.map((_, ci) => {
            const line = wrapped[ci]?.[li] ?? '';
            return padToWidth(` ${line} `, innerWidths[ci]!, alignments[ci] || 'left');
          });
          result.push(lineCells);
        }
        return result;
      };

      const headerLines = renderRowLines(headers);
      const rowLines = rows.map((row) => renderRowLines(row));

      return (
        <Box flexDirection="column" marginY={1}>
          <Text color="grey">{topBorder}</Text>
          {headerLines.map((cells, li) => (
            <Box key={`h${li}`} flexDirection="row">
              <Text color="grey">│</Text>
              {cells.map((cell, ci) => (
                <React.Fragment key={ci}>
                  <Box width={innerWidths[ci]!} justifyContent={alignments[ci] === 'center' ? 'center' : alignments[ci] === 'right' ? 'flex-end' : 'flex-start'}>
                    <Text bold color={textColor}>
                      <InlineLine tokens={parseInline(cell.trim())} />
                    </Text>
                  </Box>
                  <Text color="grey">│</Text>
                </React.Fragment>
              ))}
            </Box>
          ))}
          <Text color="grey">{sepBorder}</Text>
          {rowLines.map((lines, ri) =>
            lines.map((cells, li) => (
              <Box key={`${ri}-${li}`} flexDirection="row">
                <Text color="grey">│</Text>
                {cells.map((cell, ci) => (
                  <React.Fragment key={ci}>
                    <Box width={innerWidths[ci]!} justifyContent={alignments[ci] === 'center' ? 'center' : alignments[ci] === 'right' ? 'flex-end' : 'flex-start'}>
                      <Text color={textColor}>
                        <InlineLine tokens={parseInline(cell.trim())} />
                      </Text>
                    </Box>
                    <Text color="grey">│</Text>
                  </React.Fragment>
                ))}
              </Box>
            )),
          )}
          <Text color="grey">{botBorder}</Text>
        </Box>
      );
    }

    case 'blockquote': {
      const quoteColors = ['grey', 'yellow', 'magenta'];
      return (
        <Box flexDirection="column" marginY={1}>
          {block.lines.map((ql, li) => {
            const prefixWidth = ql.level * 2;
            const lines = wordWrapTokens(ql.tokens, termWidth - prefixWidth);
            const prefix = Array.from({ length: ql.level }, (_, i) => (
              <Text key={i} color={quoteColors[Math.min(i, quoteColors.length - 1)]}>
                │{' '}
              </Text>
            ));
            return lines.map((lineTokens, wi) => (
              <Box key={`${li}-${wi}`}>
                <Text dimColor>{prefix}</Text>
                <InlineLine tokens={lineTokens} />
              </Box>
            ));
          })}
        </Box>
      );
    }

    default:
      return null;
  }
}

// ─── Public component ──────────────────────────────────────────────────────

interface MarkdownRendererProps {
  content: string;
  theme?: string;
}

/**
 * Render markdown text as Ink components.
 *
 * Supports:
 * - Headings (#, ##, ###)
 * - Bold (**text**) and italic (*text*)
 * - Inline code (`code`) with background
 * - Fenced code blocks (```lang ... ```) with border
 * - Inline math ($formula$) in cyan italic
 * - Display math blocks ($$...$$) with rounded border
 * - Unordered lists (- item or * item)
 * - Horizontal rules (---, ***, ___)
 * - Tables (| Header | ... | with alignment)
 * - Blockquotes (> text, with nesting support)
 * - Paragraphs
 */
export function MarkdownRenderer({ content, theme }: MarkdownRendererProps) {
  const { stdout } = useStdout();
  const [termWidth, setTermWidth] = useState(
    () => stdout?.columns ?? process.stdout.columns ?? 80,
  );

  useEffect(() => {
    const cols = stdout?.columns;
    if (cols && cols !== termWidth) {
      setTermWidth(cols);
    }
  }, [stdout?.columns]);

  const blocks = parseBlocks(content);

  if (blocks.length === 0) {
    return null;
  }

  // Buffer for accumulated parent padding: App(paddingX=1) + ChatView(paddingX=1)
  // + MessageBubble(paddingLeft=3) + terminal right margin(1) ≈ 6, use 8 for safety.
  const maxOutputWidth = Math.max(20, termWidth - 8);
  const textColor = theme === 'light' ? '#000000' : '#FFFFFF';

  return (
    <Box flexDirection="column" width={maxOutputWidth}>
      {blocks.map((block, i) => (
        <BlockElement key={i} block={block} termWidth={maxOutputWidth} theme={theme} textColor={textColor} />
      ))}
    </Box>
  );
}
