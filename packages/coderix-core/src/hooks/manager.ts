/**
 * manager.ts — HookManager
 *
 * Replaces the stub at src/core/hooks.ts with a fully functional,
 * pluggable hook system.  Public method signatures accept ...args
 * (same as the original stub) so that query.ts and query-engine.ts
 * need ZERO changes beyond import paths.
 *
 * Each method:
 *   1. Checks if any hooks are configured for its event (fast-path)
 *   2. Builds a typed HookContext from positional args
 *   3. Runs matching hooks through all registered HookProviders
 *   4. Merges results (first blocked=true wins, etc.)
 *   5. Fail-open — any error returns the permissive default
 */

import { HookLoader, type HookLoaderConfig } from './loader.js';
import { ScriptProvider } from './providers/script.js';
import type {
  HookProvider,
  HookDefinition,
  HookManagerConfig,
  HookContext,
  // Context types
  PreToolUseContext,
  PostToolUseContext,
  PostToolUseFailureContext,
  PostToolBatchContext,
  UserPromptSubmitContext,
  UserPromptExpansionContext,
  PermissionRequestContext,
  PermissionDeniedContext,
  PreMessageContext,
  StopContext,
  StopFailureContext,
  PreCompactContext,
  PostCompactContext,
  NotificationContext,
  SetupContext,
  ConfigChangeContext,
  WorktreeCreateContext,
  WorktreeRemoveContext,
  // Result types
  PreToolUseResult,
  PermissionRequestResult,
  UserPromptSubmitResult,
  UserPromptExpansionResult,
  PreMessageResult,
  StopResult,
  PreCompactResult,
  WorktreeCreateHookResult,
  WorktreeRemoveHookResult,
} from './types.js';

// ═══════════════════════════════════════════════════════════════════
// HookManager
// ═══════════════════════════════════════════════════════════════════

export class HookManager {
  private loader: HookLoader;
  private providers: HookProvider[];

  constructor(config: HookManagerConfig = {}) {
    this.loader = new HookLoader({
      globalConfigPath: config.globalConfigPath,
      projectConfigPath: config.projectConfigPath,
    });
    this.providers = config.providers ?? [new ScriptProvider()];

    if (config.autoLoad !== false) {
      this.loader.load();
    }
  }

  // ── Public utility ─────────────────────────────────────────────

  reload(): void {
    this.loader.reload();
  }

  registerProvider(provider: HookProvider): void {
    this.providers.push(provider);
  }

  // ── Lifecycle hooks ────────────────────────────────────────────

  async onSetup(..._args: unknown[]): Promise<void> {
    const hooks = this.loader.getForEvent('onSetup');
    if (!hooks.length) return;

    const [sessionId, cwd] = _args as [string, string, ...unknown[]];
    const ctx: HookContext = {
      event: 'onSetup',
      sessionId: sessionId ?? '',
      cwd: cwd ?? '',
      timestamp: Date.now(),
    } as SetupContext;

    for (const hook of hooks) {
      try { await this.runProviders(hook, ctx); } catch {}
    }
  }

  async onConfigChange(..._args: unknown[]): Promise<void> {
    const hooks = this.loader.getForEvent('onConfigChange');
    if (!hooks.length) return;
    const [sessionId, cwd, key, newValue] = _args;
    const ctx: HookContext = {
      event: 'onConfigChange',
      sessionId: String(sessionId ?? ''),
      cwd: String(cwd ?? ''),
      timestamp: Date.now(),
      key: String(key ?? ''),
      newValue: typeof newValue === 'string' ? newValue : JSON.stringify(newValue ?? ''),
    } as ConfigChangeContext;
    for (const hook of hooks) {
      try { await this.runProviders(hook, ctx); } catch {}
    }
  }

  // ── User prompt hooks ──────────────────────────────────────────

  async onUserPromptSubmit(..._args: unknown[]): Promise<UserPromptSubmitResult> {
    const hooks = this.loader.getForEvent('onUserPromptSubmit');
    if (!hooks.length) return { blocked: false };

    const [sessionId, cwd, prompt] = _args;
    const ctx: HookContext = {
      event: 'onUserPromptSubmit',
      sessionId: String(sessionId ?? ''),
      cwd: String(cwd ?? ''),
      timestamp: Date.now(),
      prompt: String(prompt ?? ''),
    } as UserPromptSubmitContext;

    for (const hook of hooks) {
      try {
        const r = await this.runProviders(hook, ctx) as Partial<UserPromptSubmitResult>;
        if (r.blocked) return { blocked: true, blockReason: r.blockReason };
        if (r.augmentedPrompt) return { blocked: false, augmentedPrompt: r.augmentedPrompt };
      } catch {}
    }
    return { blocked: false };
  }

  async onUserPromptExpansion(..._args: unknown[]): Promise<UserPromptExpansionResult> {
    const hooks = this.loader.getForEvent('onUserPromptExpansion');
    if (!hooks.length) return { blocked: false };

    const [sessionId, cwd, prompt] = _args;
    const ctx: HookContext = {
      event: 'onUserPromptExpansion',
      sessionId: String(sessionId ?? ''),
      cwd: String(cwd ?? ''),
      timestamp: Date.now(),
      prompt: String(prompt ?? ''),
    } as UserPromptExpansionContext;

    for (const hook of hooks) {
      try {
        const r = await this.runProviders(hook, ctx) as Partial<UserPromptExpansionResult>;
        if (r.blocked) return { blocked: true, blockReason: r.blockReason };
        if (r.expandedPromptOverride) return { blocked: false, expandedPromptOverride: r.expandedPromptOverride };
      } catch {}
    }
    return { blocked: false };
  }

  // ── Message hooks ──────────────────────────────────────────────

  async onPreMessage(..._args: unknown[]): Promise<PreMessageResult> {
    const hooks = this.loader.getForEvent('onPreMessage');
    if (!hooks.length) return { blocked: false };

    const [sessionId, cwd, , systemPrompt] = _args;
    const ctx: HookContext = {
      event: 'onPreMessage',
      sessionId: String(sessionId ?? ''),
      cwd: String(cwd ?? ''),
      timestamp: Date.now(),
      messageCount: Number(_args[2]) || 0,
      systemPromptLength: typeof systemPrompt === 'string' ? systemPrompt.length : 0,
    } as PreMessageContext;

    for (const hook of hooks) {
      try {
        const r = await this.runProviders(hook, ctx) as Partial<PreMessageResult>;
        if (r.blocked) return { blocked: true, blockReason: r.blockReason };
        if (r.modifiedSystemPrompt || r.injectContext) return r as PreMessageResult;
      } catch {}
    }
    return { blocked: false };
  }

  async onPostMessage(..._args: unknown[]): Promise<{ saveToMemory?: boolean }> {
    const hooks = this.loader.getForEvent('onPostMessage');
    if (!hooks.length) return {};
    // Lightweight fire-and-forget — build context and run hooks
    const [sessionId, cwd] = _args;
    const ctx: HookContext = {
      event: 'onPostMessage',
      sessionId: String(sessionId ?? ''),
      cwd: String(cwd ?? ''),
      timestamp: Date.now(),
      messageCount: Number(_args[2]) || 0,
      turnCount: Number(_args[3]) || 0,
      hasOutput: Boolean(_args[4]),
    } as HookContext;
    for (const hook of hooks) {
      try { await this.runProviders(hook, ctx); } catch {}
    }
    return {};
  }

  // ── Tool hooks ─────────────────────────────────────────────────

  async onPreToolUse(..._args: unknown[]): Promise<PreToolUseResult> {
    const hooks = this.loader.getForEvent('PreToolUse');
    if (!hooks.length) return { blocked: false };

    const [sessionId, cwd, toolName, toolInput] = _args;
    const ctx: HookContext = {
      event: 'PreToolUse',
      sessionId: String(sessionId ?? ''),
      cwd: String(cwd ?? ''),
      timestamp: Date.now(),
      toolName: String(toolName ?? ''),
      toolInput: (toolInput as Record<string, unknown>) ?? {},
    } as PreToolUseContext;

    for (const hook of hooks) {
      if (!this.matches(hook, String(toolName ?? ''))) continue;
      try {
        const r = await this.runProviders(hook, ctx) as Partial<PreToolUseResult>;
        if (r.blocked) {
          return { blocked: true, reason: r.reason ?? `Blocked by PreToolUse hook` };
        }
      } catch {}
    }
    return { blocked: false };
  }

  async onPostToolUse(..._args: unknown[]): Promise<void> {
    const hooks = this.loader.getForEvent('PostToolUse');
    if (!hooks.length) return;

    const [sessionId, cwd, toolName, toolInput, resultObj] = _args;
    const isError = !(resultObj as Record<string, unknown>)?.success;
    const resultStr = typeof resultObj === 'string'
      ? resultObj
      : JSON.stringify((resultObj as Record<string, unknown>)?.output ?? resultObj);

    const ctx: HookContext = {
      event: 'PostToolUse',
      sessionId: String(sessionId ?? ''),
      cwd: String(cwd ?? ''),
      timestamp: Date.now(),
      toolName: String(toolName ?? ''),
      toolInput: (toolInput as Record<string, unknown>) ?? {},
      result: resultStr,
      isError,
    } as PostToolUseContext;

    for (const hook of hooks) {
      if (!this.matches(hook, String(toolName ?? ''))) continue;
      try { await this.runProviders(hook, ctx); } catch {}
    }
  }

  async onPostToolUseFailure(..._args: unknown[]): Promise<void> {
    const hooks = this.loader.getForEvent('PostToolUseFailure');
    if (!hooks.length) return;

    const [sessionId, cwd, toolName, toolInput, error] = _args;
    const errMsg = error instanceof Error ? error.message : String(error ?? '');

    const ctx: HookContext = {
      event: 'PostToolUseFailure',
      sessionId: String(sessionId ?? ''),
      cwd: String(cwd ?? ''),
      timestamp: Date.now(),
      toolName: String(toolName ?? ''),
      toolInput: (toolInput as Record<string, unknown>) ?? {},
      error: errMsg,
    } as PostToolUseFailureContext;

    for (const hook of hooks) {
      if (!this.matches(hook, String(toolName ?? ''))) continue;
      try { await this.runProviders(hook, ctx); } catch {}
    }
  }

  async onPostToolBatch(..._args: unknown[]): Promise<void> {
    const hooks = this.loader.getForEvent('PostToolBatch');
    if (!hooks.length) return;

    const [sessionId, cwd, batchResults] = _args;
    // query.ts passes { toolName, success, durationMs, summary }[]
    // Normalise to { toolName, isError, summary }
    const raw = (batchResults as Array<Record<string, unknown>>) ?? [];
    const normalized = raw.map((r) => ({
      toolName: String(r.toolName ?? ''),
      isError: !r.success,
      summary: String(r.summary ?? ''),
    }));

    const ctx: HookContext = {
      event: 'PostToolBatch',
      sessionId: String(sessionId ?? ''),
      cwd: String(cwd ?? ''),
      timestamp: Date.now(),
      results: normalized,
    } as PostToolBatchContext;

    for (const hook of hooks) {
      try { await this.runProviders(hook, ctx); } catch {}
    }
  }

  // ── Permission hooks ───────────────────────────────────────────

  async onPermissionRequest(..._args: unknown[]): Promise<PermissionRequestResult> {
    const hooks = this.loader.getForEvent('onPermissionRequest');
    if (!hooks.length) return {};

    const [sessionId, cwd, toolName, toolInput, riskLevel, defaultBehavior] = _args;
    const ctx: HookContext = {
      event: 'onPermissionRequest',
      sessionId: String(sessionId ?? ''),
      cwd: String(cwd ?? ''),
      timestamp: Date.now(),
      toolName: String(toolName ?? ''),
      toolInput: (toolInput as Record<string, unknown>) ?? {},
      riskLevel: String(riskLevel ?? ''),
      defaultBehavior: String(defaultBehavior ?? ''),
    } as PermissionRequestContext;

    for (const hook of hooks) {
      if (!this.matches(hook, String(toolName ?? ''))) continue;
      try {
        const r = await this.runProviders(hook, ctx) as Partial<PermissionRequestResult>;
        if (r.permissionOverride) return r;
      } catch {}
    }
    return {};
  }

  async onPermissionDenied(..._args: unknown[]): Promise<void> {
    const hooks = this.loader.getForEvent('onPermissionDenied');
    if (!hooks.length) return;

    const [sessionId, cwd, toolName, toolInput, reason] = _args;
    const ctx: HookContext = {
      event: 'onPermissionDenied',
      sessionId: String(sessionId ?? ''),
      cwd: String(cwd ?? ''),
      timestamp: Date.now(),
      toolName: String(toolName ?? ''),
      toolInput: (toolInput as Record<string, unknown>) ?? {},
      reason: String(reason ?? ''),
    } as PermissionDeniedContext;

    for (const hook of hooks) {
      if (!this.matches(hook, String(toolName ?? ''))) continue;
      try { await this.runProviders(hook, ctx); } catch {}
    }
  }

  // ── Stop hooks ─────────────────────────────────────────────────

  async onStop(..._args: unknown[]): Promise<StopResult> {
    const hooks = this.loader.getForEvent('onStop');
    if (!hooks.length) return { shouldStop: false };

    const [sessionId, cwd, turnCount] = _args;
    const ctx: HookContext = {
      event: 'onStop',
      sessionId: String(sessionId ?? ''),
      cwd: String(cwd ?? ''),
      timestamp: Date.now(),
      turnCount: Number(turnCount) || 0,
    } as StopContext;

    for (const hook of hooks) {
      try {
        const r = await this.runProviders(hook, ctx) as Partial<StopResult>;
        if (r.shouldStop) return { shouldStop: true };
      } catch {}
    }
    return { shouldStop: false };
  }

  async onStopFailure(..._args: unknown[]): Promise<void> {
    const hooks = this.loader.getForEvent('onStopFailure');
    if (!hooks.length) return;

    const [sessionId, cwd, error] = _args;
    const errObj = error as { message?: string; code?: string; status?: number } | undefined;
    const ctx: HookContext = {
      event: 'onStopFailure',
      sessionId: String(sessionId ?? ''),
      cwd: String(cwd ?? ''),
      timestamp: Date.now(),
      errorMessage: errObj?.message ?? String(error ?? ''),
      errorCode: errObj?.code,
      turnCount: Number(_args[3]) || 0,
    } as StopFailureContext;

    for (const hook of hooks) {
      try { await this.runProviders(hook, ctx); } catch {}
    }
  }

  // ── Compaction hooks ───────────────────────────────────────────

  async onPreCompact(..._args: unknown[]): Promise<PreCompactResult> {
    const hooks = this.loader.getForEvent('onPreCompact');
    if (!hooks.length) return { injectContext: '' };

    const [sessionId, cwd, messageCount, currentTokens, maxTokens, strategy] = _args;
    const ctx: HookContext = {
      event: 'onPreCompact',
      sessionId: String(sessionId ?? ''),
      cwd: String(cwd ?? ''),
      timestamp: Date.now(),
      messageCount: Number(messageCount) || 0,
      currentTokens: Number(currentTokens) || 0,
      maxTokens: Number(maxTokens) || 0,
      strategy: String(strategy ?? ''),
    } as PreCompactContext;

    let injectContext = '';
    for (const hook of hooks) {
      try {
        const r = await this.runProviders(hook, ctx) as Partial<PreCompactResult>;
        if (r.injectContext) {
          injectContext += (injectContext ? '\n' : '') + r.injectContext;
        }
      } catch {}
    }
    return { injectContext };
  }

  async onPostCompact(..._args: unknown[]): Promise<void> {
    const hooks = this.loader.getForEvent('onPostCompact');
    if (!hooks.length) return;

    const [sessionId, cwd] = _args;
    const ctx: HookContext = {
      event: 'onPostCompact',
      sessionId: String(sessionId ?? ''),
      cwd: String(cwd ?? ''),
      timestamp: Date.now(),
      messageCountBefore: Number(_args[2]) || 0,
      messageCountAfter: Number(_args[3]) || 0,
      tokensSaved: Number(_args[4]) || 0,
      strategy: String(_args[5] ?? ''),
      preCompactTokens: Number(_args[6]) || 0,
      postCompactTokens: Number(_args[7]) || 0,
    } as PostCompactContext;

    for (const hook of hooks) {
      try { await this.runProviders(hook, ctx); } catch {}
    }
  }

  // ── Notification hook ──────────────────────────────────────────

  async onNotification(..._args: unknown[]): Promise<void> {
    const hooks = this.loader.getForEvent('onNotification');
    if (!hooks.length) return;

    const [sessionId, cwd, severity, message] = _args;
    const ctx: HookContext = {
      event: 'onNotification',
      sessionId: String(sessionId ?? ''),
      cwd: String(cwd ?? ''),
      timestamp: Date.now(),
      message: String(message ?? _args[3] ?? ''),
      severity: (['info', 'warn', 'error'].includes(String(severity)) ? String(severity) : 'info') as 'info' | 'warn' | 'error',
    } as NotificationContext;

    for (const hook of hooks) {
      try { await this.runProviders(hook, ctx); } catch {}
    }
  }

  // ── Worktree hooks (run outside REPL for VCS isolation) ──────────

  /**
   * Check if any WorktreeCreate hooks are configured.
   * Returns true if hooks exist for alternative VCS worktree creation.
   */
  hasWorktreeCreateHook(): boolean {
    return this.loader.getForEvent('WorktreeCreate').length > 0;
  }

  /**
   * Execute WorktreeCreate hooks to create a worktree via user-configured VCS.
   * Returns the worktree path from the first successful hook.
   * Throws if hooks fail or produce no output.
   */
  async onWorktreeCreate(sessionId: string, cwd: string, name: string): Promise<WorktreeCreateHookResult | null> {
    const hooks = this.loader.getForEvent('WorktreeCreate');
    if (!hooks.length) return null;

    const ctx: HookContext = {
      event: 'WorktreeCreate',
      sessionId,
      cwd,
      timestamp: Date.now(),
      name,
    } as WorktreeCreateContext;

    const successfulPaths: string[] = [];
    const errors: string[] = [];

    for (const hook of hooks) {
      try {
        const result = await this.runProviders(hook, ctx) as Partial<WorktreeCreateHookResult>;
        if (result.worktreePath) {
          successfulPaths.push(result.worktreePath);
        }
      } catch (err) {
        errors.push(`${hook.command ?? 'hook'}: ${(err as Error).message}`);
      }
    }

    if (successfulPaths.length > 0) {
      return { worktreePath: successfulPaths[0] };
    }

    if (errors.length > 0) {
      throw new Error(
        `WorktreeCreate hook(s) failed: ${errors.join('; ') || 'no successful output'}`,
      );
    }

    return null;
  }

  /**
   * Execute WorktreeRemove hooks to remove a worktree via user-configured VCS.
   * Returns true if hooks ran, false if no hooks are configured.
   */
  async onWorktreeRemove(sessionId: string, cwd: string, worktreePath: string): Promise<boolean> {
    const hooks = this.loader.getForEvent('WorktreeRemove');
    if (!hooks.length) return false;

    const ctx: HookContext = {
      event: 'WorktreeRemove',
      sessionId,
      cwd,
      timestamp: Date.now(),
      worktreePath,
    } as WorktreeRemoveContext;

    for (const hook of hooks) {
      try {
        await this.runProviders(hook, ctx);
      } catch {
        // Hook failure is non-fatal for removal
      }
    }

    return true;
  }

  // ── Private helpers ────────────────────────────────────────────

  private matches(hook: HookDefinition, toolName: string): boolean {
    if (!hook.match) return true;
    if (hook.match.toolName && hook.match.toolName !== toolName) return false;
    return true;
  }

  /**
   * Run a hook through all registered providers in order.
   * Returns the first non-empty result from any provider.
   * Returns {} when all providers return empty or fail.
   */
  private async runProviders(
    hook: HookDefinition,
    context: HookContext,
  ): Promise<Partial<Record<string, unknown>>> {
    for (const provider of this.providers) {
      try {
        const result = await provider.execute(hook, context);
        if (result && Object.keys(result).length > 0) {
          return result as Partial<Record<string, unknown>>;
        }
      } catch {
        // Provider failure → try next
      }
    }
    return {};
  }
}
