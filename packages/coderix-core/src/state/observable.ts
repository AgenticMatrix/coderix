/**
 * Observable / EventBus — Reactive event stream for core-to-frontend communication.
 *
 * Replaces the `Store<AppState>` injection pattern. The engine emits
 * EngineEvent objects on an Observable; each frontend subscribes and
 * translates events into its own state management.
 *
 * Tool state mutations (background tasks, sub-agents) flow through
 * ToolRequestEvent on a separate Observable so frontends can mediate
 * the writes into their own state stores.
 */

// ── Observable ──────────────────────────────────────────────────────────

export interface Observer<T> {
  next(value: T): void;
  error?(err: Error): void;
  complete?(): void;
}

export interface Observable<T> {
  subscribe(observer: Observer<T>): () => void;
}

export interface Subject<T> extends Observer<T>, Observable<T> {}

// ── Event types ─────────────────────────────────────────────────────────

export interface EngineEvent {
  type: 'message' | 'error' | 'cost' | 'compact' | 'done' | 'permission_required' | 'question_required' | 'queued';
  data?: unknown;
  deferred?: unknown;
}

export type ToolRequestEvent =
  | { type: 'background_task_update'; taskId: string; task: Record<string, unknown>; requestId: string }
  | { type: 'background_task_remove'; taskId: string; requestId: string }
  | { type: 'agent_register'; agentId: string; agent: Record<string, unknown>; requestId: string }
  | { type: 'agent_update'; agentId: string; agent: Record<string, unknown>; requestId: string }
  | { type: 'agent_remove'; agentId: string; requestId: string };

// ── EventBus ────────────────────────────────────────────────────────────

export interface EventBus {
  engineEvents: Subject<EngineEvent>;
  toolRequests: Subject<ToolRequestEvent>;
  respondToTool(requestId: string, response: unknown): void;
}

// ── Factory ─────────────────────────────────────────────────────────────

export function createSubject<T>(): Subject<T> {
  const observers = new Set<Observer<T>>();

  const observable: Observable<T> = {
    subscribe(observer: Observer<T>): () => void {
      observers.add(observer);
      return () => {
        observers.delete(observer);
      };
    },
  };

  const observer: Observer<T> = {
    next(value: T): void {
      for (const obs of observers) {
        try {
          obs.next(value);
        } catch {
          // swallow errors from individual observers
        }
      }
    },
    error(err: Error): void {
      for (const obs of observers) {
        obs.error?.(err);
      }
    },
    complete(): void {
      for (const obs of observers) {
        obs.complete?.();
      }
      observers.clear();
    },
  };

  const subject = observer as Subject<T>;
  (subject as unknown as { subscribe: typeof observable.subscribe }).subscribe = observable.subscribe.bind(observable);
  return subject;
}

export function createEventBus(): EventBus {
  const toolResponses = new Map<string, (response: unknown) => void>();

  return {
    engineEvents: createSubject<EngineEvent>(),
    toolRequests: createSubject<ToolRequestEvent>(),
    respondToTool(requestId: string, response: unknown): void {
      const resolve = toolResponses.get(requestId);
      if (resolve) {
        toolResponses.delete(requestId);
        resolve(response);
      }
    },
  };
}
