import { describe, it, expect, vi } from 'vitest';
import { createManagerCache, type Shutdownable } from '../mcp-manager-cache.js';

interface FakeManager extends Shutdownable {
  cwd: string;
}

function makeFactory() {
  const created: FakeManager[] = [];
  const factory = vi.fn(async (cwd: string): Promise<FakeManager> => {
    // Simulate a slow server handshake so concurrent callers overlap.
    await new Promise((r) => setTimeout(r, 20));
    const manager: FakeManager = {
      cwd,
      shutdown: vi.fn(async () => {}),
    };
    created.push(manager);
    return manager;
  });
  return { factory, created };
}

describe('createManagerCache', () => {
  it('creates one manager for concurrent callers of the same workspace', async () => {
    const { factory, created } = makeFactory();
    const cache = createManagerCache(factory);

    const [a, b, c] = await Promise.all([
      cache.get('/w1'),
      cache.get('/w1'),
      cache.get('/w1'),
    ]);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(cache.size()).toBe(1);
  });

  it('creates one manager per workspace', async () => {
    const { factory } = makeFactory();
    const cache = createManagerCache(factory);

    const [a, b] = await Promise.all([cache.get('/w1'), cache.get('/w2')]);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(a.cwd).toBe('/w1');
    expect(b.cwd).toBe('/w2');
    expect(cache.size()).toBe(2);
  });

  it('reuses a cached manager without re-running the factory', async () => {
    const { factory } = makeFactory();
    const cache = createManagerCache(factory);

    const first = await cache.get('/w1');
    const second = await cache.get('/w1');
    expect(factory).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('clears a failed initialization so a later call can retry', async () => {
    const shutdown = vi.fn(async () => {});
    let attempts = 0;
    const cache = createManagerCache(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('handshake failed');
      return { shutdown };
    });

    await expect(cache.get('/w1')).rejects.toThrow('handshake failed');
    const manager = await cache.get('/w1');
    expect(manager).toBeDefined();
    expect(attempts).toBe(2);
    expect(cache.size()).toBe(1);
  });

  it('shuts every manager down on closeAll and refuses new work', async () => {
    const shutdownA = vi.fn(async () => {});
    const shutdownB = vi.fn(async () => {});
    const cache = createManagerCache(async (cwd) => ({
      shutdown: cwd === '/w1' ? shutdownA : shutdownB,
    }));

    await Promise.all([cache.get('/w1'), cache.get('/w2')]);
    await cache.closeAll();

    expect(shutdownA).toHaveBeenCalledTimes(1);
    expect(shutdownB).toHaveBeenCalledTimes(1);
    expect(cache.size()).toBe(0);
    await expect(cache.get('/w1')).rejects.toThrow('closed');
  });
});
