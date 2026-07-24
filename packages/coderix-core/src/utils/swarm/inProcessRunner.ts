/**
 * In-process teammate runner — continuous execution loop for team workers.
 *
 * Unlike one-shot sub-agents, team workers run in a persistent loop:
 *   1. Execute the current prompt via the standard agent loop
 *   2. Send idle notification to the team leader
 *   3. Poll the file-based mailbox for new messages or shutdown requests
 *   4. Wake up when a new message arrives, goto 1
 *
 * Uses AsyncLocalStorage (teammateContext) for identity isolation so
 * multiple in-process teammates can run concurrently.
 */

import { runWithTeammateContext, type TeammateContext } from './teammateContext.js';
import {
  createIdleNotification,
  isShutdownRequest,
  readUnreadMessages,
  writeToMailbox,
  markMessagesAsRead,
} from './teammateMailbox.js';
import { buildTeammatePromptAddendum } from './teammatePromptAddendum.js';
import type { TeammateIdentity } from './spawnInProcess.js';
import { TEAM_LEAD_NAME } from './constants.js';
import { loadTeamConfig } from '../../teams/team-store.js';
import { sessionDir as getSessionDir } from '../../core/session-store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InProcessRunnerConfig {
  identity: TeammateIdentity;
  taskId: string;
  prompt: string;
  description: string;
  teammateContext: TeammateContext;
  abortController: AbortController;
  model?: string;
  systemPrompt?: string;
  /** 'replace' = use only provided prompt, 'append' = add after default, default = full prompt + addendum */
  systemPromptMode?: 'replace' | 'append' | 'default';
  /** The full default system prompt parts (from the main agent) to build teammate prompt */
  defaultSystemPromptParts?: string[];
}

export interface InProcessRunnerResult {
  success: boolean;
  messages: Array<{ type: string; content: unknown }>;
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 500;

function formatAsTeammateMessage(
  from: string,
  text: string,
  color?: string,
  summary?: string,
): string {
  const colorAttr = color ? ` color="${color}"` : '';
  const summaryAttr = summary ? ` summary="${summary}"` : '';
  return `<teammate-message teammate_id="${from}"${colorAttr}${summaryAttr}>\n${text}\n</teammate-message>`;
}

// ---------------------------------------------------------------------------
// Mailbox polling
// ---------------------------------------------------------------------------

type WaitResult = {
  type: 'new_message';
  from: string;
  message: string;
  color?: string;
  summary?: string;
  messageIndex?: number;
} | {
  type: 'shutdown_request';
  from: string;
  originalMessage: string;
} | {
  type: 'aborted';
};

/**
 * Poll the teammate's mailbox for new messages or shutdown requests.
 * Returns when a non-protocol message arrives, a shutdown is requested, or aborted.
 */
async function waitForNextPromptOrShutdown(
  identity: TeammateIdentity,
  abortController: AbortController,
): Promise<WaitResult> {
  while (!abortController.signal.aborted) {
    const unread = await readUnreadMessages(identity.agentId, identity.teamName);

    if (unread.length > 0) {
      // Walk from newest to find first non-protocol message or shutdown
      for (let i = unread.length - 1; i >= 0; i--) {
        const msg = unread[i]!;
        const text = msg.text;

        // Check for shutdown request
        const shutdownRequest = isShutdownRequest(text);
        if (shutdownRequest) {
          // Mark it read
          await markMessagesAsRead(identity.agentId, identity.teamName);
          return {
            type: 'shutdown_request',
            from: shutdownRequest.from,
            originalMessage: text,
          };
        }

        // Skip structured protocol messages
        try {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === 'object' && 'type' in parsed) {
            continue;
          }
        } catch { /* plain text — deliver it */ }

        // Found a regular message — mark all read and deliver
        await markMessagesAsRead(identity.agentId, identity.teamName);
        return {
          type: 'new_message',
          from: msg.from,
          message: text,
          color: msg.color,
          summary: msg.summary,
        };
      }
    }

    // No actionable messages — sleep and retry
    await new Promise<void>(resolve => {
      const timeout = setTimeout(resolve, POLL_INTERVAL_MS);
      const onAbort = () => {
        clearTimeout(timeout);
        resolve();
      };
      abortController.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  return { type: 'aborted' };
}

// ---------------------------------------------------------------------------
// Idle notification
// ---------------------------------------------------------------------------

async function sendIdleNotification(
  identity: TeammateIdentity,
  reason: 'available' | 'interrupted' | 'failed' = 'available',
): Promise<void> {
  const notification = createIdleNotification(identity.agentId, {
    idleReason: reason,
  });
  await writeToMailbox(TEAM_LEAD_NAME, {
    from: identity.agentId,
    text: JSON.stringify(notification),
    timestamp: new Date().toISOString(),
    color: identity.color,
  });
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

/**
 * Run the in-process teammate loop.
 *
 * This is the core execution engine for team workers. It:
 * 1. Runs the initial prompt through the agent
 * 2. Sends an idle notification to the leader
 * 3. Waits for new messages or shutdown requests via mailbox polling
 * 4. Resumes execution when new messages arrive
 */
export async function runInProcessTeammate(
  config: InProcessRunnerConfig,
  /** The query function from the core engine */
  runQuery: (opts: {
    messages: Array<{ role: string; content: unknown }>;
    systemPrompt: string;
    abortController: AbortController;
    maxTurns: number;
  }) => AsyncGenerator<{ type: string; message?: unknown }>,
): Promise<InProcessRunnerResult> {
  const {
    identity,
    prompt,
    teammateContext,
    abortController,
    systemPrompt,
    systemPromptMode,
    defaultSystemPromptParts,
  } = config;

  const startTime = Date.now();
  const allMessages: Array<{ type: string; content: unknown }> = [];
  let currentPrompt = formatAsTeammateMessage(TEAM_LEAD_NAME, prompt);
  let shouldExit = false;

  // Build system prompt
  let teammateSystemPrompt: string;
  if (systemPromptMode === 'replace' && systemPrompt) {
    teammateSystemPrompt = systemPrompt;
  } else {
    // Build dynamic team communication context
    let addendum = '';
    try {
      const sd = getSessionDir(identity.parentSessionId);
      const teamConfig = await loadTeamConfig(sd, identity.teamName);
      if (teamConfig) {
        addendum = buildTeammatePromptAddendum({
          myAgentId: identity.agentId,
          myName: identity.agentName,
          teamName: identity.teamName,
          members: teamConfig.members.map(m => ({
            agentId: m.agentId,
            name: m.name,
            agentType: m.agentType,
          })),
        });
      }
    } catch {
      // Fallback: basic addendum if team config is unavailable
      addendum = buildTeammatePromptAddendum({
        myAgentId: identity.agentId,
        myName: identity.agentName,
        teamName: identity.teamName,
        members: [],
      });
    }
    const parts = [...(defaultSystemPromptParts || []), addendum];
    if (systemPromptMode === 'append' && systemPrompt) {
      parts.push(systemPrompt);
    }
    teammateSystemPrompt = parts.join('\n');
  }

  try {
    // Main teammate loop — runs until abort or shutdown approved
    while (!abortController.signal.aborted && !shouldExit) {
      // Create abort controller for this turn (Escape stops current work only)
      const turnAbortController = new AbortController();

      // Link to lifecycle: if lifecycle aborts, also abort the turn
      const onLifecycleAbort = () => turnAbortController.abort();
      abortController.signal.addEventListener('abort', onLifecycleAbort, { once: true });

      let turnWasAborted = false;

      try {
        // Run the agent for this turn
        const generator = runQuery({
          messages: [{ role: 'user', content: currentPrompt }],
          systemPrompt: teammateSystemPrompt,
          abortController: turnAbortController,
          maxTurns: 50,
        });

        const turnMessages: Array<{ type: string; content: unknown }> = [];
        for await (const msg of generator) {
          if (abortController.signal.aborted) break;
          if (turnAbortController.signal.aborted) {
            turnWasAborted = true;
            break;
          }
          turnMessages.push({ type: msg.type, content: msg.message });
          allMessages.push({ type: msg.type, content: msg.message });
        }
      } catch (error) {
        if (turnAbortController.signal.aborted) {
          turnWasAborted = true;
        } else {
          throw error;
        }
      }

      abortController.signal.removeEventListener('abort', onLifecycleAbort);

      // Check lifecycle abort
      if (abortController.signal.aborted) break;

      // Send idle notification
      await sendIdleNotification(
        identity,
        turnWasAborted ? 'interrupted' : 'available',
      );

      // Wait for next prompt or shutdown
      const waitResult = await waitForNextPromptOrShutdown(
        identity,
        abortController,
      );

      switch (waitResult.type) {
        case 'shutdown_request':
          // Approve shutdown and exit loop
          shouldExit = true;
          break;

        case 'new_message':
          currentPrompt = formatAsTeammateMessage(
            waitResult.from,
            waitResult.message,
            waitResult.color,
            waitResult.summary,
          );
          break;

        case 'aborted':
          shouldExit = true;
          break;
      }
    }

    return {
      success: !abortController.signal.aborted,
      messages: allMessages,
      error: abortController.signal.aborted ? 'Aborted' : undefined,
    };
  } catch (error) {
    await sendIdleNotification(identity, 'failed');
    return {
      success: false,
      messages: allMessages,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Fire-and-forget entry point. Starts the teammate in the background
 * and returns immediately.
 */
export function startInProcessTeammate(
  config: InProcessRunnerConfig,
  runQuery: (opts: {
    messages: Array<{ role: string; content: unknown }>;
    systemPrompt: string;
    abortController: AbortController;
    maxTurns: number;
  }) => AsyncGenerator<{ type: string; message?: unknown }>,
): void {
  const agentId = config.identity.agentId;
  void runInProcessTeammate(config, runQuery).catch(error => {
    // Log but don't crash — teammates are fire-and-forget
    console.error(`[inProcessRunner] Unhandled error in ${agentId}:`, error);
  });
}
