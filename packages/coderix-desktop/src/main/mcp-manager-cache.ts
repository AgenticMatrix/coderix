/**
 * Per-workspace cache for MCP managers.
 *
 * Connecting a manager awaits every server handshake. Before this cache, two
 * concurrent callers (the startup tool-registry prime and the renderer's
 * MCP_LIST) both saw an empty cache, each spawned a full set of MCP servers,
 * and the loser was overwritten with no reference left to shut it down.
 *
 * Keeping the in-flight promise here makes concurrent initialization share one
 * manager, and `closeAll` guarantees every spawned server is disconnected.
 */

export interface Shutdownable {
  shutdown(): Promise<void>;
}

export interface ManagerCache<T extends Shutdownable> {
  get(cwd: string): Promise<T>;
  closeAll(): Promise<void>;
  /** Number of cached managers (diagnostics / tests). */
  size(): number;
}

export function createManagerCache<T extends Shutdownable>(
  factory: (cwd: string) => Promise<T>,
): ManagerCache<T> {
  const byCwd = new Map<string, T>();
  const pending = new Map<string, Promise<T>>();
  let closed = false;

  async function get(cwd: string): Promise<T> {
    const cached = byCwd.get(cwd);
    if (cached) return cached;

    const inFlight = pending.get(cwd);
    if (inFlight) return inFlight;

    const promise = (async () => {
      const manager = await factory(cwd);
      if (closed) {
        // A quit landed while we were connecting; don't leak the connections.
        await manager.shutdown().catch(() => {});
        throw new Error('Manager cache is closed');
      }
      byCwd.set(cwd, manager);
      return manager;
    })().finally(() => {
      pending.delete(cwd);
    });

    pending.set(cwd, promise);
    return promise;
  }

  async function closeAll(): Promise<void> {
    closed = true;
    const managers = [...byCwd.values()];
    byCwd.clear();
    pending.clear();
    await Promise.all(managers.map((m) => m.shutdown().catch(() => {})));
  }

  return { get, closeAll, size: () => byCwd.size };
}
