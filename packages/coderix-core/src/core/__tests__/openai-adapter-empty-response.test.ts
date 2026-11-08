import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createCallModelFromOpenAI } from '../openai-adapter.js';
import { classifyError } from '../error-recovery.js';

/**
 * A degraded upstream can answer with a perfectly well-formed but empty
 * completion: `finish_reason: stop`, valid usage, and no text, thinking or tool
 * call. That used to be reported as a clean `end_turn`, so the turn loop
 * stopped and the conversation went idle with nothing said — the exact way a
 * long CAD session appeared to "end for no reason".
 */
async function collect(callModel: () => AsyncGenerator<any>): Promise<any[]> {
  const events: any[] = [];
  for await (const ev of callModel()) events.push(ev);
  return events;
}

describe('createCallModelFromOpenAI — empty completions', () => {
  let server: Server;
  let baseURL = '';
  let mode: 'empty' | 'text' | 'tool' = 'empty';

  beforeAll(async () => {
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (mode === 'empty') {
          // Byte-for-byte what the real degraded endpoint sent for task_0694:
          // an empty delta carrying only a finish_reason, then the usage block.
          res.write(
            'data: {"id":"chatcmpl-1a66f619-c418-46f0-9e78-e1465beb6252","object":"chat.completion.chunk",' +
            '"created":1794104604,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
          );
          res.write(
            'data: {"id":"chatcmpl-1a66f619-c418-46f0-9e78-e1465beb6252","object":"chat.completion.chunk",' +
            '"created":1794104604,"model":"test-model","choices":[{"index":0,"delta":{}}],' +
            '"usage":{"completion_tokens":5,"prompt_tokens":127990,"total_tokens":127995,' +
            '"completion_tokens_details":{"reasoning_tokens":0,"text_tokens":5}}}\n\n',
          );
        } else if (mode === 'text') {
          res.write(
            `data: ${JSON.stringify({
              choices: [{ index: 0, delta: { content: '好的，继续第 2 步。' } }],
            })}\n\n`,
          );
          res.write(
            `data: ${JSON.stringify({
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            })}\n\n`,
          );
        } else {
          res.write(
            `data: ${JSON.stringify({
              choices: [{
                index: 0,
                delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'TaskUpdate', arguments: '{"taskId":"1"}' } }] },
              }],
            })}\n\n`,
          );
          res.write(
            `data: ${JSON.stringify({
              choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            })}\n\n`,
          );
        }
        res.write('data: [DONE]\n\n');
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
    messages: [{ role: 'user', content: '继续' }],
    tools: [],
  });

  it('fails the turn instead of reporting a clean end_turn', async () => {
    mode = 'empty';
    await expect(collect(() => makeCall()(params()))).rejects.toThrow(/empty response/i);
  });

  it('names the finish reason and token count in the error', async () => {
    mode = 'empty';
    await expect(collect(() => makeCall()(params()))).rejects.toThrow(
      /finish_reason: stop, 5 output tokens/i,
    );
  });

  it('still completes normally when the model says something', async () => {
    mode = 'text';
    const events = await collect(() => makeCall()(params()));
    const stops = events.filter((e) => e.type === 'message_stop');
    expect(stops).toHaveLength(1);
    expect(stops[0].message.stopReason).toBe('end_turn');
  });

  it('still completes normally when the model only calls a tool', async () => {
    mode = 'tool';
    const events = await collect(() => makeCall()(params()));
    const stops = events.filter((e) => e.type === 'message_stop');
    expect(stops).toHaveLength(1);
    expect(stops[0].message.stopReason).toBe('tool_use');
  });
});

describe('classifyError — empty response', () => {
  it('is retryable so the call is re-issued instead of failing the turn', () => {
    const classified = classifyError(
      new Error('Model returned an empty response from http://x (finish_reason: stop, 5 output tokens)'),
    );
    expect(classified.category).toBe('empty_response');
    expect(classified.retryable).toBe(true);
  });
});