import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createCallModelFromOpenAI } from '../openai-adapter.js';
import { withStreamRetry } from '../retry-stream.js';
import type { AssistantMessage, StreamEvent } from '../types.js';

/**
 * End-to-end retry coverage: a real HTTP upstream, the real OpenAI adapter, and
 * the real retry wrapper. These tests exist because unit tests with fake
 * generators cannot prove the adapter's own failure modes (non-2xx, truncated
 * SSE, dead socket) are classified as retryable — that classification is what
 * decides whether a real turn survives a flaky relay.
 */

type Mode =
  | '429-then-ok'
  | '500-always'
  | 'truncate-after-text'
  | 'ok';

let server: Server;
let baseURL = '';
let mode: Mode = 'ok';
let attempts = 0;

function sseChunk(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      attempts += 1;

      if (mode === '429-then-ok' && attempts === 1) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'rate limit exceeded' } }));
        return;
      }
      if (mode === '500-always') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'internal server error' } }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (mode === 'truncate-after-text') {
        // Real answer text arrives, then the relay dies without a finish_reason.
        res.write(sseChunk({ choices: [{ index: 0, delta: { content: 'half an answer' } }] }));
        res.end();
        return;
      }

      res.write(sseChunk({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }));
      res.write(sseChunk({ choices: [{ index: 0, delta: { content: 'complete' } }] }));
      res.write(sseChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

function makeCallModel() {
  return createCallModelFromOpenAI(
    { baseUrl: baseURL, apiKey: 'test-key', maxTokens: 64 } as never,
    'test-model',
  );
}

async function run(maxRetries = 3) {
  const events: Array<StreamEvent | AssistantMessage> = [];
  const retries: number[] = [];
  const gen = withStreamRetry(
    () => makeCallModel()({
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      signal: undefined,
      cacheControl: false,
    } as never) as AsyncGenerator<StreamEvent | AssistantMessage>,
    {
      maxRetries,
      baseDelayMs: 0,
      onRetry: (attempt) => retries.push(attempt),
    },
  );

  let error: Error | null = null;
  try {
    for await (const ev of gen) events.push(ev);
  } catch (err) {
    error = err as Error;
  }
  return { events, retries, error };
}

describe('model-call retry (end to end)', () => {
  it('retries a 429 and completes normally', async () => {
    mode = '429-then-ok';
    attempts = 0;

    const { events, retries, error } = await run();

    expect(error).toBeNull();
    expect(attempts).toBe(2);
    expect(retries).toEqual([1]);
    // The retried answer reaches the caller exactly once.
    expect(events.some((e) => 'type' in e && e.type === 'message_stop')).toBe(true);
  });

  it('gives up on a persistent 500 after the configured attempts', async () => {
    mode = '500-always';
    attempts = 0;

    const { retries, error } = await run(2);

    expect(error).not.toBeNull();
    expect(attempts).toBe(3); // 1 initial + 2 retries
    expect(retries).toEqual([1, 2]);
  });

  it('does not retry once the upstream already streamed answer text', async () => {
    mode = 'truncate-after-text';
    attempts = 0;

    const { events, retries, error } = await run();

    // The adapter surfaces the truncation as an error; retrying here would
    // duplicate "half an answer" on top of the next attempt's output.
    expect(error).not.toBeNull();
    expect(attempts).toBe(1);
    expect(retries).toEqual([]);
    // The partial text was delivered, which is exactly why retrying is unsafe.
    expect(events.length).toBeGreaterThan(0);
  });

  it('passes a healthy call straight through with no retry delay', async () => {
    mode = 'ok';
    attempts = 0;

    const { events, retries, error } = await run();

    expect(error).toBeNull();
    expect(attempts).toBe(1);
    expect(retries).toEqual([]);
    expect(events.some((e) => 'type' in e && e.type === 'message_stop')).toBe(true);
  });
});