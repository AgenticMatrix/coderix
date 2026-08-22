/**
 * client.ts — CoderixSDKClient, mirroring claude-code-sdk's ClaudeSDKClient.
 *
 * A long-lived client that holds an engine across multiple query() calls and
 * supports runtime control (setPermissionMode / interrupt).
 */

import { toCorePermissionMode } from '@coderix/core';
import type {
  SdkOptions as Options,
  SdkPermissionMode,
  SDKInputMessage,
  Query,
} from '@coderix/core';
import { buildEngine, type BuiltEngine } from './engine-builder.js';
import { runQuery } from './run.js';

export interface ClientQueryArgs {
  prompt: string | AsyncIterable<SDKInputMessage>;
  options?: Options;
}

export class CoderixSDKClient {
  private built: BuiltEngine | undefined;
  private options: Options;

  constructor(options: Options = {}) {
    this.options = options;
  }

  /** Build and initialize the underlying engine. */
  async connect(): Promise<void> {
    if (this.built) return;
    this.built = await buildEngine(this.options);
  }

  /** Start a query against the connected engine. */
  query({ prompt, options }: ClientQueryArgs): Query {
    if (!this.built) {
      throw new Error('CoderixSDKClient.connect() must be called before query()');
    }
    const merged: Options = { ...this.options, ...options };
    return runQuery(this.built.engine, prompt, merged, {
      sessionId: this.built.sessionManager.getActive()?.id ?? '',
      model: this.built.model,
      tools: this.built.toolRegistry.names,
      mcpServers: this.built.mcpServerNames,
      permissionMode: (merged.permissionMode ?? 'default') as SdkPermissionMode,
      cwd: this.built.cwd,
    });
  }

  /** Change permission mode mid-session. */
  setPermissionMode(mode: SdkPermissionMode): void {
    this.built?.engine.setPermissionMode(toCorePermissionMode(mode));
  }

  /** Interrupt the currently running turn. */
  interrupt(): void {
    this.built?.engine.interrupt();
  }

  /** Tear down the engine and close MCP connections. */
  async disconnect(): Promise<void> {
    if (this.built) {
      await this.built.dispose();
      this.built = undefined;
    }
  }
}
