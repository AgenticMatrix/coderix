/**
 * sdk/mapper.ts — map Coderix QueryEngine events to SDK messages.
 *
 * Single source of truth for the SDK message schema. The in-process
 * TypeScript SDK (@coderix/sdk) calls this directly; the CLI's
 * `--sdk` stream-json mode serializes its output through the same
 * function so the Python SDK (a dumb JSON pass-through) can never drift.
 */

import type { QueryEngineEvent } from '../core/query-engine.js';
import type { QueryMessage, DeferredPermission, DeferredQuestion, CompletionUsage } from '../core/types.js';
import type {
  SDKMessage,
  SDKSystemMessage,
  SDKResultMessage,
  SDKResultSubtype,
  PermissionMode,
} from './types.js';

export interface SdkMapperContext {
  sessionId: string;
  includePartialMessages: boolean;
  /** UUID generator, injectable for deterministic tests. */
  uuid: () => string;
}

export interface SdkInitInput {
  sessionId: string;
  cwd: string;
  tools: string[];
  mcpServers: string[];
  model: string;
  permissionMode: PermissionMode;
  uuid: string;
}

export interface SdkResultInput {
  sessionId: string;
  uuid: string;
  subtype: SDKResultSubtype;
  isError: boolean;
  result: string;
  durationMs: number;
  durationApiMs: number;
  numTurns: number;
  totalCostUsd: number;
  usage: CompletionUsage;
}

/**
 * Map a single QueryEngine event to zero-or-one SDK message.
 * Returns null for events the client handles separately
 * (permission/question resolution, terminal done/error → result message).
 */
export function mapEngineEventToSdkMessage(
  event: QueryEngineEvent,
  ctx: SdkMapperContext,
): SDKMessage | null {
  // Compact boundary events arrive as top-level `compact` events, not `message`.
  if (event.type === 'compact') {
    return {
      type: 'system',
      subtype: 'compact_boundary',
      session_id: ctx.sessionId,
      uuid: ctx.uuid(),
    };
  }

  if (event.type !== 'message') return null;

  const msg = event.data as QueryMessage | undefined;
  if (!msg) return null;

  switch (msg.type) {
    case 'stream_event':
      if (!ctx.includePartialMessages) return null;
      return {
        type: 'stream_event',
        event: msg.event,
        session_id: ctx.sessionId,
        uuid: ctx.uuid(),
        parent_tool_use_id: null,
      };

    case 'assistant':
      return {
        type: 'assistant',
        message: msg.message,
        session_id: ctx.sessionId,
        uuid: ctx.uuid(),
        parent_tool_use_id: null,
      };

    case 'user':
      return {
        type: 'user',
        message: msg.message,
        session_id: ctx.sessionId,
        uuid: ctx.uuid(),
        parent_tool_use_id: null,
      };

    case 'system':
      if (msg.subtype === 'compact_boundary') {
        return {
          type: 'system',
          subtype: 'compact_boundary',
          session_id: ctx.sessionId,
          uuid: ctx.uuid(),
        };
      }
      // permission_required / question_required / error / progress /
      // tool_completed / compact_progress are handled by the client loop.
      return null;

    default:
      return null;
  }
}

/** Build the leading `init` system message. */
export function buildInitMessage(input: SdkInitInput): SDKSystemMessage {
  return {
    type: 'system',
    subtype: 'init',
    session_id: input.sessionId,
    uuid: input.uuid,
    cwd: input.cwd,
    tools: input.tools,
    mcp_servers: input.mcpServers,
    model: input.model,
    permissionMode: input.permissionMode,
  };
}

/** Build the terminal `result` message. */
export function buildResultMessage(input: SdkResultInput): SDKResultMessage {
  return {
    type: 'result',
    subtype: input.subtype,
    is_error: input.isError,
    result: input.result,
    session_id: input.sessionId,
    uuid: input.uuid,
    duration_ms: input.durationMs,
    duration_api_ms: input.durationApiMs,
    num_turns: input.numTurns,
    total_cost_usd: input.totalCostUsd,
    usage: {
      input_tokens: input.usage.input_tokens ?? 0,
      output_tokens: input.usage.output_tokens ?? 0,
      cache_creation_input_tokens: input.usage.cache_creation_input_tokens,
      cache_read_input_tokens: input.usage.cache_read_input_tokens,
      totalCost: input.usage.totalCost,
    },
  };
}

// Re-export for consumers that need to narrow event.deferred.
export type { DeferredPermission, DeferredQuestion };
