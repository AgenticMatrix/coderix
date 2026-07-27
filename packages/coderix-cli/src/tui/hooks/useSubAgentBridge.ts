/**
 * useSubAgentBridge.ts — Bridge from QueryEngine sub-agent streaming to TUI React state.
 *
 * Mirrors useAgentBridge but uses sendSubAgentMessageStreaming() instead of submitMessage().
 * Enables immersive sub-agent chat with real-time streaming.
 */

import { useCallback, useRef } from 'react';
import type { QueryEngine } from '@coderix/core';
import type {
  Message,
  ContentBlock as TuiContentBlock,
  TextBlock,
  ThinkingBlock,
  ToolResultBlock,
  ChatAction,
  ApprovalRequest,
  BlockDeltaType,
} from '../../types.js';
import type { AppState } from '../../state/AppState.js';
import { nextMessageId } from './useChatReducer.js';
import { useDeltaThrottle, truncateResult } from './streamHelpers.js';

// ── Block mapper (same logic as useAgentBridge's mapCoreBlockToTui) ──────

function mapCoreBlockToTui(
  block: { type: string; text?: string; thinking?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: string | Array<{ type: string; text?: string }>; is_error?: boolean },
): TuiContentBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', content: block.text ?? '' } satisfies TextBlock;
    case 'thinking':
      return { type: 'thinking', content: block.thinking ?? '' } satisfies ThinkingBlock;
    case 'tool_use':
      return {
        type: 'tool_use',
        toolName: block.name ?? 'unknown',
        toolId: block.id ?? '',
        input: block.input ?? {},
        state: 'pending' as const,
      };
    case 'tool_result': {
      const contentStr = typeof block.content === 'string'
        ? block.content
        : (Array.isArray(block.content)
          ? block.content.map((c) => c.text ?? '').join('')
          : '');
      return {
        type: 'tool_result',
        toolId: block.tool_use_id ?? '',
        toolName: '',
        content: truncateResult(contentStr),
        isError: block.is_error ?? false,
        duration: (block as Record<string, unknown>).duration as number | undefined,
        metadata: (block as Record<string, unknown>).metadata as Record<string, unknown> | undefined,
      };
    }
    case 'image':
      return { type: 'text', content: '[Image]' };
    default:
      return { type: 'text', content: '' };
  }
}

// ── Hook ─────────────────────────────────────────────────────────────────

export interface SubAgentBridgeDeps {
  engine: QueryEngine;
  dispatch: React.Dispatch<ChatAction>;
  setAppState: (partial: Partial<AppState>) => void;
}

/**
 * Hook that provides `sendToSubAgent`, which pipes user input through
 * QueryEngine.sendSubAgentMessageStreaming() and maps the resulting
 * events to TUI state — same pattern as useAgentBridge.runAgentTurn.
 */
export function useSubAgentBridge({ engine, dispatch, setAppState }: SubAgentBridgeDeps) {
  const toolNameMapRef = useRef<Map<string, string>>(new Map());
  const { pendingDeltasRef, flushDeltas, scheduleFlush } = useDeltaThrottle(dispatch);

  const sendToSubAgent = useCallback(
    async (agentId: string, text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;

      // ── Dispatch user message ──────────────────────────────────
      const userMsg: Message = {
        id: nextMessageId(),
        role: 'user',
        content: '',
        blocks: [{ type: 'text', content: trimmed } satisfies TextBlock],
        timestamp: Date.now(),
      };
      dispatch({ type: 'ADD_USER_MESSAGE', message: userMsg });

      try {
        let currentAssistantId: number | null = null;

        for await (const event of engine.sendSubAgentMessageStreaming(agentId, trimmed)) {
          switch (event.type) {
            case 'message': {
              const msg = event.data as {
                type: string;
                event?: { type: string; index?: number; content_block?: Record<string, unknown>; delta?: Record<string, unknown>; message?: Record<string, unknown> };
                message?: { role: string; content: Array<{ type: string; text?: string; thinking?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: string | Array<{ type: string; text?: string }>; is_error?: boolean }> };
                subtype?: string;
              };

              if (msg.type === 'stream_event' && msg.event) {
                const ev = msg.event;
                switch (ev.type) {
                  case 'message_start': {
                    currentAssistantId = nextMessageId();
                    dispatch({ type: 'START_ASSISTANT_RESPONSE', id: currentAssistantId });
                    break;
                  }
                  case 'content_block_start': {
                    if (!currentAssistantId) break;
                    const cb = ev.content_block as Record<string, unknown> | undefined;
                    if (!cb) break;
                    flushDeltas(true);
                    const tuiBlock = mapCoreBlockToTui(cb as Parameters<typeof mapCoreBlockToTui>[0]);
                    if (tuiBlock.type === 'tool_use' && tuiBlock.toolId) {
                      toolNameMapRef.current.set(tuiBlock.toolId, tuiBlock.toolName);
                    }
                    dispatch({ type: 'START_BLOCK', messageId: currentAssistantId, block: tuiBlock });
                    break;
                  }
                  case 'content_block_delta': {
                    if (!currentAssistantId) break;
                    const delta = ev.delta as Record<string, unknown> | undefined;
                    if (!delta) break;
                    let deltaType: BlockDeltaType | null = null;
                    let deltaText = '';
                    if (delta.text) { deltaType = 'text'; deltaText = delta.text as string; }
                    else if (delta.thinking) { deltaType = 'thinking'; deltaText = delta.thinking as string; }
                    else if (delta.partial_json) { deltaType = 'json'; deltaText = delta.partial_json as string; }
                    if (deltaType) {
                      pendingDeltasRef.current.push({ messageId: currentAssistantId, deltaType, text: deltaText });
                      scheduleFlush();
                    }
                    break;
                  }
                  case 'content_block_stop':
                    if (currentAssistantId) {
                      flushDeltas(true);
                      dispatch({ type: 'STOP_BLOCK', messageId: currentAssistantId });
                    }
                    break;
                  case 'message_stop':
                    if (currentAssistantId) {
                      flushDeltas(true);
                      dispatch({ type: 'FINISH_ASSISTANT_RESPONSE', id: currentAssistantId });
                      currentAssistantId = null;
                    }
                    break;
                }
              }

              // ── User message: tool results ────────────────────
              if (msg.type === 'user' && msg.message) {
                const rawContent = msg.message.content;
                if (typeof rawContent === 'string') {
                  const toolResultMsg: Message = {
                    id: nextMessageId(),
                    role: 'user',
                    content: '',
                    blocks: [{ type: 'text', content: rawContent } satisfies TextBlock],
                    timestamp: Date.now(),
                  };
                  dispatch({ type: 'ADD_USER_MESSAGE', message: toolResultMsg });
                  continue;
                }
                const blocks = rawContent.map((b: Record<string, unknown>) => {
                  const tuiBlock = mapCoreBlockToTui(b as Parameters<typeof mapCoreBlockToTui>[0]);
                  if (tuiBlock.type === 'tool_result' && tuiBlock.toolId) {
                    const toolName = toolNameMapRef.current.get(tuiBlock.toolId);
                    if (toolName) {
                      (tuiBlock as ToolResultBlock).toolName = toolName;
                    }
                  }
                  return tuiBlock;
                });
                const toolResultMsg: Message = {
                  id: nextMessageId(),
                  role: 'user',
                  content: '',
                  blocks,
                  timestamp: Date.now(),
                };

                // Inject results into tool_use blocks for inline display
                for (const block of blocks) {
                  if (block.type === 'tool_result' && block.toolId) {
                    const isBashBackground = block.toolName === 'bash' && block.metadata?.background === true;
                    if (isBashBackground) {
                      dispatch({
                        type: 'UPDATE_BLOCK_STATE',
                        toolId: block.toolId,
                        state: 'done',
                      });
                    } else {
                      dispatch({
                        type: 'SET_TOOL_USE_RESULT',
                        toolId: block.toolId,
                        duration: block.duration,
                        result: {
                          content: block.content,
                          isError: block.isError,
                          metadata: block.metadata,
                        },
                      });
                    }
                  }
                }

                // Filter out inline-rendered results from TUI messages
                const tuiBlocks = blocks.filter(
                  (b) => b.type !== 'tool_result' || (
                    b.toolName !== 'read' && b.toolName !== 'bash' &&
                    b.toolName !== 'glob' && b.toolName !== 'grep' &&
                    b.toolName !== 'WebSearch' && b.toolName !== 'WebFetch' &&
                    b.toolName !== 'write' && b.toolName !== 'update' &&
                    b.toolName !== 'Agent' && b.toolName !== 'SendMessage'
                  ),
                );
                if (tuiBlocks.length > 0) {
                  dispatch({
                    type: 'ADD_USER_MESSAGE',
                    message: { ...toolResultMsg, blocks: tuiBlocks },
                  });
                }
              }

              if (msg.type === 'system' && msg.subtype === 'progress') {
                const progress = (msg as Record<string, unknown>).data as {
                  toolName?: string; toolUseId?: string;
                  status?: string; message?: string;
                } | undefined;
                if (progress?.toolUseId && progress.status === 'running') {
                  dispatch({
                    type: 'UPDATE_BLOCK_STATE',
                    toolId: progress.toolUseId,
                    state: 'executing',
                  });
                }
              }
              break;
            }

            case 'error': {
              const errData = event.data as { message?: string };
              dispatch({ type: 'SET_ERROR', error: errData?.message ?? String(event.data) });
              break;
            }

            case 'permission_required': {
              if (event.deferred) {
                const deferred = event.deferred as any;
                setAppState({
                  pendingApproval: {
                    toolName: deferred.toolName,
                    command: deferred.command,
                    description: deferred.description,
                    toolUseId: deferred.toolUseId,
                    deferred,
                  },
                });
                dispatch({ type: 'SHOW_APPROVAL', req: deferred as any });
                await deferred.promise;
                dispatch({ type: 'HIDE_APPROVAL' });
                setAppState({ pendingApproval: null });
              }
              break;
            }

            case 'question_required': {
              if (event.deferred) {
                const deferred = event.deferred as any;
                setAppState({
                  pendingQuestion: {
                    toolName: deferred.toolName,
                    toolUseId: deferred.toolUseId,
                    questions: deferred.questions,
                    deferred,
                  },
                } as any);
                dispatch({ type: 'SHOW_QUESTION', questions: deferred.questions } as any);
                await deferred.promise;
                dispatch({ type: 'HIDE_QUESTION' } as any);
                setAppState({ pendingQuestion: null } as any);
              }
              break;
            }

            case 'done':
              flushDeltas(true);
              break;
          }
        }
      } catch (err) {
        flushDeltas(true);
        dispatch({ type: 'SET_ERROR', error: (err as Error).message });
      }
    },
    [engine, dispatch, flushDeltas, scheduleFlush, setAppState],
  );

  return { sendToSubAgent };
}
