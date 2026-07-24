/**
 * Team mailbox — inter-agent messaging.
 *
 * Each team member gets an inbox file:
 *   <sessionDir>/teams/{team-name}/inboxes/{agent-name}.json
 *
 * Messages are appended to the recipient's inbox under a file lock.
 * The coordinator drains unread messages before each turn.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';

import { teamDir } from './team-store.js';
import { sanitizeTeamName } from './team-store.js';
import type { TeamMessage } from './types.js';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function inboxDir(sessionDir: string, teamName: string): string {
  return join(teamDir(sessionDir, teamName), 'inboxes');
}

function inboxPath(sessionDir: string, teamName: string, agentName: string): string {
  return join(inboxDir(sessionDir, teamName), `${sanitizeTeamName(agentName)}.json`);
}

function inboxLockPath(sessionDir: string, teamName: string, agentName: string): string {
  return join(inboxDir(sessionDir, teamName), `${sanitizeTeamName(agentName)}.lock`);
}

// ---------------------------------------------------------------------------
// Lock helper
// ---------------------------------------------------------------------------

async function ensureLockFile(lockPath: string): Promise<void> {
  try {
    await writeFile(lockPath, '', { flag: 'wx' });
  } catch {
    // Already exists — fine
  }
}

async function withInboxLock<T>(
  sessionDir: string,
  teamName: string,
  agentName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const dir = inboxDir(sessionDir, teamName);
  await mkdir(dir, { recursive: true });
  const lockPath = inboxLockPath(sessionDir, teamName, agentName);
  await ensureLockFile(lockPath);
  const release = await lockfile.lock(lockPath, {
    retries: { retries: 10, minTimeout: 5, maxTimeout: 100 },
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}

// ---------------------------------------------------------------------------
// Read / write helpers
// ---------------------------------------------------------------------------

async function readInbox(sessionDir: string, teamName: string, agentName: string): Promise<TeamMessage[]> {
  const path = inboxPath(sessionDir, teamName, agentName);
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as TeamMessage[];
  } catch {
    return [];
  }
}

async function writeInbox(
  sessionDir: string,
  teamName: string,
  agentName: string,
  messages: TeamMessage[],
): Promise<void> {
  const dir = inboxDir(sessionDir, teamName);
  await mkdir(dir, { recursive: true });
  await writeFile(inboxPath(sessionDir, teamName, agentName), JSON.stringify(messages, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function sendMessage(
  sessionDir: string,
  teamName: string,
  from: string,
  to: string,
  text: string,
): Promise<TeamMessage> {
  const msg: TeamMessage = {
    from,
    to,
    text,
    timestamp: Date.now(),
    read: false,
  };

  await withInboxLock(sessionDir, teamName, to, async () => {
    const messages = await readInbox(sessionDir, teamName, to);
    messages.push(msg);
    await writeInbox(sessionDir, teamName, to, messages);
  });

  return msg;
}

export async function readMessages(
  sessionDir: string,
  teamName: string,
  agentName: string,
): Promise<TeamMessage[]> {
  return readInbox(sessionDir, teamName, agentName);
}

export async function drainUnreadMessages(
  sessionDir: string,
  teamName: string,
  agentName: string,
): Promise<TeamMessage[]> {
  return withInboxLock(sessionDir, teamName, agentName, async () => {
    const messages = await readInbox(sessionDir, teamName, agentName);
    const unread = messages.filter(m => !m.read);
    if (unread.length > 0) {
      for (const m of unread) {
        m.read = true;
      }
      await writeInbox(sessionDir, teamName, agentName, messages);
    }
    return unread;
  });
}

export async function getUnreadCount(
  sessionDir: string,
  teamName: string,
  agentName: string,
): Promise<number> {
  const messages = await readInbox(sessionDir, teamName, agentName);
  return messages.filter(m => !m.read).length;
}
