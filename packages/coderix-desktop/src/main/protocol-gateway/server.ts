/**
 * protocol-gateway/server.ts — In-process protocol conversion gateway.
 *
 * A loopback-only HTTP server. When an openai-protocol model is bound to the
 * claude-code engine, its baseUrl is repointed at `…/gw/<encodedBaseUrl>`; the
 * `claude` CLI then appends its own `/v1/messages` suffix, which this server
 * maps to the `anthropic` inbound protocol. It forwards the request to the
 * resolved upstream baseUrl — converting anthropic → openai on the wire when the
 * upstream is OpenAI-compatible, or relaying it through unchanged when the
 * upstream is itself Anthropic — then converts/relays the response back.
 *
 * The upstream endpoint is carried in the gateway path (the base_url the engine
 * already resolved), NOT recovered by re-resolving a model name against
 * `~/.coderix/settings.json` (model ids collide across providers, so a name
 * lookup routes to the wrong base_url). The apiKey is read back off the request:
 * the engine injected it into the spawned CLI (ANTHROPIC_AUTH_TOKEN /
 * ANTHROPIC_API_KEY), which echoes it to this loopback server. The key never
 * leaves this process.
 */

import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { ServerResponse } from 'node:http';
import { fetch as undiciFetch } from 'undici';
import { gatewayPort, GATEWAY_HOST } from './config.js';
import type { Protocol, ProtocolConverter, SseFrame } from './types.js';
import { buildUpstreamUrl, headersFor } from './shared.js';
import { createMessagesToChatConverter } from './messages-to-chat.js';
import { detectProtocol } from '../../../../../packages/coderix-core/src/config.js';

type Json = Record<string, unknown>;

/** Which inbound protocol a `/gw/<baseUrl>/<rest>` path represents. */
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

/** The apiKey the harness echoed back. The engine injects the bound key via
 *  ANTHROPIC_AUTH_TOKEN (sent as `Authorization: Bearer …`) and
 *  ANTHROPIC_API_KEY (sent as `x-api-key`); read whichever the CLI used. */
function extractApiKey(req: IncomingMessage): string {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  const xApi = req.headers['x-api-key'];
  if (typeof xApi === 'string') return xApi.trim();
  return '';
}

export function startProtocolGateway(): Server {
  const server = createServer(async (req, res) => {
    const pathname = (req.url || '').split('?')[0];

    const match = pathname.match(/^\/gw\/([^/]+)\/(.+)$/);
    if (!match) {
      json(res, 404, { error: { message: 'not a gateway path' } });
      return;
    }
    let baseUrl: string;
    try {
      baseUrl = decodeURIComponent(match[1]!);
    } catch {
      json(res, 400, { error: { message: 'invalid gateway path' } });
      return;
    }
    const rest = match[2]!;

    const inbound = inboundProtocol(rest);
    if (!inbound) {
      json(res, 404, { error: { message: `unknown inbound protocol for path /${rest}` } });
      return;
    }
    if (!baseUrl) {
      json(res, 400, { error: { message: 'missing baseUrl in gateway path' } });
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

    const apiKey = extractApiKey(req);
    // The upstream protocol is derived from the resolved base_url. An anthropic
    // upstream is relayed through unchanged (no conversion); an openai upstream
    // is converted anthropic → openai. In practice only openai models are routed
    // here (resolveClaudeCodeBaseUrl sends anthropic models directly), but the
    // pass-through keeps the gateway correct if one ever arrives.
    const upstreamProtocol = detectProtocol(baseUrl);

    const converter: ProtocolConverter | null =
      upstreamProtocol === 'openai' ? createMessagesToChatConverter() : null;
    const upstreamUrl = buildUpstreamUrl(baseUrl, upstreamProtocol);
    const upstreamHeaders = headersFor(upstreamProtocol, apiKey);

    let requestBody = raw;
    if (converter) {
      const convertedBody = converter.convertRequest(body);

      // Ensure the model-native request carries a valid token limit. The claude
      // CLI sends its own default (or omits it), which may exceed the model's
      // cap and 400 upstream. Clamp to the global configured max (65536), which
      // is under every supported model's limit.
      const cap = 65536;
      const tokenLimit = convertedBody.max_tokens;
      if (typeof tokenLimit !== 'number' || tokenLimit < 1) {
        convertedBody.max_tokens = cap;
      } else if (tokenLimit > cap) {
        convertedBody.max_tokens = cap;
      }
      requestBody = JSON.stringify(convertedBody);
    }

    let upstreamRes: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      upstreamRes = await undiciFetch(upstreamUrl, {
        method: 'POST',
        headers: { ...upstreamHeaders, 'content-type': 'application/json' },
        body: requestBody,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[gateway] upstream fetch failed for ${baseUrl}:`, msg);
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
      if (converter) {
        let respBody: Json = {};
        try { respBody = text ? (JSON.parse(text) as Json) : {}; } catch { respBody = {}; }
        json(res, 200, converter.convertResponse(respBody));
      } else {
        res.writeHead(200, {
          'Content-Type': upstreamRes.headers.get('content-type') || 'application/json',
        });
        res.end(text);
      }
      return;
    }

    // Streaming: relay upstream SSE, converted frame-by-frame (or passed through
    // unchanged for an anthropic upstream), without buffering the whole body.
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
        if (converter) {
          for (const frame of converter.convertSse(event, data)) writeSseFrame(res, frame);
        } else {
          writeSseFrame(res, { event: event ?? undefined, data });
        }
      });
      if (converter) {
        for (const frame of converter.finishSse()) writeSseFrame(res, frame);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[gateway] stream error for ${baseUrl}:`, msg);
    }
    res.end();
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `[gateway] FAILED to bind http://${GATEWAY_HOST}:${gatewayPort()} — port already in use. ` +
          `Another app (e.g. agentstation-app) is likely holding it. ` +
          `claude-code requests will land on the wrong gateway until this is resolved. ` +
          `Set CONVERSION_PORT to a free port or stop the conflicting process.`,
      );
    } else {
      console.error(`[gateway] server error:`, err.message);
    }
  });

  server.listen(gatewayPort(), GATEWAY_HOST, () => {
    console.log(`[gateway] protocol conversion listening on http://${GATEWAY_HOST}:${gatewayPort()}`);
  });

  return server;
}
