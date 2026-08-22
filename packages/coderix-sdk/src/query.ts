/**
 * query.ts — one-shot query() entry point, mirroring claude-code-sdk.
 *
 * `for await (const message of query({ prompt, options }))` yields
 * claude-code-sdk-shaped SDKMessage objects (system/assistant/user/
 * result/stream_event). The engine is built lazily on first iteration
 * and disposed when the generator ends.
 */

import type { SdkOptions as Options, SdkPermissionMode, SDKInputMessage, Query } from '@coderix/core';
import { buildEngine } from './engine-builder.js';
import { runQuery } from './run.js';

export interface QueryArgs {
  prompt: string | AsyncIterable<SDKInputMessage>;
  options?: Options;
}

export function query({ prompt, options = {} }: QueryArgs): Query {
  return (async function* () {
    const built = await buildEngine(options);
    try {
      yield* runQuery(built.engine, prompt, options, {
        sessionId: built.sessionManager.getActive()?.id ?? '',
        model: built.model,
        tools: built.toolRegistry.names,
        mcpServers: built.mcpServerNames,
        permissionMode: (options.permissionMode ?? 'default') as SdkPermissionMode,
        cwd: built.cwd,
      });
    } finally {
      await built.dispose();
    }
  })();
}
