import type { AppConfig, ChatState } from '../types.js';
import type { TrackedTask } from '@coderix/core';
import type { SubAgentRecord } from '@coderix/core';
import type { DeferredPermission, DeferredQuestion } from '@coderix/core';
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
 * Pending user question (ask-user-question tool blocking).
 */
export interface PendingQuestion {
  toolName: string;
  toolUseId: string;
  questions: DeferredQuestion['questions'];
  deferred: DeferredQuestion;
}

/**
 * Pending team permission approval — a worker agent is requesting
 * permission to run a tool. Routes through the leader's mailbox.
 */
export interface TeamApprovalRequest {
  requestId: string;
  workerName: string;
  workerId: string;
  teamName: string;
  toolName: string;
  toolUseId: string;
  description: string;
  command?: string;
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

  /** Pending user question (ask-user-question tool). */
  pendingQuestion: PendingQuestion | null;

  /** Pending team permission approval from a worker agent. */
  teamApprovalReq: TeamApprovalRequest | null;

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
    pendingQuestion: null,
    teamApprovalReq: null,
    backgroundTasks: {},
    agents: {},
  };
}
