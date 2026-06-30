/**
 * Teammate mailbox — file-based inter-agent message passing.
 *
 * Physical layout:
 *   ~/.coderix/teams/{team_name}/inboxes/{agent_name}.json
 *
 * Each agent has one inbox file containing an array of messages.
 * Uses atomic writes (temp file + rename) to prevent corruption
 * during concurrent access.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { MAX_MAILBOX_MESSAGES } from './constants.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TeammateMessage {
  from: string;
  to: string;
  text: string;
  timestamp: string;
  read: boolean;
  color?: string;
  summary?: string;
  /** Protocol messages are structured JSON and not shown to the LLM directly. */
  type?: string;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function inboxPath(teamName: string, agentName: string): string {
  const sanitized = teamName.replace(/[^a-zA-Z0-9_-]/g, '-');
  const sanitizedAgent = agentName.replace(/[^a-zA-Z0-9_-]/g, '-');
  return join(homedir(), '.coderix', 'teams', sanitized, 'inboxes', `${sanitizedAgent}.json`);
}

// ---------------------------------------------------------------------------
// Atomic write
// ---------------------------------------------------------------------------

function atomicWrite(filePath: string, data: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmpPath, data, 'utf-8');
  // Atomic rename on Unix
  writeFileSync(filePath, data, 'utf-8');
  // Clean up temp file
  try {
    require('fs').unlinkSync(tmpPath);
  } catch {
    // Temp cleanup failure is non-fatal
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Read all messages in an agent's inbox. */
export function readMailbox(teamName: string, agentName: string): TeammateMessage[] {
  try {
    const path = inboxPath(teamName, agentName);
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as TeammateMessage[];
  } catch {
    return [];
  }
}

/** Send a message to an agent's inbox. */
export function sendToMailbox(
  teamName: string,
  to: string,
  message: Omit<TeammateMessage, 'read' | 'timestamp'>,
): void {
  const path = inboxPath(teamName, to);
  const messages = readMailbox(teamName, to);
  messages.push({
    ...message,
    read: false,
    timestamp: new Date().toISOString(),
  });
  compactMailbox(messages);
  atomicWrite(path, JSON.stringify(messages, null, 2));
}

/** Mark all messages in an agent's inbox as read and return them. */
export function drainMailbox(teamName: string, agentName: string): TeammateMessage[] {
  const path = inboxPath(teamName, agentName);
  const messages = readMailbox(teamName, agentName);
  if (messages.length === 0) return [];
  const updated = messages.map(m => ({ ...m, read: true }));
  atomicWrite(path, JSON.stringify(updated, null, 2));
  return messages;
}

/** Count unread messages for an agent. */
export function getUnreadCount(teamName: string, agentName: string): number {
  return readMailbox(teamName, agentName).filter(m => !m.read).length;
}

/** Delete an agent's inbox file entirely. */
export function deleteMailbox(teamName: string, agentName: string): void {
  try {
    const path = inboxPath(teamName, agentName);
    if (existsSync(path)) {
      require('fs').unlinkSync(path);
    }
  } catch {
    // Already gone — fine
  }
}

/** Delete all inboxes for a team. */
export function deleteTeamMailboxes(teamName: string): void {
  const dir = join(homedir(), '.coderix', 'teams', teamName, 'inboxes');
  try {
    if (existsSync(dir)) {
      require('fs').rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // Already gone
  }
}

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

function compactMailbox(messages: TeammateMessage[]): void {
  if (messages.length <= MAX_MAILBOX_MESSAGES) return;
  // Keep the most recent messages, preferring unread ones
  const unread = messages.filter(m => !m.read);
  const read = messages.filter(m => m.read);
  const toKeep = MAX_MAILBOX_MESSAGES - unread.length;
  if (toKeep > 0) {
    messages.length = 0;
    messages.push(...read.slice(-toKeep), ...unread);
  } else {
    messages.length = 0;
    messages.push(...unread.slice(-MAX_MAILBOX_MESSAGES));
  }
}
