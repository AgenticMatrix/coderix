import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createCallModelFromOpenAI } from '../openai-adapter.js';

/**
 * A turn whose upstream stream ends without a finish_reason was cut short. It
 * used to be reported as a normal `end_turn`, which made a truncated response
 * indistinguishable from a completed answer — the agent silently went idle with
 * half its work done.
 */
async function collect(callModel: () => AsyncGenerator<any>): Promise<any[]> {
  const events: any[] = [];
  for await (const ev of callModel()) events.push(ev);
  return events;
}

describe('createCallModelFromOpenAI — truncated streams', () => {
  let server: Server;
  let baseURL = '';
  let mode: 'truncated' | 'complete' = 'truncated';

  beforeAll(async () => {
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({
            choices: [{ index: 0, delta: { content: 'I will now edit the file' } }],
          })}\n\n`,
        );
        if (mode === 'complete') {
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        }
        // 'truncated': close mid-answer, never reporting a finish_reason.
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  function makeCall() {
    return createCallModelFromOpenAI(
      { baseUrl: baseURL, apiKey: 'test-key' } as any,
      'test-model',
    ) as any;
  }

  const params = () => ({
    system: '',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
  });

  it('fails the turn instead of reporting a clean end_turn', async () => {
    mode = 'truncated';
    await expect(
      collect(() => makeCall()(params())),
    ).rejects.toThrow(/without a finish reason/i);
  });

  it('still completes normally when the upstream reports a finish', async () => {
    mode = 'complete';
    const events = await collect(() => makeCall()(params()));
    const stops = events.filter((e) => e.type === 'message_stop');
    expect(stops).toHaveLength(1);
    expect(stops[0].message.stopReason).toBe('end_turn');
  });
});