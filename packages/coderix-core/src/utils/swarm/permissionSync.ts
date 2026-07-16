/**
 * Permission synchronization for agent swarms.
 *
 * Provides infrastructure for coordinating permission prompts between
 * worker agents and the team leader. Workers send permission requests
 * to the leader's mailbox; the leader responds with approval/denial.
 *
 * Flow:
 * 1. Worker encounters a permission prompt for a tool
 * 2. Worker sends a `permission_request` message to the leader's mailbox
 * 3. Leader's inbox poller detects the request and presents it to the user
 * 4. User approves/denies via the leader's UI
 * 5. Leader sends a `permission_response` message to the worker's mailbox
 * 6. Worker picks up the response and continues execution
 */

import { mkdir, writeFile, readFile, unlink, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod/v4';

import {
  createPermissionRequestMessage,
  createPermissionResponseMessage,
  createSandboxPermissionRequestMessage,
  createSandboxPermissionResponseMessage,
  writeToMailbox,
} from './teammateMailbox.js';
import { getAgentId, getAgentName, getTeammateColor } from './teammate.js';
import { TEAM_LEAD_NAME } from './constants.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const SwarmPermissionRequestSchema = z.object({
  id: z.string(),
  workerId: z.string(),
  workerName: z.string(),
  workerColor: z.string().optional(),
  teamName: z.string(),
  toolName: z.string(),
  toolUseId: z.string(),
  description: z.string(),
  input: z.record(z.string(), z.unknown()),
  permissionSuggestions: z.array(z.unknown()),
  status: z.enum(['pending', 'approved', 'rejected']),
  resolvedBy: z.enum(['worker', 'leader']).optional(),
  resolvedAt: z.number().optional(),
  feedback: z.string().optional(),
  updatedInput: z.record(z.string(), z.unknown()).optional(),
  permissionUpdates: z.array(z.unknown()).optional(),
  createdAt: z.number(),
});

export type SwarmPermissionRequest = z.infer<typeof SwarmPermissionRequestSchema>;

export interface PermissionResolution {
  decision: 'approved' | 'rejected';
  resolvedBy: 'worker' | 'leader';
  feedback?: string;
  updatedInput?: Record<string, unknown>;
  permissionUpdates?: Array<{
    type: string;
    rules?: Array<{ toolName: string; ruleContent?: string }>;
    behavior?: string;
    destination?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

const TEAMS_DIR = join(homedir(), '.coderix', 'teams');
const sanitizeName = (name: string) =>
  name.replace(/[^a-zA-Z0-9_-]/g, '-');

export function getPermissionDir(teamName: string): string {
  return join(TEAMS_DIR, sanitizeName(teamName), 'permissions');
}

function getPendingDir(teamName: string): string {
  return join(getPermissionDir(teamName), 'pending');
}

function getResolvedDir(teamName: string): string {
  return join(getPermissionDir(teamName), 'resolved');
}

function getPendingRequestPath(teamName: string, requestId: string): string {
  return join(getPendingDir(teamName), `${requestId}.json`);
}

function getResolvedRequestPath(teamName: string, requestId: string): string {
  return join(getResolvedDir(teamName), `${requestId}.json`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function generateRequestId(): string {
  return `perm-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

export function getLeaderName(): string {
  return TEAM_LEAD_NAME;
}

export function isTeamLeader(
  teamContext: { leadAgentId: string } | undefined,
): boolean {
  if (!teamContext?.leadAgentId) return false;
  const myAgentId = getAgentId();
  if (myAgentId === teamContext.leadAgentId) return true;
  if (!myAgentId) return true;
  return false;
}

export function isSwarmWorker(): boolean {
  return !!(getAgentId() && getAgentName());
}

// ---------------------------------------------------------------------------
// Create & write permission requests
// ---------------------------------------------------------------------------

export function createPermissionRequest(params: {
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  description: string;
  permissionSuggestions?: unknown[];
  teamName?: string;
  workerId?: string;
  workerName?: string;
  workerColor?: string;
}): SwarmPermissionRequest {
  const teamName = params.teamName || process.env.CODERIX_TEAM_NAME;
  const workerId = params.workerId || getAgentId();
  const workerName = params.workerName || getAgentName();
  const workerColor = params.workerColor || getTeammateColor();

  if (!teamName) throw new Error('Team name is required for permission requests');
  if (!workerId) throw new Error('Worker ID is required for permission requests');
  if (!workerName) throw new Error('Worker name is required for permission requests');

  return {
    id: generateRequestId(),
    workerId,
    workerName,
    workerColor,
    teamName,
    toolName: params.toolName,
    toolUseId: params.toolUseId,
    description: params.description,
    input: params.input,
    permissionSuggestions: params.permissionSuggestions || [],
    status: 'pending',
    createdAt: Date.now(),
  };
}

export async function writePermissionRequest(
  request: SwarmPermissionRequest,
): Promise<void> {
  const pendingDir = getPendingDir(request.teamName);
  await mkdir(pendingDir, { recursive: true });
  const path = getPendingRequestPath(request.teamName, request.id);
  await writeFile(path, JSON.stringify(request, null, 2), 'utf-8');
}

export async function readPendingPermissions(
  teamName: string,
): Promise<SwarmPermissionRequest[]> {
  const pendingDir = getPendingDir(teamName);
  try {
    const files = await readdir(pendingDir);
    const requests: SwarmPermissionRequest[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = await readFile(join(pendingDir, file), 'utf-8');
        const parsed = SwarmPermissionRequestSchema.parse(JSON.parse(raw));
        requests.push(parsed);
      } catch { /* skip corrupt files */ }
    }
    return requests;
  } catch {
    return [];
  }
}

export async function resolvePermission(
  teamName: string,
  requestId: string,
  resolution: PermissionResolution,
): Promise<void> {
  const pendingPath = getPendingRequestPath(teamName, requestId);
  const resolvedDir = getResolvedDir(teamName);
  const resolvedPath = getResolvedRequestPath(teamName, requestId);

  await mkdir(resolvedDir, { recursive: true });

  try {
    const raw = await readFile(pendingPath, 'utf-8');
    const request = SwarmPermissionRequestSchema.parse(JSON.parse(raw));
    const resolved: SwarmPermissionRequest = {
      ...request,
      status: resolution.decision === 'approved' ? 'approved' : 'rejected',
      resolvedBy: resolution.resolvedBy,
      resolvedAt: Date.now(),
      feedback: resolution.feedback,
      updatedInput: resolution.updatedInput,
      permissionUpdates: resolution.permissionUpdates,
    };
    await writeFile(resolvedPath, JSON.stringify(resolved, null, 2), 'utf-8');
    await unlink(pendingPath);
  } catch {
    // Request already resolved or gone
  }
}

export async function cleanupOldResolutions(
  teamName: string,
  maxAgeMs = 60 * 60 * 1000,
): Promise<void> {
  const resolvedDir = getResolvedDir(teamName);
  try {
    const files = await readdir(resolvedDir);
    const cutoff = Date.now() - maxAgeMs;
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const path = join(resolvedDir, file);
      try {
        const stat = await import('node:fs/promises').then(m => m.stat(path));
        if (stat.mtimeMs < cutoff) await unlink(path);
      } catch { /* skip */ }
    }
  } catch { /* dir doesn't exist */ }
}

// ---------------------------------------------------------------------------
// Mailbox-based permission messaging
// ---------------------------------------------------------------------------

export async function sendPermissionRequestViaMailbox(
  request: SwarmPermissionRequest,
): Promise<void> {
  const leaderName = getLeaderName();
  const message = createPermissionRequestMessage({
    request_id: request.id,
    agent_id: request.workerId,
    tool_name: request.toolName,
    tool_use_id: request.toolUseId,
    description: request.description,
    input: request.input,
    permission_suggestions: request.permissionSuggestions as Array<{
      toolName: string;
      ruleContent?: string;
    }>,
  });
  await writeToMailbox(leaderName, {
    from: request.workerName,
    text: JSON.stringify(message),
    timestamp: new Date().toISOString(),
    color: request.workerColor,
  });
}

export async function sendPermissionResponseViaMailbox(
  workerName: string,
  requestId: string,
  resolution: PermissionResolution,
  teamName?: string,
): Promise<void> {
  const message = createPermissionResponseMessage({
    request_id: requestId,
    subtype: resolution.decision === 'approved' ? 'success' : 'error',
    error: resolution.feedback,
    updated_input: resolution.updatedInput,
    permission_updates: resolution.permissionUpdates,
  });
  await writeToMailbox(workerName, {
    from: getLeaderName(),
    text: JSON.stringify(message),
    timestamp: new Date().toISOString(),
  });
}

export async function sendSandboxPermissionRequestViaMailbox(params: {
  requestId: string;
  workerId: string;
  workerName: string;
  workerColor?: string;
  host: string;
}): Promise<void> {
  const message = createSandboxPermissionRequestMessage(params);
  await writeToMailbox(getLeaderName(), {
    from: params.workerName,
    text: JSON.stringify(message),
    timestamp: new Date().toISOString(),
    color: params.workerColor,
  });
}

export async function sendSandboxPermissionResponseViaMailbox(
  workerName: string,
  params: {
    requestId: string;
    host: string;
    allow: boolean;
  },
): Promise<void> {
  const message = createSandboxPermissionResponseMessage(params);
  await writeToMailbox(workerName, {
    from: getLeaderName(),
    text: JSON.stringify(message),
    timestamp: new Date().toISOString(),
  });
}
