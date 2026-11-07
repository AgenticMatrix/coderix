import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createServer } from 'node:http';
import { connect, type Socket } from 'node:net';
import { startProtocolGateway } from '../protocol-gateway/server.js';

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
 * Send a request body over a raw socket in tiny segments, so multi-byte
 * characters are guaranteed to straddle TCP/HTTP chunk boundaries — the exact
 * condition that used to corrupt them (`raw += chunk` decoded each segment
 * independently).
 */
function postInSegments(
  port: number,
  path: string,
  body: Buffer,
  segmentSize: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const headers = [
      `POST ${path} HTTP/1.1`,
      'Host: 127.0.0.1',
      'Content-Type: application/json',
      `Content-Length: ${body.length}`,
      'Connection: close',
      '',
      '',
    ].join('\r\n');

    const socket: Socket = connect(port, '127.0.0.1', () => {
      socket.write(headers);
      let offset = 0;
      const pump = () => {
        if (offset >= body.length) return;
        const next = Math.min(offset + segmentSize, body.length);
        socket.write(body.subarray(offset, next));
        offset = next;
        // A macrotask gap forces separate reads on the server side.
        setImmediate(pump);
      };
      pump();
    });

    const chunks: Buffer[] = [];
    socket.on('data', (d) => chunks.push(d));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('error', reject);
  });
}

let upstream: http.Server;
let gateway: http.Server;
let upstreamPort = 0;
let gatewayPort = 0;
let received: Buffer[] = [];

beforeAll(async () => {
  // Bind an ephemeral port — the default 7393 may be held by a running app.
  process.env.CONVERSION_PORT = '0';

  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      received.push(Buffer.concat(chunks));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        model: 'test',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  upstreamPort = (upstream.address() as { port: number }).port;

  gateway = startProtocolGateway();
  await new Promise<void>((r) => {
    if (gateway.listening) return r();
    gateway.once('listening', () => r());
  });
  gatewayPort = (gateway.address() as { port: number }).port;
});

afterAll(async () => {
  gateway.closeAllConnections?.();
  await new Promise<void>((r) => gateway.close(() => r()));
  await new Promise<void>((r) => upstream.close(() => r()));
});

describe('protocol gateway request body integrity', () => {
  it('preserves multi-byte text delivered in 1-byte segments', async () => {
    received = [];
    const text = '中文😀表情测试'.repeat(400);
    const body = Buffer.from(JSON.stringify({
      model: 'test',
      max_tokens: 16,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    }), 'utf8');

    const path = '/gw/' + encodeURIComponent('http://127.0.0.1:' + upstreamPort + '/v1') + '/v1/messages';
    const response = await postInSegments(gatewayPort, path, body, 1);
    expect(response).toContain('200');

    expect(received).toHaveLength(1);
    const forwarded = received[0]!.toString('utf8');
    const parsed = JSON.parse(forwarded);
    const got = parsed.messages[0].content as string;

    // The regression this guards: per-chunk decoding turned these into U+FFFD.
    expect(got).toBe(text);
    expect(got.match(/\uFFFD/g)).toBeNull();
    expect(hasLoneSurrogate(got)).toBe(false);
  });

  it('never forwards an unpaired surrogate escape', async () => {
    received = [];
    const body = Buffer.from(JSON.stringify({
      model: 'test',
      max_tokens: 16,
      messages: [{ role: 'user', content: [{ type: 'text', text: '截断\uD83DX' }] }],
    }), 'utf8');

    const path = '/gw/' + encodeURIComponent('http://127.0.0.1:' + upstreamPort + '/v1') + '/v1/messages';
    const response = await postInSegments(gatewayPort, path, body, 7);
    expect(response).toContain('200');

    const forwarded = received[0]!.toString('utf8');
    expect(/\\u[dD][89a-fA-F][0-9a-fA-F]{2}/.test(forwarded)).toBe(false);
    expect(forwarded).toContain('\uFFFD');
    // Still parseable by a strict JSON reader, as the upstream requires.
    expect(() => JSON.parse(forwarded)).not.toThrow();
  });
});