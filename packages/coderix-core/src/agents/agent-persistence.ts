/**
 * Agent persistence — disk helpers for cross-session agent resume.
 *
 * Shared between the Agent tool executor and the SendMessage tool executor.
 *
 * Storage layout:
 *   <sessionDir>/subagents/<agent-id>/
 *     transcript.jsonl              # Sub-agent transcript (JSONL, append-only)
 *     system_prompt.md              # Agent's system prompt
 *     meta.json                     # Agent metadata
 *
 * Team agent storage:
 *   <sessionDir>/teams/<team-name>/<agent-id>/
 *     transcript.jsonl              # Sub-agent transcript
 *     system_prompt.md              # Agent's system prompt
 *     meta.json                     # TeamAgentMetadata (extends AgentMetadata)
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Message, SessionEntry } from '../core/types.js';
import {
  readEntries,
  rewriteEntries,
  entriesToMessages,
} from '../core/session-store.js';
import { sanitizeTeamName } from '../teams/team-store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentMetadata {
  agentType: string;
  model?: string;
  createdAt: number;
  finishedAt?: number;
  /** Short human-readable label shown in the Agents panel. */
  displayDescription?: string;
  /** Full task prompt (stored for cross-session resume). */
  description?: string;
  /** Path to the worktree directory (if worktree isolation was used). */
  worktreePath?: string;
  /** Tool names that were allowed for this agent. */
  allowedTools?: string[];
  /** Tool names that were explicitly disallowed for this agent. */
  disallowedTools?: string[];
  /** Permission mode used. */
  permissionMode?: string;
  /** Max turns the agent was allowed. */
  maxTurns?: number;
  /** Context budget in tokens. */
  contextBudget?: number;
}

export interface TeamAgentMetadata extends AgentMetadata {
  /** Team name this agent belongs to. */
  teamName: string;
  /** Human-readable member name within the team. */
  memberName: string;
  /** Brief description of the assigned task. */
  task?: string;
  /** TUI display color. */
  color?: string;
  /** Unix timestamp (ms) when the member joined the team. */
  joinedAt: number;
}

// ---------------------------------------------------------------------------
// Paths — Regular sub-agents (session-relative)
// ---------------------------------------------------------------------------

/** Regular sub-agent directory: <sessionDir>/subagents/<agent-id>/ */
export function agentDir(sessionDir: string, agentId: string): string {
  return join(sessionDir, 'subagents', agentId);
}

export function agentTranscriptPath(sessionDir: string, agentId: string): string {
  return join(agentDir(sessionDir, agentId), 'transcript.jsonl');
}

export function agentMetaPath(sessionDir: string, agentId: string): string {
  return join(agentDir(sessionDir, agentId), 'meta.json');
}

export function agentSystemPromptPath(sessionDir: string, agentId: string): string {
  return join(agentDir(sessionDir, agentId), 'system_prompt.md');
}

// ---------------------------------------------------------------------------
// Paths — Team sub-agents
// ---------------------------------------------------------------------------

/** Team sub-agent directory: <sessionDir>/teams/<team-name>/<agent-id>/ */
export function teamAgentDir(sessionDir: string, teamName: string, agentId: string): string {
  return join(sessionDir, 'teams', sanitizeTeamName(teamName), agentId);
}

export function teamAgentTranscriptPath(sessionDir: string, teamName: string, agentId: string): string {
  return join(teamAgentDir(sessionDir, teamName, agentId), 'transcript.jsonl');
}

export function teamAgentMetaPath(sessionDir: string, teamName: string, agentId: string): string {
  return join(teamAgentDir(sessionDir, teamName, agentId), 'meta.json');
}

export function teamAgentSystemPromptPath(sessionDir: string, teamName: string, agentId: string): string {
  return join(teamAgentDir(sessionDir, teamName, agentId), 'system_prompt.md');
}

// ---------------------------------------------------------------------------
// Read / Write — Metadata (regular sub-agents)
// ---------------------------------------------------------------------------

export async function writeAgentMetadata(
  agentId: string,
  meta: AgentMetadata,
  sessionDir: string,
): Promise<void> {
  const dir = agentDir(sessionDir, agentId);
  await mkdir(dir, { recursive: true });
  await writeFile(agentMetaPath(sessionDir, agentId), JSON.stringify(meta, null, 2));
}

export async function readAgentMetadata(
  agentId: string,
  sessionDir: string,
): Promise<AgentMetadata | null> {
  try {
    const raw = await readFile(agentMetaPath(sessionDir, agentId), 'utf-8');
    return JSON.parse(raw) as AgentMetadata;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Read / Write — Metadata (team sub-agents)
// ---------------------------------------------------------------------------

export async function writeTeamAgentMetadata(
  agentId: string,
  meta: TeamAgentMetadata,
  sessionDir: string,
  teamName: string,
): Promise<void> {
  const dir = teamAgentDir(sessionDir, teamName, agentId);
  await mkdir(dir, { recursive: true });
  await writeFile(teamAgentMetaPath(sessionDir, teamName, agentId), JSON.stringify(meta, null, 2));
}

export async function readTeamAgentMetadata(
  agentId: string,
  sessionDir: string,
  teamName: string,
): Promise<TeamAgentMetadata | null> {
  try {
    const raw = await readFile(teamAgentMetaPath(sessionDir, teamName, agentId), 'utf-8');
    return JSON.parse(raw) as TeamAgentMetadata;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Read / Write — Transcript (regular sub-agents)
// ---------------------------------------------------------------------------

/**
 * Save a sub-agent transcript to JSONL format in the per-agent directory.
 * Each message becomes a transcript entry with uuid + parentUuid chain.
 */
export async function saveAgentTranscript(
  agentId: string,
  transcript: Message[],
  sessionDir: string,
): Promise<void> {
  const entries: SessionEntry[] = [];
  let prevUuid: string | null = null;

  for (const msg of transcript) {
    const uuid = randomUUID();
    entries.push({
      type: msg.role as 'user' | 'assistant' | 'system',
      uuid,
      parentUuid: prevUuid,
      timestamp: Date.now(),
      message: msg,
    } as SessionEntry);
    prevUuid = uuid;
  }

  const path = agentTranscriptPath(sessionDir, agentId);
  await rewriteEntries(path, entries);
}

/**
 * Load a sub-agent transcript from the per-agent directory.
 */
export async function getAgentTranscript(
  agentId: string,
  sessionDir: string,
): Promise<Message[] | null> {
  const path = agentTranscriptPath(sessionDir, agentId);
  if (!existsSync(path)) return null;

  try {
    const entries = await readEntries(path);
    if (entries.length > 0) {
      return entriesToMessages(entries);
    }
  } catch {
    // File corrupted
  }
  return null;
}

/**
 * Synchronous version of getAgentTranscript for contexts that can't await.
 */
export function getAgentTranscriptSync(
  agentId: string,
  sessionDir: string,
): Message[] | null {
  const path = agentTranscriptPath(sessionDir, agentId);
  if (!existsSync(path)) return null;

  try {
    const raw = readFileSync(path, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim());
    const entries: SessionEntry[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as SessionEntry);
      } catch { /* skip corrupted */ }
    }
    if (entries.length > 0) {
      return entriesToMessages(entries);
    }
  } catch {
    // File unreadable
  }
  return null;
}

// ---------------------------------------------------------------------------
// Read / Write — Transcript (team sub-agents)
// ---------------------------------------------------------------------------

export async function saveTeamAgentTranscript(
  agentId: string,
  transcript: Message[],
  sessionDir: string,
  teamName: string,
): Promise<void> {
  const entries: SessionEntry[] = [];
  let prevUuid: string | null = null;

  for (const msg of transcript) {
    const uuid = randomUUID();
    entries.push({
      type: msg.role as 'user' | 'assistant' | 'system',
      uuid,
      parentUuid: prevUuid,
      timestamp: Date.now(),
      message: msg,
    } as SessionEntry);
    prevUuid = uuid;
  }

  const path = teamAgentTranscriptPath(sessionDir, teamName, agentId);
  await rewriteEntries(path, entries);
}

export async function getTeamAgentTranscript(
  agentId: string,
  sessionDir: string,
  teamName: string,
): Promise<Message[] | null> {
  const path = teamAgentTranscriptPath(sessionDir, teamName, agentId);
  if (!existsSync(path)) return null;

  try {
    const entries = await readEntries(path);
    if (entries.length > 0) {
      return entriesToMessages(entries);
    }
  } catch {
    // File corrupted
  }
  return null;
}

// ---------------------------------------------------------------------------
// System prompt persistence
// ---------------------------------------------------------------------------

/**
 * Write the sub-agent's system prompt to its per-agent directory.
 * Best-effort, synchronous — mirrors SessionManager.writeSystemPrompt().
 */
export function writeAgentSystemPrompt(
  sessionDir: string,
  agentId: string,
  text: string,
): void {
  try {
    const dir = agentDir(sessionDir, agentId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(agentSystemPromptPath(sessionDir, agentId), text, 'utf-8');
  } catch { /* best-effort */ }
}

export function writeTeamAgentSystemPrompt(
  sessionDir: string,
  teamName: string,
  agentId: string,
  text: string,
): void {
  try {
    const dir = teamAgentDir(sessionDir, teamName, agentId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(teamAgentSystemPromptPath(sessionDir, teamName, agentId), text, 'utf-8');
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Unified disk lookup — finds an agent across both regular and team paths
// ---------------------------------------------------------------------------

export interface DiskAgentInfo {
  meta: AgentMetadata;
  transcript: Message[];
  systemPrompt?: string;
  /** Present when the agent is a team member. */
  teamName?: string;
}

/**
 * Find an agent on disk by scanning both regular sub-agent paths and
 * team agent directories. Returns metadata, transcript, and optional
 * teamName so callers can reconstruct the agent regardless of type.
 */
export async function findAgentOnDisk(
  agentId: string,
  sessionDir: string,
): Promise<DiskAgentInfo | null> {
  // 1. Try regular sub-agent path
  const regularMeta = await readAgentMetadata(agentId, sessionDir);
  if (regularMeta) {
    const transcript = await getAgentTranscript(agentId, sessionDir);
    if (transcript) {
      let systemPrompt: string | undefined;
      try {
        systemPrompt = await readFile(agentSystemPromptPath(sessionDir, agentId), 'utf-8');
      } catch { /* optional */ }
      return { meta: regularMeta, transcript, systemPrompt };
    }
  }

  // 2. Scan team directories
  try {
    const { listTeams } = await import('../teams/team-store.js');
    const teams = await listTeams(sessionDir);
    for (const teamName of teams) {
      const teamMeta = await readTeamAgentMetadata(agentId, sessionDir, teamName);
      if (teamMeta) {
        const transcript = await getTeamAgentTranscript(agentId, sessionDir, teamName);
        if (transcript) {
          let systemPrompt: string | undefined;
          try {
            systemPrompt = await readFile(
              teamAgentSystemPromptPath(sessionDir, teamName, agentId),
              'utf-8',
            );
          } catch { /* optional */ }
          return { meta: teamMeta, transcript, systemPrompt, teamName };
        }
      }
    }
  } catch { /* best-effort */ }

  return null;
}
