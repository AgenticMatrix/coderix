/**
 * CoreEventBridge — Subscribes to EventBus and syncs engine events
 * and tool requests into the TUI's AppState store.
 *
 * Phase 3 dual-write bridge. When Phase 4 removes appStore from Core,
 * this becomes the sole path for engine→UI state sync.
 */

import type { EventBus, EngineEvent, ToolRequestEvent } from '@coderix/core';
import type { Store } from './store.js';
import type { AppState } from './AppState.js';
import type { TrackedTask } from '@coderix/core';
import type { SubAgentRecord } from '@coderix/core';

export interface CoreEventBridge {
  /** Unsubscribe from all event streams. */
  destroy(): void;
}

export function createCoreEventBridge(
  eventBus: EventBus,
  store: Store<AppState>,
): CoreEventBridge {
  const unsubEngine = eventBus.engineEvents.subscribe({
    next(event: EngineEvent) {
      switch (event.type) {
        case 'done': {
          const data = event.data as { sessionId?: string } | undefined;
          if (data?.sessionId) {
            store.setState({ sessionId: data.sessionId } as Partial<AppState>);
          }
          break;
        }
        case 'error':
        case 'message':
        case 'cost':
        case 'compact':
        case 'permission_required':
        case 'question_required':
          // Engine events are consumed by the AsyncGenerator path for now.
          // In Phase 4, these will be the primary event source for the TUI.
          break;
      }
    },
    error(_err: Error) {
      // Engine event stream errors are non-fatal for the bridge
    },
  });

  const unsubTools = eventBus.toolRequests.subscribe({
    next(req: ToolRequestEvent) {
      const current = store.getState();

      switch (req.type) {
        case 'background_task_update': {
          const tasks = { ...current.backgroundTasks };
          tasks[req.taskId] = { ...tasks[req.taskId], ...req.task } as TrackedTask;
          store.setState({ backgroundTasks: tasks } as Partial<AppState>);
          break;
        }
        case 'background_task_remove': {
          const tasks = { ...current.backgroundTasks };
          delete tasks[req.taskId];
          store.setState({ backgroundTasks: tasks } as Partial<AppState>);
          break;
        }
        case 'agent_register': {
          const agents = { ...current.agents };
          agents[req.agentId] = req.agent as unknown as SubAgentRecord;
          store.setState({ agents } as Partial<AppState>);
          break;
        }
        case 'agent_update': {
          const agents = { ...current.agents };
          agents[req.agentId] = { ...agents[req.agentId], ...req.agent } as SubAgentRecord;
          store.setState({ agents } as Partial<AppState>);
          break;
        }
        case 'agent_remove': {
          const agents = { ...current.agents };
          delete agents[req.agentId];
          store.setState({ agents } as Partial<AppState>);
          break;
        }
      }
    },
    error(_err: Error) {
      // Tool request stream errors are non-fatal
    },
  });

  return {
    destroy() {
      unsubEngine();
      unsubTools();
    },
  };
}
