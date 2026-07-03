/**
 * Agent persistence — disk helpers for cross-session agent resume.
 *
 * Shared between the Agent tool executor and the SendMessage tool executor.
 * Stores agent metadata and transcripts under ~/.coderix/agents/{agentId}/.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Message } from '../core/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentMetadata {
  agentType: string;
  worktreePath?: string;
  /** Short human-readable label shown in the Agents panel. */
  displayDescription?: string;
  /** Full task prompt (stored for cross-session resume). */
  description?: string;
  model?: string;
  createdAt: number;
  finishedAt?: number;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function agentDir(agentId: string): string {
  return join(homedir(), '.coderix', 'agents', agentId);
}

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

export async function writeAgentMetadata(agentId: string, meta: AgentMetadata): Promise<void> {
  const dir = agentDir(agentId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'metadata.json'), JSON.stringify(meta, null, 2));
}

export async function readAgentMetadata(agentId: string): Promise<AgentMetadata | null> {
  try {
    const raw = await readFile(join(agentDir(agentId), 'metadata.json'), 'utf-8');
    return JSON.parse(raw) as AgentMetadata;
  } catch {
    return null;
  }
}

export async function getAgentTranscript(agentId: string): Promise<Message[] | null> {
  try {
    const raw = await readFile(join(agentDir(agentId), 'transcript.json'), 'utf-8');
    return JSON.parse(raw) as Message[];
  } catch {
    return null;
  }
}

export async function saveAgentTranscript(agentId: string, transcript: Message[]): Promise<void> {
  const dir = agentDir(agentId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'transcript.json'), JSON.stringify(transcript));
}
