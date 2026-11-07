import { describe, expect, it } from 'vitest';
import { normaliseSurrogates } from '../protocol-gateway/shared.js';

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

describe('normaliseSurrogates', () => {
  it('leaves ordinary text alone', () => {
    const body = { model: 'm', messages: [{ role: 'user', content: '中文 😀 ok' }] };
    expect(normaliseSurrogates(body)).toEqual(body);
  });

  it('rewrites a lone surrogate nested in the body', () => {
    const body = {
      messages: [
        { role: 'user', content: [{ type: 'tool_result', content: '输出：\uD83D' }] },
      ],
    };
    const out = normaliseSurrogates(body);
    const text = out.messages[0]!.content[0]!.content;
    expect(hasLoneSurrogate(text)).toBe(false);
    expect(text).toBe('输出：\uFFFD');
  });

  it('repairs an unpaired surrogate in an object key', () => {
    const out = normaliseSurrogates({ ['a\uD83Db']: 1 });
    const key = Object.keys(out)[0]!;
    expect(hasLoneSurrogate(key)).toBe(false);
  });

  it('keeps valid pairs intact and does not clone primitives', () => {
    const out = normaliseSurrogates({ s: 'a😀b', n: 3, ok: true, nil: null });
    expect(out).toEqual({ s: 'a😀b', n: 3, ok: true, nil: null });
  });

  it('makes the serialized body safe for strict JSON parsers', () => {
    const broken = { messages: [{ content: '截断😀'.slice(0, 3) }] };
    expect(hasLoneSurrogate(broken.messages[0]!.content)).toBe(true);
    // A lone surrogate escapes as \udXXX, which is what upstreams reject.
    expect(/\\ud83d/i.test(JSON.stringify(broken))).toBe(true);

    const fixed = normaliseSurrogates(broken);
    expect(/\\u[dD][89a-fA-F]/.test(JSON.stringify(fixed))).toBe(false);
    // Restored through a real JSON round-trip, as the upstream would do.
    expect(() => JSON.parse(JSON.stringify(fixed))).not.toThrow();
  });
});