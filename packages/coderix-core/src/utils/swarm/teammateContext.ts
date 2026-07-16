/**
 * TeammateContext - Runtime context for in-process teammates
 *
 * This module provides AsyncLocalStorage-based context for in-process teammates,
 * enabling concurrent teammate execution without global state conflicts.
 *
 * Priority order for identity resolution:
 * 1. AsyncLocalStorage (in-process teammates) - via this module
 * 2. dynamicTeamContext (tmux teammates via CLI args)
 * 3. Environment variables (CODERIX_AGENT_ID, etc.)
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface TeammateContext {
  /** Full agent ID, e.g. "researcher@my-team" */
  agentId: string;
  /** Display name, e.g. "researcher" */
  agentName: string;
  /** Team name this teammate belongs to */
  teamName: string;
  /** UI color assigned to this teammate */
  color?: string;
  /** Whether teammate must enter plan mode before implementing */
  planModeRequired: boolean;
  /** Leader's session ID (for transcript correlation) */
  parentSessionId: string;
  /** Discriminator — always true for in-process teammates */
  isInProcess: true;
  /** Abort controller for lifecycle management */
  abortController: AbortController;
}

const teammateContextStorage = new AsyncLocalStorage<TeammateContext>();

/** Get the current in-process teammate context, if running as one. */
export function getTeammateContext(): TeammateContext | undefined {
  return teammateContextStorage.getStore();
}

/** Run a function with teammate context set. */
export function runWithTeammateContext<T>(
  context: TeammateContext,
  fn: () => T,
): T {
  return teammateContextStorage.run(context, fn);
}

/** Check if current execution is within an in-process teammate. */
export function isInProcessTeammate(): boolean {
  return teammateContextStorage.getStore() !== undefined;
}

/** Create a TeammateContext from spawn configuration. */
export function createTeammateContext(config: {
  agentId: string;
  agentName: string;
  teamName: string;
  color?: string;
  planModeRequired: boolean;
  parentSessionId: string;
  abortController: AbortController;
}): TeammateContext {
  return {
    ...config,
    isInProcess: true,
  };
}
