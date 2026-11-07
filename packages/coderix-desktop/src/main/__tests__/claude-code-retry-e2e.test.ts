/**
 * End-to-end retry behaviour of `runClaudeCodeQuery`.
 *
 * The turn loop is driven with a fake `claude` SDK so each simulated attempt is
 * a scripted sequence of messages. This is what proves the retry actually
 * re-spawns — the pure `decideTurnRetry` tests only pin the decision, not the
 * loop that acts on it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Scripted attempt sequences; index = attempt number. */
const script: Array<Array<Record<string, unknown>>> = [];
let attemptIndex = 0;
const queryCalls: Array<Record<string, unknown>> = [];

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: Record<string, unknown>) => {
    queryCalls.push(args);
    const events = script[attemptIndex] ?? [];
    attemptIndex += 1;
    return (async function* () {
      for (const ev of events) {
        if (ev.__throw) throw new Error(String(ev.__throw));
        yield ev;
      }
    })();
  },
  getSubagentMessages: async () => [],
  getSessionInfo: async () => null,
}));

vi.mock('../claude-code-runtime.js', () => ({
  claudeCodeRuntimeStatus: async () => ({ status: 'installed' }),
  ensureClaudeCodeInstalled: async () => ({ status: 'installed' }),
}));

const { runClaudeCodeQuery } = await import('../claude-code-engine.js');

function opts(overrides: Record<string, unknown> = {}) {
  const controller = new AbortController();
  return {
    prompt: 'hi',
    sessionId: 'test-session-' + Math.random().toString(36).slice(2),
    cwd: '/tmp',
    history: [],
    permissionMode: 'auto',
    model: 'test-model',
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKey: 'k',
    protocol: 'openai',
    abortController: controller,
    ...overrides,
  } as never;
}

async function drain(gen: AsyncGenerator<any>) {
  const events: any[] = [];
  let error: Error | null = null;
  try {
    for await (const ev of gen) events.push(ev);
  } catch (err) {
    error = err as Error;
  }
  return { events, error };
}

/** The CLI's failed-turn shape: a result marked as an error. */
function failedResult(message: string) {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    session_id: 'sess-1',
    is_error: true,
    errors: [message],
    usage: { input_tokens: 1, output_tokens: 0 },
  };
}

function okResult(text: string) {
  return {
    type: 'result',
    subtype: 'success',
    session_id: 'sess-1',
    is_error: false,
    result: text,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

beforeEach(() => {
  script.length = 0;
  queryCalls.length = 0;
  attemptIndex = 0;
  process.env.CODERIX_LLM_RETRY_BASE_MS = '0';
  process.env.CODERIX_LLM_RETRY_MAX_MS = '0';
});

describe('runClaudeCodeQuery retry', () => {
  it('re-spawns after a 429 that produced no output', async () => {
    script.push([failedResult('API Error: 429 rate limit exceeded')]);
    script.push([okResult('done')]);

    const { events, error } = await drain(runClaudeCodeQuery(opts()));

    expect(error).toBeNull();
    expect(queryCalls).toHaveLength(2);
    // The caller is told a retry is happening.
    const retryEvents = events.filter((e) => e.type === 'retry');
    expect(retryEvents).toHaveLength(1);
    // The turn still finishes normally afterwards.
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('re-spawns after a thrown connection error', async () => {
    script.push([{ __throw: 'API Error: Connection error.' }]);
    script.push([okResult('recovered')]);

    const { events, error } = await drain(runClaudeCodeQuery(opts()));

    expect(error).toBeNull();
    expect(queryCalls).toHaveLength(2);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('does NOT re-spawn after the model already produced text', async () => {
    script.push([
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'partial answer' }] } },
      failedResult('API Error: 503 Service Unavailable'),
    ]);
    script.push([okResult('should never run')]);

    const { events, error } = await drain(runClaudeCodeQuery(opts()));

    // Only one spawn: retrying would duplicate "partial answer".
    expect(queryCalls).toHaveLength(1);
    expect(error).toBeNull();
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });

  it('does NOT retry a 400 invalid request', async () => {
    script.push([failedResult('API Error: 400 The request format is invalid')]);
    script.push([okResult('nope')]);

    const { events } = await drain(runClaudeCodeQuery(opts()));

    expect(queryCalls).toHaveLength(1);
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('stops after the configured number of transient retries', async () => {
    process.env.CODERIX_LLM_MAX_RETRIES = '2';
    for (let i = 0; i < 5; i++) script.push([failedResult('API Error: 503 Service Unavailable')]);

    const { events } = await drain(runClaudeCodeQuery(opts()));

    expect(queryCalls).toHaveLength(3); // 1 initial + 2 retries
    const retries = events.filter((e) => e.type === 'retry');
    expect(retries).toHaveLength(2);
  });

  it('retrying can be disabled entirely', async () => {
    process.env.CODERIX_LLM_MAX_RETRIES = '0';
    script.push([failedResult('API Error: 429 rate limit')]);
    script.push([okResult('nope')]);

    const { events } = await drain(runClaudeCodeQuery(opts()));

    expect(queryCalls).toHaveLength(1);
    expect(events.some((e) => e.type === 'retry')).toBe(false);
  });

  it('does not retry when the user already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    script.push([failedResult('API Error: 503 Service Unavailable')]);
    script.push([okResult('nope')]);

    await drain(runClaudeCodeQuery(opts({ abortController: controller })));

    // The first attempt still runs, but a dead controller must never turn the
    // failure into another request.
    expect(queryCalls).toHaveLength(1);
  });
});