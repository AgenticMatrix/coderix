/**
 * Agent persistence — disk helpers for cross-session agent resume.
 *
 * Shared between the Agent tool executor and the SendMessage tool executor.
 *
 * Storage layout (v2 — session-relative):
 *   ~/.coderix/sessions/<uuid>/subagents/
 *     agent-<id>.jsonl              # Sub-agent transcript (JSONL, append-only)
 *     agent-<id>-meta.json          # Sub-agent metadata
 *
 * Legacy layout (v1 — still supported for reads):
 *   ~/.coderix/agents/<id>/
 *     transcript.json
 *     metadata.json
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Message, SessionEntry } from '../core/types.js';
import {
  subAgentDir,
  subAgentJsonlPath,
  readEntries,
  rewriteEntries,
  entriesToMessages,
} from '../core/session-store.js';

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

/** Legacy agent directory: ~/.coderix/agents/<agentId>/ */
export function agentDir(agentId: string): string {
  return join(homedir(), '.coderix', 'agents', agentId);
}

function agentMetaPath(sessionDir: string, agentId: string): string {
  return join(subAgentDir(sessionDir), `agent-${agentId}-meta.json`);
}

function legacyMetaPath(agentId: string): string {
  return join(agentDir(agentId), 'metadata.json');
}

function legacyTranscriptPath(agentId: string): string {
  return join(agentDir(agentId), 'transcript.json');
}

// ---------------------------------------------------------------------------
// Read / Write — Metadata
// ---------------------------------------------------------------------------

export async function writeAgentMetadata(
  agentId: string,
  meta: AgentMetadata,
  sessionDir?: string,
): Promise<void> {
  if (sessionDir) {
    const dir = subAgentDir(sessionDir);
    await mkdir(dir, { recursive: true });
    await writeFile(agentMetaPath(sessionDir, agentId), JSON.stringify(meta, null, 2));
  } else {
    const dir = agentDir(agentId);
    await mkdir(dir, { recursive: true });
    await writeFile(legacyMetaPath(agentId), JSON.stringify(meta, null, 2));
  }
}

export async function readAgentMetadata(
  agentId: string,
  sessionDir?: string,
): Promise<AgentMetadata | null> {
  // Try session-relative path first
  if (sessionDir) {
    try {
      const raw = await readFile(agentMetaPath(sessionDir, agentId), 'utf-8');
      return JSON.parse(raw) as AgentMetadata;
    } catch {
      // Fall through to legacy
    }
  }

  // Fallback: legacy path
  try {
    const raw = await readFile(legacyMetaPath(agentId), 'utf-8');
    return JSON.parse(raw) as AgentMetadata;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Read / Write — Transcript (JSONL format in session dir)
// ---------------------------------------------------------------------------

/**
 * Save a sub-agent transcript to JSONL format.
 *
 * When sessionDir is provided, writes to:
 *   <sessionDir>/subagents/agent-<agentId>.jsonl
 *
 * Each message becomes a transcript entry with uuid + parentUuid chain.
 * Falls back to legacy transcript.json when sessionDir is not provided.
 */
export async function saveAgentTranscript(
  agentId: string,
  transcript: Message[],
  sessionDir?: string,
): Promise<void> {
  if (sessionDir) {
    // Convert messages to JSONL entries with parentUuid chain
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

    const jsonlPath = subAgentJsonlPath(sessionDir, agentId);
    await rewriteEntries(jsonlPath, entries);
  } else {
    // Legacy format
    const dir = agentDir(agentId);
    await mkdir(dir, { recursive: true });
    await writeFile(legacyTranscriptPath(agentId), JSON.stringify(transcript));
  }
}

/**
 * Load a sub-agent transcript.
 *
 * Tries session-relative JSONL first, falls back to legacy transcript.json.
 * On successful legacy read, the data will be migrated to JSONL on next save.
 */
export async function getAgentTranscript(
  agentId: string,
  sessionDir?: string,
): Promise<Message[] | null> {
  // Try session-relative JSONL first
  if (sessionDir) {
    const jsonlPath = subAgentJsonlPath(sessionDir, agentId);
    if (existsSync(jsonlPath)) {
      try {
        const entries = await readEntries(jsonlPath);
        if (entries.length > 0) {
          return entriesToMessages(entries);
        }
      } catch {
        // Fall through to legacy
      }
    }
  }

  // Fallback: legacy transcript.json
  try {
    const raw = await readFile(legacyTranscriptPath(agentId), 'utf-8');
    return JSON.parse(raw) as Message[];
  } catch {
    return null;
  }
}

/**
 * Synchronous version of getAgentTranscript for contexts that can't await.
 */
export function getAgentTranscriptSync(
  agentId: string,
  sessionDir?: string,
): Message[] | null {
  // Try session-relative JSONL first
  if (sessionDir) {
    const jsonlPath = subAgentJsonlPath(sessionDir, agentId);
    if (existsSync(jsonlPath)) {
      try {
        const raw = readFileSync(jsonlPath, 'utf-8');
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
        // Fall through to legacy
      }
    }
  }

  // Fallback: legacy transcript.json
  try {
    const raw = readFileSync(legacyTranscriptPath(agentId), 'utf-8');
    return JSON.parse(raw) as Message[];
  } catch {
    return null;
  }
}
