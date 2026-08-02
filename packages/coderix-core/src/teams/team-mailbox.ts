/**
 * Team mailbox — inter-agent messaging.
 *
 * Delegates to the richer {@link ../utils/swarm/teammateMailbox.ts} primitives
 * (atomic writes, automatic compaction, file-size limits) while preserving the
 * {@link TeamMessage} return type that existing callers depend on.
 *
 * Each team member gets an inbox file:
 *   <sessionDir>/teams/{team-name}/inboxes/{agent-name}.json
 */

import {
  writeToMailbox,
  readMailbox,
  markMessagesAsRead,
} from '../utils/swarm/teammateMailbox.js';
import type { TeamMessage } from './types.js';

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
  if (to === '*') {
    throw new Error(
      'sendMessage does not support broadcast ("*"). Use SendMessage with to: "*" which handles broadcast at a higher level.',
    );
  }

  const timestamp = new Date().toISOString();

  await writeToMailbox(
    sessionDir,
    to,
    {
      from,
      to,
      text,
      timestamp,
    },
    teamName,
  );

  return {
    from,
    to,
    text,
    timestamp: Date.now(),
    read: false,
  };
}

export async function drainUnreadMessages(
  sessionDir: string,
  teamName: string,
  agentName: string,
): Promise<TeamMessage[]> {
  const messages = await readMailbox(sessionDir, agentName, teamName);
  const unread = messages.filter((m) => !m.read);

  if (unread.length > 0) {
    await markMessagesAsRead(sessionDir, agentName, teamName);
  }

  return unread.map((m) => ({
    from: m.from,
    to: m.to ?? 'unknown',
    text: m.text,
    timestamp:
      typeof m.timestamp === 'string'
        ? new Date(m.timestamp).getTime()
        : Date.now(),
    read: true,
  }));
}

export async function getUnreadCount(
  sessionDir: string,
  teamName: string,
  agentName: string,
): Promise<number> {
  const messages = await readMailbox(sessionDir, agentName, teamName);
  return messages.filter((m) => !m.read).length;
}
