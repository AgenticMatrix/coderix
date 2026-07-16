/**
 * Teammate utilities — identity resolution for agent swarm coordination.
 *
 * Priority order:
 * 1. AsyncLocalStorage (in-process teammates) — via teammateContext.ts
 * 2. dynamicTeamContext (tmux teammates via CLI args)
 * 3. Environment variables
 */

// Re-export in-process teammate utilities
export {
  createTeammateContext,
  getTeammateContext,
  isInProcessTeammate,
  runWithTeammateContext,
  type TeammateContext,
} from './teammateContext.js';

import { getTeammateContext } from './teammateContext.js';

// ---------------------------------------------------------------------------
// Dynamic team context (module-level singleton for tmux/pane teammates)
// ---------------------------------------------------------------------------

let dynamicTeamContext: {
  agentId: string;
  agentName: string;
  teamName: string;
  color?: string;
  planModeRequired: boolean;
  parentSessionId?: string;
} | null = null;

export function setDynamicTeamContext(
  context: {
    agentId: string;
    agentName: string;
    teamName: string;
    color?: string;
    planModeRequired: boolean;
    parentSessionId?: string;
  } | null,
): void {
  dynamicTeamContext = context;
}

export function clearDynamicTeamContext(): void {
  dynamicTeamContext = null;
}

export function getDynamicTeamContext(): typeof dynamicTeamContext {
  return dynamicTeamContext;
}

// ---------------------------------------------------------------------------
// Identity resolution (priority: AsyncLocalStorage → dynamicTeamContext → env)
// ---------------------------------------------------------------------------

export function getAgentId(): string | undefined {
  const ctx = getTeammateContext();
  if (ctx) return ctx.agentId;
  return dynamicTeamContext?.agentId ?? process.env.CODERIX_AGENT_ID;
}

export function getAgentName(): string | undefined {
  const ctx = getTeammateContext();
  if (ctx) return ctx.agentName;
  return dynamicTeamContext?.agentName ?? process.env.CODERIX_AGENT_NAME;
}

export function getTeamName(): string | undefined {
  const ctx = getTeammateContext();
  if (ctx) return ctx.teamName;
  return dynamicTeamContext?.teamName ?? process.env.CODERIX_TEAM_NAME;
}

export function getTeammateColor(): string | undefined {
  const ctx = getTeammateContext();
  if (ctx) return ctx.color;
  return dynamicTeamContext?.color ?? process.env.CODERIX_AGENT_COLOR;
}

export function getParentSessionId(): string | undefined {
  const ctx = getTeammateContext();
  if (ctx) return ctx.parentSessionId;
  return dynamicTeamContext?.parentSessionId;
}

export function isTeammate(): boolean {
  const ctx = getTeammateContext();
  if (ctx) return true;
  return !!(dynamicTeamContext?.agentId && dynamicTeamContext?.teamName);
}

export function isPlanModeRequired(): boolean {
  const ctx = getTeammateContext();
  if (ctx) return ctx.planModeRequired;
  if (dynamicTeamContext) return dynamicTeamContext.planModeRequired;
  return process.env.CODERIX_PLAN_MODE_REQUIRED === 'true';
}

// ---------------------------------------------------------------------------
// Team lead detection
// ---------------------------------------------------------------------------

export function isTeamLead(
  teamContext: { leadAgentId: string } | undefined,
): boolean {
  if (!teamContext?.leadAgentId) return false;
  const myAgentId = getAgentId();
  if (myAgentId === teamContext.leadAgentId) return true;
  // Backwards compat: no agent ID set = original session that created the team
  if (!myAgentId) return true;
  return false;
}
