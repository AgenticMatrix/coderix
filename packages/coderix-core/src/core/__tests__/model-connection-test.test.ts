import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();

vi.mock('undici', () => ({ fetch: (...args: unknown[]) => fetchMock(...args) }));

import { testModelConnection } from '../model-connection-test.js';

type Call = { url: string; headers: Record<string, string> };

function calls(): Call[] {
  return fetchMock.mock.calls.map(([url, init]) => ({
    url: String(url),
    headers: (init?.headers ?? {}) as Record<string, string>,
  }));
}

function authOf(headers: Record<string, string>): 'anthropic' | 'openai' {
  return headers['x-api-key'] ? 'anthropic' : 'openai';
}

function respond(status: number, body: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

/** A gateway that 404s every listing path except one, which requires Bearer. */
function tensorisLike(opts: { listingPath: string; acceptBearerOnly?: boolean }) {
  return (url: string, init: { method?: string; headers?: Record<string, string> }) => {
    const headers = init?.headers ?? {};
    const path = new URL(url).pathname;
    if (init?.method === 'POST') {
      // Completion probe — both protocols served, model list already known.
      return Promise.resolve(respond(200, { content: [], choices: [] }));
    }
    if (path === opts.listingPath) {
      if (opts.acceptBearerOnly && authOf(headers) === 'anthropic') {
        return Promise.resolve(respond(401, { error: { message: 'missing_auth' } }));
      }
      return Promise.resolve(respond(200, { data: [{ id: 'model-a' }] }));
    }
    return Promise.resolve(respond(404, { error: { message: 'endpoint_not_found' } }));
  };
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('testModelConnection baseUrl normalisation', () => {
  it('never builds a doubled /v1 path from a /v1 base', async () => {
    fetchMock.mockImplementation(tensorisLike({ listingPath: '/v1/models' }));

    const result = await testModelConnection({ baseUrl: 'https://api.tensoris.ai/v1', apiKey: 'k' });

    expect(result.ok).toBe(true);
    expect(calls().some((c) => c.url.includes('/v1/v1/'))).toBe(false);
  });

  it('strips a pasted completion endpoint instead of appending to it', async () => {
    fetchMock.mockImplementation(tensorisLike({ listingPath: '/v1/models' }));

    const result = await testModelConnection({
      baseUrl: 'https://api.tensoris.ai/v1/messages',
      apiKey: 'k',
    });

    expect(result.ok).toBe(true);
    expect(calls().some((c) => c.url.includes('/messages/v1/'))).toBe(false);
    expect(calls()[0]!.url).toBe('https://api.tensoris.ai/v1/models');
  });

  it('probes the same listing URL with both auth schemes', async () => {
    // The real tensoris layout: /v1/models authenticates via Bearer only, while
    // the inference endpoint accepts x-api-key. Probing one scheme reported a
    // bogus "check your API key" for a valid key.
    fetchMock.mockImplementation(
      tensorisLike({ listingPath: '/v1/models', acceptBearerOnly: true }),
    );

    const result = await testModelConnection({ baseUrl: 'https://api.tensoris.ai', apiKey: 'k' });

    expect(result.ok).toBe(true);
    expect(result.message).toContain('连接成功');
    expect(result.models).toEqual(['model-a']);

    const listing = calls().filter((c) => c.url.endsWith('/v1/models'));
    expect(listing.map((c) => authOf(c.headers))).toEqual(['anthropic', 'openai']);
  });

  it('keeps a provider path that merely ends in a version segment', async () => {
    // bigmodel.cn mounts its OpenAI API at /api/paas/v4. Stripping the version
    // would derive /api/paas/models and lose the real endpoint, so the
    // configured path must still be tried first.
    fetchMock.mockImplementation(tensorisLike({ listingPath: '/api/paas/v4/models' }));

    const result = await testModelConnection({
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'k',
    });

    expect(result.ok).toBe(true);
    expect(calls()[0]!.url).toBe('https://open.bigmodel.cn/api/paas/v4/models');
  });
});

describe('testModelConnection error reporting', () => {
  it('does not report an auth failure when a Bearer attempt would have worked', async () => {
    fetchMock.mockImplementation(
      tensorisLike({ listingPath: '/v1/models', acceptBearerOnly: true }),
    );

    const result = await testModelConnection({ baseUrl: 'https://api.tensoris.ai', apiKey: 'k' });

    expect(result.message).not.toContain('认证失败');
  });

  it('still reports an auth failure when every scheme is rejected', async () => {
    fetchMock.mockImplementation((url: string, init: { method?: string }) => {
      if (init?.method === 'POST') return Promise.resolve(respond(200, { content: [] }));
      return Promise.resolve(respond(401, { error: { message: 'bad key' } }));
    });

    const result = await testModelConnection({ baseUrl: 'https://api.example.com', apiKey: 'k' });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('认证失败');
  });

  it('reports a 404 when no listing path exists', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(respond(404, { error: { message: 'endpoint_not_found' } })),
    );

    const result = await testModelConnection({ baseUrl: 'https://api.example.com', apiKey: 'k' });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('404');
  });
});