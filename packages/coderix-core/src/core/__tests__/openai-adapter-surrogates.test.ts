import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createCallModelFromOpenAI } from '../openai-adapter.js';

/**
 * A truncated astral character (an emoji cut between its UTF-16 halves) leaves
 * an unpaired surrogate. `JSON.stringify` escapes it as `\udXXX`, which strict
 * OpenAI-compatible upstreams reject with 400 "failed to parse JSON" — killing
 * the whole turn. The live adapter serialises through `stringifyForWire`, so
 * the body that reaches the socket must never carry such an escape.
 */
function hasSurrogateEscape(json: string): boolean {
  return /\\u[dD][89a-fA-F][0-9a-fA-F]{2}/.test(json);
}

describe('createCallModelFromOpenAI — lone surrogates in the request body', () => {
  let server: Server;
  let baseURL = '';
  const bodies: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        bodies.push(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`);
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  async function send(messages: Array<{ role: string; content: string }>): Promise<string> {
    bodies.length = 0;
    const callModel = createCallModelFromOpenAI(
      { baseUrl: baseURL, apiKey: 'test-key' } as any,
      'test-model',
    ) as any;
    for await (const _ev of callModel({ system: '', messages, tools: [] })) {
      // drain
    }
    expect(bodies).toHaveLength(1);
    return bodies[0]!;
  }

  it('repairs an unpaired surrogate in a user message', async () => {
    const body = await send([{ role: 'user', content: '输出：\uD83D' }]);

    expect(hasSurrogateEscape(body)).toBe(false);
    expect(body).toContain('\uFFFD');
    // Still parseable, so a strict upstream accepts it.
    expect(() => JSON.parse(body)).not.toThrow();
  });

  it('leaves well-formed emoji and CJK untouched', async () => {
    const text = '中文 😀 表情 🎯';
    const body = await send([{ role: 'user', content: text }]);

    expect(hasSurrogateEscape(body)).toBe(false);
    expect(JSON.parse(body).messages.at(-1).content).toBe(text);
  });
});