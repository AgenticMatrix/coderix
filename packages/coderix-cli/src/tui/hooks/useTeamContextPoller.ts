/**
 * useTeamContextPoller — Polls the leader's mailbox for team messages and
 * dispatches them to the TUI state.
 *
 * Runs when a teamContext is present (i.e. the leader is viewing the team).
 * Handles:
 *   - Idle notifications → update teammate status in teamContext
 *   - Permission requests → show approval prompt
 *   - Shutdown requests → auto-approve and update status
 *   - Plain text messages → show in chat
 */

import { useEffect, useRef } from 'react';
import {
  readUnreadMessages,
  markMessagesAsRead,
  isIdleNotification,
  isPermissionRequest,
  isShutdownRequest,
} from '@coderix/core';
import type { TeamContextState, ChatAction } from '../../types.js';
import type { AppState } from '../../state/AppState.js';

const POLL_INTERVAL_MS = 500;

export interface TeamContextPollerDeps {
  teamContext?: TeamContextState;
  dispatch: React.Dispatch<ChatAction>;
  setAppState: (partial: Partial<AppState>) => void;
}

/**
 * Poll the leader's mailbox for incoming team messages.
 * Only meaningful when teamContext.isLeader is true.
 */
export function useTeamContextPoller({
  teamContext,
  dispatch,
  setAppState,
}: TeamContextPollerDeps) {
  const teamContextRef = useRef(teamContext);
  teamContextRef.current = teamContext;

  useEffect(() => {
    if (!teamContext?.isLeader) return;

    let active = true;

    async function poll() {
      if (!active) return;
      const ctx = teamContextRef.current;
      if (!ctx.isLeader) return;

      try {
        // The leader's agent name is their selfAgentName (or 'lead')
        const leaderName = ctx.selfAgentName || 'lead';
        const unread = await readUnreadMessages(leaderName, ctx.teamName);

        if (unread.length === 0) return;

        for (const msg of unread) {
          const text = msg.text;

          // Idle notification from a worker
          const idleNotif = isIdleNotification(text);
          if (idleNotif) {
            const teammates = { ...ctx.teammates };
            if (teammates[idleNotif.agentId]) {
              teammates[idleNotif.agentId] = {
                ...teammates[idleNotif.agentId]!,
                status: 'idle',
              };
              setAppState({
                teamContext: { ...ctx, teammates },
              } as Partial<AppState>);
            }
            continue;
          }

          // Permission request from a worker
          const permReq = isPermissionRequest(text);
          if (permReq) {
            // Show as a system message in chat so the user can respond
            dispatch({
              type: 'ADD_USER_MESSAGE',
              message: {
                id: Date.now(),
                role: 'system',
                content: `[Team] ${permReq.agentName} requests permission: ${permReq.toolName} — "${permReq.description}"`,
                blocks: [
                  {
                    type: 'text',
                    content: `[Team] ${permReq.agentName} requests permission to run \`${permReq.toolName}\`: ${permReq.description}`,
                  },
                ],
                timestamp: Date.now(),
              },
            } as any);
            continue;
          }

          // Shutdown request — auto-approve for now
          const shutdownReq = isShutdownRequest(text);
          if (shutdownReq) {
            const teammates = { ...ctx.teammates };
            if (teammates[shutdownReq.agentId]) {
              teammates[shutdownReq.agentId] = {
                ...teammates[shutdownReq.agentId]!,
                status: 'stopped',
              };
              setAppState({
                teamContext: { ...ctx, teammates },
              } as Partial<AppState>);
            }
            continue;
          }

          // Plain text message — show in chat
          dispatch({
            type: 'ADD_USER_MESSAGE',
            message: {
              id: Date.now(),
              role: 'user',
              content: `[${msg.from}] ${text}`,
              blocks: [
                { type: 'text', content: `[Team · ${msg.from}] ${text}` },
              ],
              timestamp: Date.now(),
            },
          } as any);
        }

        // Mark all as read
        await markMessagesAsRead(leaderName, ctx.teamName);
      } catch {
        // Silently ignore poll errors (team may have been deleted)
      }
    }

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [teamContext?.isLeader, teamContext?.teamName, teamContext?.selfAgentName]);
}
