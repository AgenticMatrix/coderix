import { describe, expect, it } from 'vitest';
import { truncateToTokenLimit, truncateToTokenLimitFromEnd } from '../token-counter.js';

/** True when the string contains an unpaired UTF-16 surrogate. */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * These functions cut by token count, so the cut index is arbitrary with
 * respect to UTF-16 pairs. Their output is injected into prompts for resumed
 * sub-agents and team members; a lone surrogate there escapes as `\udXXX` and
 * a strict upstream rejects the whole request.
 */
describe('truncateToTokenLimit', () => {
  it('returns text that fits unchanged', () => {
    expect(truncateToTokenLimit('中文 😀 ok', 100)).toBe('中文 😀 ok');
  });

  it('never leaves an unpaired surrogate for any budget', () => {
    const s = '😀🎯✅🔥'.repeat(200);
    for (let n = 1; n <= 60; n++) {
      expect(hasLoneSurrogate(truncateToTokenLimit(s, n))).toBe(false);
    }
  });

  it('produces text whose JSON carries no surrogate escape', () => {
    const out = truncateToTokenLimit('截断😀'.repeat(100), 5);
    expect(/\\u[dD][89a-fA-F]/.test(JSON.stringify(out))).toBe(false);
  });

  it('handles maxTokens <= 0', () => {
    expect(truncateToTokenLimit('😀abc', 0)).toBe('');
  });
});

describe('truncateToTokenLimitFromEnd', () => {
  it('keeps the tail without splitting a pair', () => {
    const s = '前缀'.repeat(200) + '😀🎯结尾';
    const out = truncateToTokenLimitFromEnd(s, 10);
    expect(hasLoneSurrogate(out)).toBe(false);
    expect(out.endsWith('结尾')).toBe(true);
  });

  it('never leaves an unpaired surrogate for any budget', () => {
    const s = '😀🎯✅🔥'.repeat(200);
    for (let n = 1; n <= 60; n++) {
      expect(hasLoneSurrogate(truncateToTokenLimitFromEnd(s, n))).toBe(false);
    }
  });

  it('handles maxTokens <= 0', () => {
    expect(truncateToTokenLimitFromEnd('😀abc', 0)).toBe('');
  });
});