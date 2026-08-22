/**
 * run.ts — the shared query loop shared by query() and CoderixSDKClient.
 *
 * Drives QueryEngine.submitMessage(), resolves canUseTool permission
 * requests, and maps every engine event to a claude-code-sdk-shaped
 * SDKMessage.
 */

import { randomUUID } from 'node:crypto';
import {
  mapEngineEventToSdkMessage,
  buildInitMessage,
  buildResultMessage,
} from '@coderix/core';
import type {
  SDKMessage,
  SDKInputMessage,
  SdkOptions as Options,
  SdkPermissionMode,
  PermissionResult,
  PermissionUpdate,
  DeferredPermission,
  DeferredQuestion,
  CompletionUsage,
  ContentBlock,
  QueryEngine,
} from '@coderix/core';

export interface RunContext {
  sessionId: string;
  model: string;
  tools: string[];
  mcpServers: string[];
  permissionMode: SdkPermissionMode;
  cwd: string;
}

// ── Text helpers ──────────────────────────────────────────────────────

function extractText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
}

function inputText(msg: SDKInputMessage): string {
  const content = msg.message?.content;
  if (typeof content === 'string') return content;
  return '';
}

function applyPermissionUpdates(updates: PermissionUpdate[] | undefined, engine: QueryEngine): void {
  for (const update of updates ?? []) {
    if (update.type !== 'addRules') continue;
    for (const rule of update.rules) {
      engine.addPermissionRule(rule.toolName, rule.ruleContent, rule.behavior);
    }
  }
}

// ── Permission resolution ─────────────────────────────────────────────

async function resolvePermission(d: DeferredPermission, engine: QueryEngine, options: Options): Promise<boolean> {
  const canUseTool = options.canUseTool;
  if (!canUseTool) return true; // undefined = allow (claude default)

  const signal = options.abortController?.signal ?? new AbortController().signal;
  let result: PermissionResult;
  try {
    result = await canUseTool(d.toolName, d.toolInput, { signal });
  } catch (err) {
    options.stderr?.(`canUseTool threw for "${d.toolName}": ${(err as Error).message}\n`);
    return false;
  }

  if (!result || result.behavior === 'allow') {
    applyPermissionUpdates(result?.updatedPermissions, engine);
    return true;
  }

  if (result.behavior === 'deny') {
    if (result.message) options.stderr?.(`${result.message}\n`);
    applyPermissionUpdates(result.updatedPermissions, engine);
    if (result.interrupt) options.abortController?.abort();
    return false;
  }

  // 'ask' → headless SDK has no interactive prompt; allow by default (v1).
  return true;
}

// ── Main loop ─────────────────────────────────────────────────────────

export async function* runQuery(
  engine: QueryEngine,
  prompt: string | AsyncIterable<SDKInputMessage>,
  options: Options,
  ctx: RunContext,
): AsyncGenerator<SDKMessage, void, void> {
  const uuid = () => randomUUID();
  const includePartial = options.includePartialMessages ?? false;

  yield buildInitMessage({
    sessionId: ctx.sessionId,
    cwd: ctx.cwd,
    tools: ctx.tools,
    mcpServers: ctx.mcpServers,
    model: ctx.model,
    permissionMode: ctx.permissionMode,
    uuid: uuid(),
  });

  const start = Date.now();
  let numTurns = 0;
  let resultText = '';
  let totalCostUsd = 0;
  let usage: CompletionUsage = { input_tokens: 0, output_tokens: 0 };
  let errorMessage: string | undefined;

  const submit = async function* (text: string): AsyncGenerator<SDKMessage, void, void> {
    for await (const event of engine.submitMessage(text)) {
      if (event.type === 'permission_required') {
        const d = event.deferred as DeferredPermission;
        const allowed = await resolvePermission(d, engine, options);
        d.resolve(allowed);
        continue;
      }
      if (event.type === 'question_required') {
        // v1: no interactive question surface — resolve with empty answers.
        (event.deferred as DeferredQuestion).resolve({});
        continue;
      }
      if (event.type === 'error') {
        const data = event.data as { message?: string } | undefined;
        errorMessage = data?.message ?? 'Unknown error';
        return;
      }
      if (event.type === 'cost') {
        const data = event.data as { totalCost?: number } | undefined;
        if (typeof data?.totalCost === 'number') totalCostUsd = data.totalCost;
        continue;
      }
      if (event.type === 'done' || event.type === 'queued') continue;

      const mapped = mapEngineEventToSdkMessage(event, { sessionId: ctx.sessionId, includePartialMessages: includePartial, uuid });
      if (!mapped) continue;

      if (mapped.type === 'assistant') {
        numTurns++;
        totalCostUsd += mapped.message.usage?.totalCost ?? 0;
        usage = mapped.message.usage;
        resultText = appendUnique(resultText, extractText(mapped.message.content));
      } else if (mapped.type === 'stream_event') {
        const ev = mapped.event;
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          resultText += ev.delta.text;
        } else if (ev.type === 'cost_update') {
          totalCostUsd = ev.totalCost;
        }
      }

      yield mapped;
    }
  };

  if (typeof prompt === 'string') {
    yield* submit(prompt);
  } else {
    for await (const msg of prompt) {
      const text = inputText(msg);
      if (text) yield* submit(text);
    }
  }

  const durationMs = Date.now() - start;
  yield buildResultMessage({
    sessionId: ctx.sessionId,
    uuid: uuid(),
    subtype: errorMessage ? 'error_during_execution' : 'success',
    isError: !!errorMessage,
    result: errorMessage ? `${resultText}${resultText ? '\n' : ''}${errorMessage}` : resultText,
    durationMs,
    durationApiMs: 0,
    numTurns,
    totalCostUsd,
    usage,
  });
}

/** Append text that isn't already a suffix (avoids duplicating streamed + final text). */
function appendUnique(acc: string, text: string): string {
  if (!text) return acc;
  if (acc.endsWith(text)) return acc;
  if (text.endsWith(acc) && acc.length > 0) return text;
  return acc + text;
}
