import { describe, it, expect } from 'vitest';
import { textWidth } from '@coderix/tui';
import { truncateTokens } from '../diffHighlight.js';
import type { HighlightToken } from '../../../tui/components/highlight.js';

const sum = (tokens: HighlightToken[]) =>
  tokens.reduce((n, t) => n + textWidth(t.text), 0);

describe('truncateTokens', () => {
  it('returns tokens untouched when they already fit', () => {
    const tokens: HighlightToken[] = [
      { text: 'const ', color: '#FFFFFF' },
      { text: 'x', color: 'ansi:magenta' },
    ];
    expect(truncateTokens(tokens, 20)).toBe(tokens);
  });

  it('caps combined width to maxColumns, counting the ellipsis', () => {
    const tokens: HighlightToken[] = [
      { text: 'abcdefghij', color: '#FFFFFF' },
      { text: 'klmnopqrst', color: 'ansi:green' },
    ];
    const out = truncateTokens(tokens, 8);
    expect(sum(out)).toBeLessThanOrEqual(8);
    // Last visible token is the ellipsis marker.
    expect(out[out.length - 1].text).toBe('…');
  });

  it('may cut inside a single token, preserving that token color', () => {
    const tokens: HighlightToken[] = [
      { text: 'verylongidentifier', color: 'ansi:cyan' },
    ];
    const out = truncateTokens(tokens, 6);
    expect(sum(out)).toBeLessThanOrEqual(6);
    expect(out[out.length - 1].text).toBe('…');
    // The retained slice keeps its original color.
    expect(out[0].color).toBe('ansi:cyan');
  });

  it('measures in columns so CJK never overshoots', () => {
    const tokens: HighlightToken[] = [
      { text: '你好世界你好', color: '#FFFFFF' }, // 12 columns, 6 code points
    ];
    const out = truncateTokens(tokens, 7);
    // 7 columns budget → 6 for content + 1 for '…'; '你好世' is 6 columns.
    expect(sum(out)).toBeLessThanOrEqual(7);
    expect(out[out.length - 1].text).toBe('…');
  });

  it('returns an empty list for a non-positive budget', () => {
    expect(truncateTokens([{ text: 'x', color: '#FFFFFF' }], 0)).toEqual([]);
  });
});
