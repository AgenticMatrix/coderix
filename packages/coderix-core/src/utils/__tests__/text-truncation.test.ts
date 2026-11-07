import { describe, it, expect } from 'vitest';
import {
  toWellFormed,
  truncateSafely,
  truncateMiddle,
  normaliseSurrogates,
  stringifyForWire,
} from '../../utils/text-truncation.js';

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

/** What JSON.stringify would put on the wire for a lone surrogate. */
function hasSurrogateEscape(json: string): boolean {
  return /\\u[dD][89a-fA-F][0-9a-fA-F]{2}/.test(json);
}

describe('toWellFormed', () => {
  it('leaves well-formed text untouched', () => {
    const s = '中文 😀 表情 🎯';
    expect(toWellFormed(s)).toBe(s);
  });

  it('replaces an unpaired high surrogate', () => {
    expect(toWellFormed('ab\uD83D')).toBe('ab\uFFFD');
  });

  it('replaces an unpaired low surrogate', () => {
    expect(toWellFormed('\uDE00ab')).toBe('\uFFFDab');
  });

  it('keeps valid surrogate pairs', () => {
    const s = 'a😀b';
    expect(toWellFormed(s)).toBe(s);
  });

  it('produces text whose JSON is accepted (no \\udXXX escapes)', () => {
    const broken = '输出：\uD83D';
    expect(hasLoneSurrogate(broken)).toBe(true);
    expect(hasSurrogateEscape(JSON.stringify(broken))).toBe(true);

    const fixed = toWellFormed(broken);
    expect(hasLoneSurrogate(fixed)).toBe(false);
    expect(hasSurrogateEscape(JSON.stringify(fixed))).toBe(false);
  });
});

describe('truncateSafely', () => {
  it('returns short strings unchanged', () => {
    expect(truncateSafely('abc', 10)).toBe('abc');
  });

  it('never splits an emoji across the cut', () => {
    // '中😀' — the emoji occupies indices 1..2, so cutting at 2 would split it.
    const s = '中😀尾部';
    const cut = truncateSafely(s, 2);
    expect(hasLoneSurrogate(cut)).toBe(false);
    expect(cut).toBe('中');
  });

  it('keeps the full pair when the cut lands after it', () => {
    expect(truncateSafely('中😀尾部', 3)).toBe('中😀');
  });

  it('is stable for every cut point in an emoji-dense string', () => {
    const s = '😀🎯✅🔥'.repeat(50);
    for (let n = 1; n <= 40; n++) {
      expect(hasLoneSurrogate(truncateSafely(s, n))).toBe(false);
    }
  });

  it('handles maxLength <= 0', () => {
    expect(truncateSafely('😀abc', 0)).toBe('');
    expect(truncateSafely('😀abc', -1)).toBe('');
  });
});

describe('truncateMiddle', () => {
  const marker = '\n…[truncated]…\n';

  it('keeps both ends without splitting a pair', () => {
    const s = '😀'.repeat(100) + 'middle' + '🎯'.repeat(100);
    const out = truncateMiddle(s, 30, 30, marker);
    expect(hasLoneSurrogate(out)).toBe(false);
    expect(out).toContain(marker);
  });

  it('never produces a lone surrogate for any head/tail combination', () => {
    const s = 'a😀b🎯c🔥'.repeat(40);
    for (let head = 1; head <= 24; head++) {
      for (const tail of [1, 3, 8, 15]) {
        const out = truncateMiddle(s, head, tail, marker);
        expect(hasLoneSurrogate(out)).toBe(false);
      }
    }
  });

  it('returns the original when it fits', () => {
    expect(truncateMiddle('short', 10, 10, marker)).toBe('short');
  });

  it('supports tail-only truncation (headLength 0)', () => {
    const out = truncateMiddle('😀'.repeat(20), 0, 7, '');
    expect(hasLoneSurrogate(out)).toBe(false);
    expect(out.length).toBeLessThanOrEqual(7);
  });
});
describe('stringifyForWire', () => {
  it('matches JSON.stringify exactly when the body is clean', () => {
    const body = { model: 'm', messages: [{ role: 'user', content: '中文 😀 ok' }] };
    expect(stringifyForWire(body)).toBe(JSON.stringify(body));
  });

  it('removes lone-surrogate escapes from the serialized wire body', () => {
    const broken = { messages: [{ content: '截断'.concat('\uD83D') }] };
    expect(/\\u[dD][89a-fA-F]/.test(JSON.stringify(broken))).toBe(true);

    const wire = stringifyForWire(broken);
    expect(/\\u[dD][89a-fA-F]/.test(wire)).toBe(false);
    expect(() => JSON.parse(wire)).not.toThrow();
    expect(JSON.parse(wire).messages[0].content).toBe('截断\uFFFD');
  });

  it('keeps valid pairs untouched', () => {
    const body = { s: 'a😀b🎯c' };
    const wire = stringifyForWire(body);
    expect(wire).toBe(JSON.stringify(body));
    expect(JSON.parse(wire).s).toBe('a😀b🎯c');
  });
});

describe('normaliseSurrogates', () => {
  it('repairs nested arrays, objects and keys', () => {
    const out = normaliseSurrogates({
      ['k\uD83D']: [{ t: 'x\uDE00y' }],
    });
    expect(hasLoneSurrogate(Object.keys(out)[0]!)).toBe(false);
    expect(hasLoneSurrogate(out[Object.keys(out)[0]! as keyof typeof out][0]!.t)).toBe(false);
  });

  it('leaves non-string primitives and null untouched', () => {
    expect(normaliseSurrogates({ n: 1, b: true, z: null })).toEqual({ n: 1, b: true, z: null });
  });
});
