/**
 * Generic publish/subscribe store with immutable update semantics.
 *
 * Modeled after claude-code-best's createStore — a non-React, framework-
 * agnostic state container.  React consumers use useSyncExternalStore via
 * AppStateContext; pure-TS consumers (tools, agents) call getState/setState
 * directly through injected references.
 */
export interface Store<T> {
  getState(): T;
  setState(partial: Partial<T>): void;
  subscribe(listener: (state: T) => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<(s: T) => void>();

  return {
    getState: () => state,

    setState(partial) {
      const next = { ...state, ...partial } as T;
      if (Object.is(next, state)) return;
      state = next;
      for (const fn of listeners) fn(state);
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
