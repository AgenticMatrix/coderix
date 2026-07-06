/**
 * useAgentBridge.ts — Bridges WebSocket gateway events to Zustand chat store.
 *
 * Adapted from src/tui/hooks/useAgentBridge.ts — replaces direct QueryEngine
 * calls with WebSocket RPC, but maps the same event types to the same state
 * mutations.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useChatStore, nextMessageId, type MessageBlock, type ApprovalRequest, type PendingQuestion } from '../stores/chatStore';
import type { GatewayEvent } from './useWebSocket';

// ── Throttle (same as TUI: 60ms flush interval) ───────

const DELTA_FLUSH_INTERVAL = 60;

interface PendingDelta {
  messageId: number;
  deltaType: string;
  text: string;
}

// ── Block mapping: Gateway event block → UI MessageBlock ─────

function mapGatewayBlockToUI(block: Record<string, unknown>): MessageBlock | null {
  switch (block.type) {
    case 'text':
      return { type: 'text', content: (block.text as string) ?? (block.content as string) ?? '' };

    case 'thinking':
      return { type: 'thinking', content: (block.thinking as string) ?? (block.content as string) ?? '' };

    case 'tool_use':
      return {
        type: 'tool_use',
        toolName: (block.name as string) ?? 'unknown',
        toolId: (block.id as string) ?? '',
        input: (block.input as Record<string, unknown>) ?? {},
        state: 'pending' as const,
      };

    case 'tool_result':
      return {
        type: 'tool_result',
        toolId: (block.tool_use_id as string) ?? '',
        toolName: (block.toolName as string) ?? '',
        content: typeof block.content === 'string' ? block.content : '',
        isError: (block.is_error as boolean) ?? false,
        duration: block.duration as number | undefined,
        metadata: block.metadata as Record<string, unknown> | undefined,
      };

    default:
      return null;
  }
}

// ── useAgentBridge hook ──────────────────────────────────

export interface AgentBridge {
  runAgentTurn: (text: string) => Promise<void>;
  approvePermission: (requestId: string, allowed: boolean) => Promise<void>;
  answerQuestion: (requestId: string, answers: Record<string, string>) => Promise<void>;
  interruptAgent: () => Promise<void>;
  createSession: () => Promise<{ sessionId: string; title: string }>;
  listSessions: () => Promise<Array<{ id: string; title: string; turnCount: number; model: string; createdAt: number }>>;
  resumeSession: (id: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
}

export function useAgentBridge(
  onEvent: (handler: (event: GatewayEvent) => void) => () => void,
  sendRpc: (method: string, params?: Record<string, unknown>) => Promise<{ id: number; result?: unknown; error?: { code: number; message: string } }>,
): AgentBridge {
  const toolNameMapRef = useRef<Map<string, string>>(new Map());

  // ── Delta throttling ────────────────
  const pendingDeltasRef = useRef<PendingDelta[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushDeltas = useCallback(() => {
    const deltas = pendingDeltasRef.current;
    pendingDeltasRef.current = [];
    if (flushTimerRef.current !== null) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    const store = useChatStore.getState();
    for (const d of deltas) {
      store.appendBlockDelta(d.messageId, d.deltaType, d.text);
    }
  }, []);

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current !== null) return;
    flushTimerRef.current = setTimeout(flushDeltas, DELTA_FLUSH_INTERVAL);
  }, [flushDeltas]);

  // ── Set up event listener ───────────

  const currentAssistantIdRef = useRef<number | null>(null);
  const pendingBlocksRef = useRef<MessageBlock[]>([]);

  // Register the event handler on mount — clean up on unmount
  useEffect(() => {
    const unsubscribe = onEvent((event: GatewayEvent) => {
      const store = useChatStore.getState();

      switch (event.type) {
        // ── Stream events ──────────
        case 'message.start': {
          const id = nextMessageId();
          currentAssistantIdRef.current = id;
          pendingBlocksRef.current = [];
          store.startAssistantResponse(id);
          break;
        }

        case 'message.delta': {
          if (!currentAssistantIdRef.current) break;
          const p = event.payload as Record<string, unknown> | undefined;
          if (!p) break;
          let deltaType = '';
          let text = '';
          if (typeof p.text === 'string') {
            deltaType = 'text';
            text = p.text;
          } else if (typeof p.thinking === 'string') {
            deltaType = 'thinking';
            text = p.thinking;
          } else if (typeof p.json === 'string') {
            deltaType = 'json';
            text = p.json;
          }
          if (deltaType) {
            pendingDeltasRef.current.push({
              messageId: currentAssistantIdRef.current,
              deltaType,
              text,
            });
            scheduleFlush();
          }
          break;
        }

        case 'tool.start': {
          if (!currentAssistantIdRef.current) break;
          const p = event.payload as Record<string, unknown> | undefined;
          if (!p) break;
          const toolBlock: MessageBlock = {
            type: 'tool_use',
            toolName: (p.name as string) ?? 'unknown',
            toolId: (p.tool_id as string) ?? '',
            input: {},
            state: 'pending',
          };
          if (toolBlock.type === 'tool_use') {
            toolNameMapRef.current.set(toolBlock.toolId, toolBlock.toolName);
          }
          pendingBlocksRef.current.push(toolBlock);
          store.startBlock(currentAssistantIdRef.current, toolBlock);
          break;
        }

        case 'tool.progress': {
          const p = event.payload as Record<string, unknown> | undefined;
          if (p?.tool_id) {
            store.updateBlockState(p.tool_id as string, 'executing');
          }
          break;
        }

        case 'tool.complete': {
          const p = event.payload as Record<string, unknown> | undefined;
          if (p?.tool_id) {
            store.updateBlockState(p.tool_id as string, 'done');
          }
          break;
        }

        case 'block.stop': {
          if (currentAssistantIdRef.current) {
            flushDeltas();
            store.stopBlock(currentAssistantIdRef.current);
          }
          break;
        }

        case 'message.stop': {
          if (currentAssistantIdRef.current) {
            flushDeltas();
            store.finishAssistantResponse(currentAssistantIdRef.current);
            currentAssistantIdRef.current = null;
          }
          break;
        }

        case 'message.complete': {
          if (currentAssistantIdRef.current) {
            flushDeltas();
            store.finishAssistantResponse(currentAssistantIdRef.current);
            currentAssistantIdRef.current = null;
          }
          // Update token usage
          const p = event.payload as Record<string, unknown> | undefined;
          const u = p?.usage as Record<string, number> | undefined;
          if (u) {
            store.updateTokenUsage({
              inputTokens: u.input ?? 0,
              outputTokens: u.output ?? 0,
              cacheCreationInputTokens: u.cache ?? 0,
              cacheReadInputTokens: 0,
            });
          }
          break;
        }

        // ── Tool results ──────────
        case 'tool_results': {
          const p = event.payload as Record<string, unknown> | undefined;
          const blocks = (p?.blocks as Array<Record<string, unknown>>) ?? [];
          const uiBlocks: MessageBlock[] = [];
          for (const b of blocks) {
            const mapped = mapGatewayBlockToUI(b);
            if (mapped) {
              if (mapped.type === 'tool_result' && mapped.toolId) {
                const toolName = toolNameMapRef.current.get(mapped.toolId);
                if (toolName) mapped.toolName = toolName;
                store.updateToolUseResult(mapped.toolId, {
                  content: mapped.content,
                  isError: mapped.isError,
                  metadata: mapped.metadata,
                }, mapped.duration);
              }
              uiBlocks.push(mapped);
            }
          }
          // Only add non-inline results as separate messages
          const inlineTools = new Set(['read', 'bash', 'glob', 'grep', 'web-search', 'web-fetch', 'write', 'edit']);
          const nonInline = uiBlocks.filter(
            (b) => b.type !== 'tool_result' || !inlineTools.has(b.toolName),
          );
          if (nonInline.length > 0) {
            store.addToolResults(nonInline);
          }
          break;
        }

        // ── Permission ────────────
        case 'approval.request': {
          const p = event.payload as Record<string, unknown> | undefined;
          if (p) {
            store.showApproval({
              toolName: (p.command as string) ?? '',
              command: (p.command as string) ?? '',
              description: (p.description as string) ?? '',
              requestId: (p.request_id as string) ?? '',
            });
          }
          break;
        }

        // ── Status ───────────────
        case 'status.update': {
          const p = event.payload as Record<string, unknown> | undefined;
          if (p?.text) {
            store.setStatusText(p.text as string);
          }
          break;
        }

        // ── Gateway ready ────────
        case 'gateway.ready': {
          const p = event.payload as Record<string, unknown> | undefined;
          if (p?.session_id) {
            store.setSessionId(p.session_id as string);
          }
          store.setStatusText('Ready');
          break;
        }

        // ── Session events ───────
        case 'session.history': {
          const messages = event.messages as Array<{ role: string; text: string }> | undefined;
          const sessionId = event.sessionId as string | undefined;
          if (messages && sessionId) {
            store.clearChat();
            for (const m of messages) {
              if (m.role === 'user' || m.role === 'assistant') {
                const msg = {
                  id: nextMessageId(),
                  role: m.role as 'user' | 'assistant',
                  content: m.text,
                  blocks: [{ type: 'text' as const, content: m.text }],
                  timestamp: Date.now(),
                };
                useChatStore.setState((s) => ({
                  messages: [...s.messages, msg],
                }));
              }
            }
            store.setSessionId(sessionId);
          }
          break;
        }

        case 'session.switched': {
          const sessionId = event.sessionId as string | undefined;
          if (sessionId) {
            store.setSessionId(sessionId);
          }
          break;
        }

        // ── Question ─────────────
        case 'question.request': {
          const p = event.payload as Record<string, unknown> | undefined;
          if (p) {
            store.showQuestion({
              toolName: (p.tool_name as string) ?? '',
              toolUseId: (p.tool_use_id as string) ?? '',
              questions: (p.questions as PendingQuestion['questions']) ?? [],
            });
          }
          break;
        }
      }
    });

    return unsubscribe;
  }, [onEvent, flushDeltas, scheduleFlush]);

  // ── Public API ─────────────────────────────────

  const runAgentTurn = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;

      const store = useChatStore.getState();
      store.addUserMessage(trimmed);
      store.setInputText('');
      store.setError('');

      try {
        await sendRpc('prompt.submit', { text: trimmed });
      } catch (err) {
        store.setError((err as Error).message);
      }
    },
    [sendRpc],
  );

  const approvePermission = useCallback(
    async (requestId: string, allowed: boolean) => {
      try {
        await sendRpc('approval.respond', { request_id: requestId, allowed });
        useChatStore.getState().hideApproval();
      } catch (err) {
        console.error('approvePermission error:', err);
      }
    },
    [sendRpc],
  );

  const answerQuestion = useCallback(
    async (requestId: string, answers: Record<string, string>) => {
      try {
        await sendRpc('question.respond', { request_id: requestId, answers });
        useChatStore.getState().hideQuestion();
      } catch (err) {
        console.error('answerQuestion error:', err);
      }
    },
    [sendRpc],
  );

  const interruptAgent = useCallback(async () => {
    try {
      await sendRpc('interrupt');
    } catch (err) {
      console.error('interrupt error:', err);
    }
  }, [sendRpc]);

  const createSession = useCallback(async () => {
    const res = await sendRpc('session.create');
    return {
      sessionId: (res.result as Record<string, unknown>)?.sessionId as string,
      title: ((res.result as Record<string, unknown>)?.title as string) ?? 'Untitled',
    };
  }, [sendRpc]);

  const listSessions = useCallback(async () => {
    const res = await sendRpc('session.list');
    return ((res.result as Record<string, unknown>)?.sessions as Array<Record<string, unknown>>)?.map(
      (s: Record<string, unknown>) => ({
        id: s.id as string,
        title: (s.title as string) ?? 'Untitled',
        turnCount: (s.turnCount as number) ?? 0,
        model: (s.model as string) ?? '',
        createdAt: (s.createdAt as number) ?? Date.now(),
      }),
    ) ?? [];
  }, [sendRpc]);

  const resumeSession = useCallback(
    async (id: string) => {
      await sendRpc('session.resume', { session_id: id });
    },
    [sendRpc],
  );

  const deleteSession = useCallback(
    async (id: string) => {
      await sendRpc('session.delete', { session_id: id });
    },
    [sendRpc],
  );

  const renameSession = useCallback(
    async (id: string, title: string) => {
      await sendRpc('session.rename', { session_id: id, title });
    },
    [sendRpc],
  );

  return {
    runAgentTurn,
    approvePermission,
    answerQuestion,
    interruptAgent,
    createSession,
    listSessions,
    resumeSession,
    deleteSession,
    renameSession,
  };
}
