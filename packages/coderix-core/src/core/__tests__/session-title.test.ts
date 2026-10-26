import { describe, it, expect } from 'vitest';
import {
  cleanTitleText,
  truncateTitleUtf8,
  normalizeSessionTitle,
  fallbackSessionTitle,
  isPlaceholderTitle,
  summarizeSessionTitle,
  TITLE_MAX_OUTPUT_TOKENS,
} from '../session-title.js';

describe('session-title text handling', () => {
  it('strips ANSI/OSC sequences, control chars and directional marks', () => {
    const input = '\u001B[31mFix\u001B[0m \u001B]0;title\u0007login \u202Enow\u202C';
    expect(cleanTitleText(input)).toBe('Fix login now');
  });

  it('collapses whitespace and trims', () => {
    expect(cleanTitleText('  a \n\t b   c  ')).toBe('a b c');
  });

  it('never splits a multi-byte code point when truncating', () => {
    expect(truncateTitleUtf8('😀😀😀', 6)).toBe('😀');
  });

  it('keeps CJK titles inside the 40-byte fallback budget', () => {
    const title = fallbackSessionTitle('一二三四五六七八九十一二三四五六七八九十');
    expect(Buffer.byteLength(title, 'utf8')).toBeLessThanOrEqual(40);
    expect(title).toBe('一二三四五六七八九十一二三');
  });

  it('takes the leading five words for English fallbacks', () => {
    expect(fallbackSessionTitle('one two three four five six seven'))
      .toBe('one two three four five');
  });

  it('normalizes a provider title within the 80-byte ceiling', () => {
    const title = normalizeSessionTitle('  登录   鉴权  ');
    expect(title).toBe('登录 鉴权');
    expect(Buffer.byteLength(title, 'utf8')).toBeLessThanOrEqual(80);
  });
});

describe('isPlaceholderTitle', () => {
  it('trusts provider, user and fork sources', () => {
    expect(isPlaceholderTitle('Session deadbeef', 'provider')).toBe(false);
    expect(isPlaceholderTitle('新对话', 'user')).toBe(false);
    expect(isPlaceholderTitle('父会话 (fork)', 'fork')).toBe(false);
  });

  it('marks default and fallback titles as replaceable', () => {
    expect(isPlaceholderTitle('任何标题', 'default')).toBe(true);
    expect(isPlaceholderTitle('任何标题', 'fallback')).toBe(true);
  });

  it('keeps the legacy regex for rows without a source', () => {
    expect(isPlaceholderTitle('Session deadbeef')).toBe(true);
    expect(isPlaceholderTitle('新对话')).toBe(true);
    expect(isPlaceholderTitle('New chat')).toBe(true);
    expect(isPlaceholderTitle('长标题...')).toBe(true);
    expect(isPlaceholderTitle('登录鉴权排查')).toBe(false);
  });
});

describe('summarizeSessionTitle', () => {
  function fakeModel(text: string, inspect?: (params: unknown) => void) {
    return async function* (params: any) {
      inspect?.(params);
      yield {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      };
    } as any;
  }

  it('normalizes model output and uses a short, tool-free request', async () => {
    let seen: any;
    const title = await summarizeSessionTitle(
      fakeModel('  Fix   login  ', (params) => { seen = params; }),
      '请帮我看下登录问题',
    );

    expect(title).toBe('Fix login');
    expect(seen.tools).toEqual([]);
    expect(seen.thinking).toEqual({ type: 'disabled' });
    expect(seen.maxTokens).toBe(TITLE_MAX_OUTPUT_TOKENS);
    expect(seen.system).toContain('concise title');
    expect(seen.messages).toHaveLength(1);
  });

  it('returns null for empty input without calling the model', async () => {
    let called = false;
    const title = await summarizeSessionTitle(
      fakeModel('x', () => { called = true; }),
      '   ',
    );
    expect(title).toBeNull();
    expect(called).toBe(false);
  });

  it('keeps the fallback when the input exceeds the byte budget', async () => {
    let called = false;
    const title = await summarizeSessionTitle(
      fakeModel('x', () => { called = true; }),
      'a'.repeat(5000),
    );
    expect(title).toBeNull();
    expect(called).toBe(false);
  });

  it('returns null when the provider raises', async () => {
    const failing = async function* () {
      throw new Error('provider down');
      // eslint-disable-next-line no-unreachable
      yield { type: 'ping' };
    } as any;
    expect(await summarizeSessionTitle(failing, '登录问题')).toBeNull();
  });

  it('reads a full AssistantMessage when the adapter does not stream deltas', async () => {
    const direct = async function* () {
      yield {
        role: 'assistant',
        content: '直接返回的标题',
        stopReason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
        model: 'test',
        toolUseBlocks: [],
      } as any;
    } as any;
    expect(await summarizeSessionTitle(direct, '登录问题')).toBe('直接返回的标题');
  });

  it('returns null when the request times out', async () => {
    const hanging = async function* (params: any) {
      await new Promise((_, reject) => {
        params.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      yield { type: 'ping' };
    } as any;
    expect(await summarizeSessionTitle(hanging, '登录问题', { timeoutMs: 20 })).toBeNull();
  });
});
