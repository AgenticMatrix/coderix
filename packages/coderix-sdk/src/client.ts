/**
 * client.ts — CoderixSDKClient, mirroring claude-code-sdk's ClaudeSDKClient.
 *
 * A long-lived client that holds a *shared* engine template (config, model,
 * tool/MCP/agent registries) across many concurrent query() calls. Each query
 * builds its own session + QueryEngine from the template, so one client can run
 * multiple tasks in parallel and control them (setPermissionMode / interrupt)
 * independently.
 */

import { toCorePermissionMode } from '@coderix/core';
import type {
  SdkOptions as Options,
  SdkPermissionMode,
  SDKInputMessage,
  Query,
} from '@coderix/core';
import {
  buildEngineTemplate,
  buildEngineFromTemplate,
  type BuiltEngine,
  type EngineTemplate,
} from './engine-builder.js';
import { runQuery } from './run.js';

export interface ClientQueryArgs {
  prompt: string | AsyncIterable<SDKInputMessage>;
  options?: Options;
}

export class CoderixSDKClient {
  private template: EngineTemplate | undefined;
  private active = new Set<BuiltEngine>();
  private options: Options;
  private permissionMode: SdkPermissionMode;

  constructor(options: Options = {}) {
    this.options = options;
    this.permissionMode = options.permissionMode ?? 'default';
  }

  /** Build the shared engine template (tools/MCP/agents). */
  async connect(): Promise<void> {
    if (this.template) return;
    this.template = await buildEngineTemplate(this.options);
  }

  /**
   * Start a query. Each call builds an independent engine from the shared
   * template, so concurrent queries never serialize on a single engine.
   */
  query({ prompt, options }: ClientQueryArgs): Query {
    if (!this.template) {
      throw new Error('CoderixSDKClient.connect() must be called before query()');
    }
    const template = this.template;
    const active = this.active;
    const merged: Options = {
      ...this.options,
      ...options,
      permissionMode: options?.permissionMode ?? this.permissionMode,
    };

    return (async function* () {
      const built = await buildEngineFromTemplate(template, merged);
      active.add(built);
      try {
        yield* runQuery(built.engine, prompt, merged, {
          sessionId: built.sessionManager.getActive()?.id ?? '',
          model: built.model,
          tools: built.toolRegistry.names,
          mcpServers: built.mcpServerNames,
          permissionMode: (merged.permissionMode ?? 'default') as SdkPermissionMode,
          cwd: built.cwd,
        });
      } finally {
        active.delete(built);
        await built.dispose();
      }
    })();
  }

  /** Change permission mode on every active engine (and as the default for new queries). */
  setPermissionMode(mode: SdkPermissionMode): void {
    this.permissionMode = mode;
    for (const built of this.active) {
      built.engine.setPermissionMode(toCorePermissionMode(mode));
    }
  }

  /** Interrupt every currently running turn. */
  interrupt(): void {
    for (const built of this.active) {
      built.engine.interrupt();
    }
  }

  /** Tear down all engines and close MCP connections. */
  async disconnect(): Promise<void> {
    for (const built of this.active) {
      built.engine.interrupt();
    }
    await Promise.allSettled([...this.active].map((built) => built.dispose()));
    this.active.clear();

    if (this.template) {
      await this.template.dispose();
      this.template = undefined;
    }
  }
}
