import { describe, expect, it, vi } from 'vitest';
import {
  withStreamRetry,
  resolveRetryConfig,
  computeRetryDelay,
} from '../retry-stream.js';
import type { AssistantMessage, StreamEvent } from '../types.js';

/** Collect a whole generator, surfacing the thrown error to the caller. */
async function drain(gen: AsyncGenerator<StreamEvent | AssistantMessage>) {
  const events: Array<StreamEvent | AssistantMessage> = [];
  try {
    for await (const e of gen) events.push(e);
    return { events, error: null as Error | null };
  } catch (err) {
    return { events, error: err as Error };
  }
}

const delta = (text: string): StreamEvent => ({
  type: 'content_block_delta',
  index: 0,
  delta: { type: 'text_delta', text },
});

const messageStart = (): StreamEvent => ({
  type: 'message_start',
  message: { model: 'm' },
});

/** A generator that throws `error` at position `failAt` (0 = immediately). */
async function* failingAfter(
  events: StreamEvent[],
  error: Error,
  failAt: number,
): AsyncGenerator<StreamEvent> {
  for (let i = 0; i < failAt; i++) yield events[i]!;
  throw error;
}

async function* succeeding(events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const e of events) yield e;
}

describe('withStreamRetry', () => {
  it('retries a rate-limit failure that produced no output', async () => {
    const onRetry = vi.fn();
    let calls = 0;
    const gen = withStreamRetry(
      () => (++calls === 1 ? failingAfter([], new Error('429 rate limit'), 0) : succeeding([delta('ok')])),
      { maxRetries: 3, baseDelayMs: 0, onRetry },
    );

    const { events, error } = await drain(gen);

    expect(error).toBeNull();
    expect(events).toHaveLength(1);
    expect(calls).toBe(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]![0]).toBe(1); // attempt is 1-based
  });

  it('does NOT retry a 400 invalid request', async () => {
    let calls = 0;
    const gen = withStreamRetry(
      () => { calls++; return failingAfter([], new Error('400 bad request: invalid'), 0); },
      { maxRetries: 3, baseDelayMs: 0 },
    );

    const { error } = await drain(gen);

    expect(error?.message).toContain('400');
    expect(calls).toBe(1);
  });

  it('does NOT retry after a content delta was emitted', async () => {
    let calls = 0;
    const gen = withStreamRetry(
      () => { calls++; return failingAfter([delta('half')], new Error('503 server error'), 1); },
      { maxRetries: 3, baseDelayMs: 0 },
    );

    const { events, error } = await drain(gen);

    expect(calls).toBe(1);
    expect(events).toHaveLength(1);
    expect(error?.message).toContain('503');
  });

  it('retries after message_start alone (it carries no content)', async () => {
    let calls = 0;
    const gen = withStreamRetry(
      () => (++calls === 1
        ? failingAfter([messageStart()], new Error('502 bad gateway'), 1)
        : succeeding([messageStart(), delta('ok')])),
      { maxRetries: 2, baseDelayMs: 0 },
    );

    const { events, error } = await drain(gen);

    expect(error).toBeNull();
    expect(calls).toBe(2);
    expect(events).toHaveLength(2);
  });

  it('does NOT retry once a content_block_start (tool call) was emitted', async () => {
    let calls = 0;
    const toolStart: StreamEvent = {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
    };
    const gen = withStreamRetry(
      () => { calls++; return failingAfter([toolStart], new Error('500 internal server error'), 1); },
      { maxRetries: 3, baseDelayMs: 0 },
    );

    await drain(gen);
    expect(calls).toBe(1);
  });

  it('gives up after maxRetries and throws the last error', async () => {
    let calls = 0;
    const gen = withStreamRetry(
      () => { calls++; return failingAfter([], new Error('503 unavailable'), 0); },
      { maxRetries: 2, baseDelayMs: 0 },
    );

    const { error } = await drain(gen);

    expect(error?.message).toContain('503');
    expect(calls).toBe(3); // 1 initial + 2 retries
  });

  it('honours maxRetries = 0 (retrying disabled)', async () => {
    let calls = 0;
    const gen = withStreamRetry(
      () => { calls++; return failingAfter([], new Error('429 rate limit'), 0); },
      { maxRetries: 0, baseDelayMs: 0 },
    );

    await drain(gen);
    expect(calls).toBe(1);
  });

  it('stops without retrying when the user already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const gen = withStreamRetry(
      () => { calls++; return failingAfter([], new Error('503 server error'), 0); },
      { maxRetries: 3, baseDelayMs: 0, abortSignal: controller.signal },
    );

    const { error } = await drain(gen);
    expect(error?.message).toContain('503');
    expect(calls).toBe(1);
  });

  it('aborts an in-flight wait immediately', async () => {
    const controller = new AbortController();
    let calls = 0;
    const gen = withStreamRetry(
      () => { calls++; return failingAfter([], new Error('503 server error'), 0); },
      { maxRetries: 3, baseDelayMs: 60_000, abortSignal: controller.signal },
    );

    const started = Date.now();
    const drained = drain(gen);
    // Let the first attempt fail and enter the backoff wait.
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    const { error } = await drained;

    expect(error?.message).toContain('503');
    expect(calls).toBe(1);
    // Would be 60s if the sleep were not abortable.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('a non-streaming AssistantMessage counts as output', async () => {
    let calls = 0;
    const answer = { role: 'assistant', content: 'done' } as unknown as AssistantMessage;
    const gen = withStreamRetry(
      () => (async function* () {
        calls++;
        yield answer;
        throw new Error('500 internal server error');
      })(),
      { maxRetries: 3, baseDelayMs: 0 },
    );

    await drain(gen);
    expect(calls).toBe(1);
  });
});

describe('resolveRetryConfig', () => {
  it('defaults to 3 retries, 1s base, 30s cap', () => {
    expect(resolveRetryConfig({} as NodeJS.ProcessEnv)).toEqual({
      maxRetries: 3,
      baseDelayMs: 1000,
      maxDelayMs: 30_000,
    });
  });

  it('reads overrides from the environment', () => {
    expect(
      resolveRetryConfig({
        CODERIX_LLM_MAX_RETRIES: '5',
        CODERIX_LLM_RETRY_BASE_MS: '250',
        CODERIX_LLM_RETRY_MAX_MS: '5000',
      } as NodeJS.ProcessEnv),
    ).toEqual({ maxRetries: 5, baseDelayMs: 250, maxDelayMs: 5000 });
  });

  it('honours 0 to disable retrying', () => {
    expect(
      resolveRetryConfig({ CODERIX_LLM_MAX_RETRIES: '0' } as NodeJS.ProcessEnv).maxRetries,
    ).toBe(0);
  });

  it('falls back on invalid values', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = resolveRetryConfig({ CODERIX_LLM_MAX_RETRIES: 'abc' } as NodeJS.ProcessEnv);
    expect(cfg.maxRetries).toBe(3);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('never caps below the base delay', () => {
    const cfg = resolveRetryConfig({
      CODERIX_LLM_RETRY_BASE_MS: '9000',
      CODERIX_LLM_RETRY_MAX_MS: '100',
    } as NodeJS.ProcessEnv);
    expect(cfg.maxDelayMs).toBeGreaterThanOrEqual(cfg.baseDelayMs);
  });
});

describe('computeRetryDelay', () => {
  it('grows exponentially and respects the cap', () => {
    const first = computeRetryDelay(0, 1000, 30_000);
    expect(first).toBeGreaterThanOrEqual(1000);
    expect(first).toBeLessThanOrEqual(1500);

    expect(computeRetryDelay(10, 1000, 30_000)).toBeLessThanOrEqual(30_000);
  });
});