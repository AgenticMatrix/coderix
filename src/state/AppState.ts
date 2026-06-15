import type { AppConfig, ChatState } from '../types.js';
import type { TrackedTask } from '../tasks/task-tracker.js';
import type { SubAgentRecord } from '../core/subagent-registry.js';
import type { DeferredPermission } from '../core/types.js';
import type { ApprovalRequest } from '../types.js';

/**
 * Pending permission approval request (formerly in approval-store.ts singleton).
 */
export interface PendingApproval {
  toolName: string;
  command: string;
  description: string;
  toolUseId: string;
  deferred: DeferredPermission;
}

/**
 * Unified application state — the single source of truth for the TUI session.
 *
 * ChatState fields are flattened directly into AppState (no `ui` wrapper).
 * The chatReducer continues as the source of truth for the UI; AppState
 * mirrors it field-by-field via a sync effect in App.tsx.
 */
export interface AppState extends ChatState {
  /** Session-level app configuration (loaded once at startup). */
  config: AppConfig;

  /** Session ID from SessionManager. */
  sessionId: string;

  /** Pending permission approval request (replaces approval-store singleton). */
  pendingApproval: PendingApproval | null;

  /** Background tasks keyed by task ID (dual-write from task-tracker). */
  backgroundTasks: Record<string, TrackedTask>;

  /** Running sub-agents keyed by agent ID (dual-write from SubAgentRegistry). */
  agents: Record<string, SubAgentRecord>;
}

export function getDefaultAppState(config: AppConfig, initialChat: ChatState, sessionId: string): AppState {
  return {
    ...initialChat,
    config,
    sessionId,
    pendingApproval: null,
    backgroundTasks: {},
    agents: {},
  };
}
