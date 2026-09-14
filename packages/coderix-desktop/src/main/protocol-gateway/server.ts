/**
 * protocol-gateway/server.ts — In-process protocol conversion gateway.
 *
 * A loopback-only HTTP server. When a mismatched model is bound to the
 * claude-code engine, its baseUrl is repointed at `…/gw/<modelName>`; the
 * `claude` CLI then appends its own `/v1/messages` suffix, which this server
 * maps to the `anthropic` inbound protocol, converts the request to the model's
 * native `openai` (Chat Completions) protocol, forwards upstream, and converts
 * the response back. The apiKey never leaves this process.
 *
 * Mirrors agentstation-app's protocol-gateway/server.ts, reduced to the single
 * `anthropic → openai` direction (Coderix has only coderix + claude-code, both
 * of which speak Anthropic Messages).
 */

import { createServer, type Server } from 'node:http';
import type { ServerResponse } from 'node:http';
import { fetch as undiciFetch } from 'undici';
import { gatewayPort, GATEWAY_HOST } from './config.js';
import type { Protocol, ProtocolConverter, SseFrame, ModelResolver } from './types.js';
import { buildUpstreamUrl, headersFor } from './shared.js';
import { createMessagesToChatConverter } from './messages-to-chat.js';

type Json = Record<string, unknown>;

/** Which inbound protocol a `/gw/<model>/<rest>` path represents. */
function inboundProtocol(rest: string): Protocol | null {
  const r = rest.replace(/^\/+/, '').toLowerCase();
  if (r.startsWith('v1/messages') || r === 'messages') return 'anthropic';
  return null;
}

function json(res: ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function writeSseFrame(res: ServerResponse, frame: SseFrame): void {
  if (frame.event) res.write(`event: ${frame.event}\n`);
  for (const line of frame.data.split('\n')) {
    res.write(`data: ${line}\n`);
  }
  res.write('\n');
}

/** Minimal SSE parser over a web ReadableStream. Emits `(eventName | null, data)`
 *  per SSE event, joining multi-line `data:` payloads with newlines. */
async function pumpSse(
  stream: AsyncIterable<Uint8Array>,
  onEvent: (event: string | null, data: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent: string | null = null;
  let dataLines: string[] = [];
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (line === '') {
        if (dataLines.length > 0) onEvent(currentEvent, dataLines.join('\n'));
        currentEvent = null;
        dataLines = [];
      } else if (line.startsWith(':')) {
        // comment — ignore
      } else if (line.startsWith('event:')) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
  }
  if (dataLines.length > 0) onEvent(currentEvent, dataLines.join('\n'));
}

export function startProtocolGateway(resolveModel: ModelResolver): Server {
  const server = createServer(async (req, res) => {
    const pathname = (req.url || '').split('?')[0];

    const match = pathname.match(/^\/gw\/([^/]+)\/(.+)$/);
    if (!match) {
      json(res, 404, { error: { message: 'not a gateway path' } });
      return;
    }
    const modelName = decodeURIComponent(match[1]!);
    const rest = match[2]!;

    const inbound = inboundProtocol(rest);
    if (!inbound) {
      json(res, 404, { error: { message: `unknown inbound protocol for path /${rest}` } });
      return;
    }

    const binding = resolveModel(modelName);
    if (!binding) {
      json(res, 404, { error: { message: `model ${modelName} not found` } });
      return;
    }
    if (!binding.baseUrl) {
      json(res, 400, { error: { message: `model ${modelName} has no baseUrl` } });
      return;
    }

    // The claude-code harness always speaks anthropic; only openai models need
    // conversion. An anthropic model should never be routed here (direct path).
    if (binding.protocol === 'anthropic') {
      json(res, 501, { error: { message: `no conversion needed for model ${modelName}` } });
      return;
    }

    if (req.method !== 'POST') {
      json(res, 405, { error: { message: 'only POST is supported' } });
      return;
    }

    // The request body is always JSON (small); buffer it to transform.
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body: Json = {};
    try { body = raw ? (JSON.parse(raw) as Json) : {}; } catch {
      json(res, 400, { error: { message: 'invalid JSON request body' } });
      return;
    }

    const converter: ProtocolConverter = createMessagesToChatConverter();
    const upstreamUrl = buildUpstreamUrl(binding.baseUrl, binding.protocol);
    const upstreamHeaders = headersFor(binding.protocol, binding.apiKey || '');
    const convertedBody = converter.convertRequest(body);

    // Ensure the model-native request carries a valid token limit. The claude
    // CLI sends its own default (or omits it), which may exceed the model's
    // cap and 400 upstream. Clamp to the model's configured maxTokens.
    const cap = binding.maxTokens || 32768;
    const tokenLimit = convertedBody.max_tokens;
    if (typeof tokenLimit !== 'number' || tokenLimit < 1) {
      convertedBody.max_tokens = cap;
    } else if (tokenLimit > cap) {
      convertedBody.max_tokens = cap;
    }

    let upstreamRes: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      upstreamRes = await undiciFetch(upstreamUrl, {
        method: 'POST',
        headers: { ...upstreamHeaders, 'content-type': 'application/json' },
        body: JSON.stringify(convertedBody),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[gateway] upstream fetch failed for ${modelName}:`, msg);
      json(res, 502, { error: { message: `upstream fetch failed: ${msg}` } });
      return;
    }

    // Upstream error (4xx/5xx): forward the raw status + body unchanged.
    if (!upstreamRes.ok) {
      const text = await upstreamRes.text();
      res.writeHead(upstreamRes.status, { 'Content-Type': 'application/json' });
      res.end(text);
      return;
    }

    const streaming = body.stream === true;
    if (!streaming) {
      const text = await upstreamRes.text();
      let respBody: Json = {};
      try { respBody = text ? (JSON.parse(text) as Json) : {}; } catch { respBody = {}; }
      json(res, 200, converter.convertResponse(respBody));
      return;
    }

    // Streaming: relay upstream SSE, converted frame-by-frame, without
    // buffering the whole body.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const upstreamBody = upstreamRes.body;
    if (!upstreamBody) {
      res.end();
      return;
    }
    try {
      await pumpSse(upstreamBody as unknown as AsyncIterable<Uint8Array>, (event, data) => {
        for (const frame of converter.convertSse(event, data)) writeSseFrame(res, frame);
      });
      for (const frame of converter.finishSse()) writeSseFrame(res, frame);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[gateway] stream error for ${modelName}:`, msg);
    }
    res.end();
  });

  server.listen(gatewayPort(), GATEWAY_HOST, () => {
    console.log(`[gateway] protocol conversion listening on http://${GATEWAY_HOST}:${gatewayPort()}`);
  });

  return server;
}
