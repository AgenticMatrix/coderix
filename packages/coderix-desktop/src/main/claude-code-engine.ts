/**
 * claude-code-engine.ts — Claude Code agent engine.
 *
 * Wraps the official `@anthropic-ai/claude-agent-sdk` `query()` (which spawns
 * the `claude` CLI) and maps its SDKMessage stream onto the same
 * `QueryEngineEvent` shape the in-process Coderix engine produces. The
 * ipc-bridge streaming loop therefore consumes both engines identically.
 *
 * Tools run under the permission mode resolved for the current project (mapped
 * from Coderix's plan/ask/auto/low onto the SDK's PermissionMode) rather than a
 * fixed `bypassPermissions`, so the Coderix permission setting actually applies
 * to Claude Code.
 */

import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import type { Options, HookCallback, HookCallbackMatcher, PermissionMode as SdkPermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { QueryEngineEvent } from '@coderix/core';
import { PermissionMode } from '@coderix/core';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { extractOpenUrl } from './open-url.js';
import { resolveClaudeCodeBaseUrl } from './protocol-gateway/routing.js';

/**
 * Tracks the last Claude Code session id used by each Coderix session so
 * follow-up turns resume the same conversation instead of starting fresh.
 */
const claudeSessionByCoderixSession = new Map<string, string>();

export interface ClaudeCodeQueryOptions {
  prompt: string;
  /** Coderix session id — used as the resume key across turns. */
  sessionId: string;
  cwd: string;
  /** Coderix permission mode for this turn (plan/ask/auto/low). Defaults to 'ask'. */
  permissionMode?: PermissionMode;
  model?: string;
  /** Resolved provider endpoint (base_url) for the active model, from model_list. */
  baseUrl?: string;
  /** Resolved API key / auth token for the active model. */
  apiKey?: string;
  /**
   * Wire protocol of the active model's endpoint. The `claude` CLI only speaks
   * the Anthropic Messages API, so an `openai` protocol model (e.g. a relay
   * whose base_url ends in `/v1`) is repointed at the in-process protocol
   * gateway, which converts anthropic → openai on the wire.
   */
  protocol?: 'anthropic' | 'openai';
  abortController: AbortController;
  /**
   * When provided, the model's `AskUserQuestion` tool calls are forwarded here
   * instead of being auto-denied. Returns the user's answers keyed by the
   * question `header` (values are string, or string[] for multi-select).
   */
  onAskUserQuestion?: (req: AskUserQuestionRequest) => Promise<Record<string, string | string[]>>;
  /**
   * When provided, Claude Code's permission prompts (`can_use_tool`) are
   * forwarded here instead of being auto-denied. Resolves once the host answers
   * allow/deny.
   */
  onPermissionRequest?: (req: ClaudePermissionRequest) => Promise<ClaudePermissionResponse>;
  /**
   * When provided, a URL the model tried to open in the system browser (via a
   * `Bash` `open` / `xdg-open` / `start` command) is forwarded here instead, so
   * the host can open it in Coderix's embedded browser rather than the OS
   * default (e.g. Google Chrome).
   */
  onOpenUrl?: (url: string) => void;
}

/** One question from the model's `AskUserQuestion` tool input. */
export interface AskUserQuestionRequest {
  toolUseId: string;
  questions: Array<{
    header: string;
    question: string;
    options?: Array<{ label: string; description: string }>;
    multiSelect?: boolean;
  }>;
}

/** A permission prompt surfaced by Claude Code's `can_use_tool`. */
export interface ClaudePermissionRequest {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  title?: string;
  displayName?: string;
  description?: string;
}

export interface ClaudePermissionResponse {
  behavior: 'allow' | 'deny';
  message?: string;
}

/**
 * Build a `PreToolUse` hook that intercepts `AskUserQuestion`. Without this,
 * the tool is marked `requiresUserInteraction`, so in `bypassPermissions` mode
 * the SDK auto-denies it and the user never sees the question. The hook pauses
 * the tool call until the host answers (via `onAskUserQuestion`), then injects
 * the answers as `updatedInput.answers` — the field the Claude Code tool reads
 * to short-circuit its interactive prompt (question text → answer string,
 * multi-select comma-joined).
 */
function buildAskUserQuestionHook(
  onAsk: (req: AskUserQuestionRequest) => Promise<Record<string, string | string[]>>,
  abortController: AbortController,
): HookCallback {
  return async (input) => {
    const i = input as unknown as { tool_input?: unknown; tool_use_id?: string };
    const toolInput = (i.tool_input as Record<string, unknown>) || {};
    const questions = (toolInput.questions as AskUserQuestionRequest['questions']) || [];
    console.log('[AskUserQuestion] PreToolUse hook FIRED', {
      tool_use_id: i.tool_use_id,
      tool_input: toolInput,
    });

    // Wait for the host to answer (or the turn to be aborted).
    const byHeader = await new Promise<Record<string, string | string[]>>((resolve) => {
      let settled = false;
      const done = (v: Record<string, string | string[]>): void => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      onAsk({ toolUseId: i.tool_use_id ?? '', questions }).then(done, () => done({}));
      abortController.signal.addEventListener('abort', () => done({}), { once: true });
    });
    console.log('[AskUserQuestion] resolved answers (byHeader):', byHeader);

    // The host answers keyed by `header`; Claude Code keys by question text.
    const answers: Record<string, string> = {};
    for (const q of questions) {
      const v = byHeader[q.header];
      if (v === undefined || v === null) continue;
      answers[q.question] = Array.isArray(v) ? v.join(', ') : v;
    }

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { ...toolInput, answers },
      },
    };
  };
}

/**
 * Build a `PreToolUse` hook for the `Bash` tool that redirects browser-open
 * commands to the embedded browser. Non-open commands are left untouched (the
 * hook returns no opinion, so the normal `canUseTool` permission flow applies).
 */
function buildOpenUrlHook(onOpenUrl: (url: string) => void, cwd: string): HookCallback {
  return async (input) => {
    const i = input as unknown as { tool_input?: unknown };
    const toolInput = (i.tool_input as Record<string, unknown>) || {};
    const command = typeof toolInput.command === 'string' ? toolInput.command : '';
    const url = extractOpenUrl(command, cwd);
    if (!url) return {};

    onOpenUrl(url);
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Opened in the embedded browser: ${url}`,
      },
    };
  };
}

/**
 * Resolve the `claude` CLI executable the SDK should spawn.
 *
 * The SDK normally locates its bundled native binary via
 * `createRequire(import.meta.url).resolve(...)`, but that breaks under
 * pnpm's strict node_modules layout (the platform-specific package is a
 * sibling in the virtual store, not reachable from the SDK's `require` walk)
 * and under electron-vite bundling (where `import.meta.url` points at the
 * bundle rather than the SDK). So we resolve it ourselves and pass it through
 * `pathToClaudeCodeExecutable`.
 */
function resolveClaudeCodeExecutable(): string | undefined {
  const scope = '@anthropic-ai';
  const pkgName = `claude-agent-sdk-${process.platform}-${process.arch}`;
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const req = createRequire(import.meta.url);

  // 1. npm/yarn flat layout — platform package is directly resolvable.
  try {
    const pkgJson = req.resolve(`${scope}/${pkgName}/package.json`);
    const bin = join(dirname(pkgJson), exe);
    if (existsSync(bin)) return bin;
  } catch {
    /* not resolvable in this layout */
  }

  // 2. pnpm strict layout — the platform package is a sibling of the SDK in
  //    the virtual store: <store>/node_modules/@anthropic-ai/<pkgName>/<exe>.
  try {
    const sdkEntry = req.resolve(`${scope}/claude-agent-sdk`);
    // sdkEntry: .../node_modules/@anthropic-ai/claude-agent-sdk/<entry>
    const storeNodeModules = dirname(dirname(dirname(sdkEntry)));
    const bin = join(storeNodeModules, scope, pkgName, exe);
    if (existsSync(bin)) return bin;
  } catch {
    /* SDK not resolvable — fall through to PATH lookup */
  }

  // 3. User-installed `claude` CLI on PATH.
  try {
    const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], {
      encoding: 'utf-8',
    });
    const found = which.stdout?.trim().split(/\r?\n/)[0];
    if (found && existsSync(found)) return found;
  } catch {
    /* ignore */
  }

  // 4. Common install locations.
  const candidates = [
    join(homedir(), '.local', 'bin', 'claude'),
    join(homedir(), '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return undefined;
}

/**
 * Map a Coderix permission mode onto the SDK's `PermissionMode`.
 *
 *   plan → plan                (planning mode, no tool execution)
 *   ask  → default             (standard, prompt before dangerous operations)
 *   auto → bypassPermissions   (skip all permission checks)
 *   low  → dontAsk             (don't prompt, deny unless pre-approved)
 */
function mapPermissionMode(mode: PermissionMode): SdkPermissionMode {
  switch (mode) {
    case 'plan':
      return 'plan';
    case 'auto':
      return 'bypassPermissions';
    case 'low':
      return 'dontAsk';
    case 'ask':
    default:
      return 'default';
  }
}

export async function* runClaudeCodeQuery(
  opts: ClaudeCodeQueryOptions,
): AsyncGenerator<QueryEngineEvent> {
  const { prompt, sessionId, cwd, model, baseUrl, apiKey, permissionMode, protocol, abortController, onAskUserQuestion, onPermissionRequest, onOpenUrl } = opts;

  const resume = claudeSessionByCoderixSession.get(sessionId);
  const pathToClaudeCodeExecutable = resolveClaudeCodeExecutable();

  if (!pathToClaudeCodeExecutable) {
    yield {
      type: 'error',
      data: {
        message:
          '未找到 Claude Code CLI 可执行文件。请安装 `@anthropic-ai/claude-agent-sdk` 的原生二进制（不要使用 --omit=optional），或先安装 `claude` CLI。',
      },
    };
    return;
  }

  const sdkMode = mapPermissionMode(permissionMode ?? PermissionMode.ASK);
  const options: Options = {
    cwd,
    permissionMode: sdkMode,
    allowDangerouslySkipPermissions: sdkMode === 'bypassPermissions',
    includePartialMessages: true,
    abortController,
    settingSources: ['user', 'project'],
    pathToClaudeCodeExecutable,
  };
  if (model) options.model = model;
  // Per-model endpoint/auth: point the spawned `claude` CLI at the active
  // model's baseUrl/apiKey from model_list instead of the global
  // ~/.claude/settings.json the claude-code engine otherwise falls back to.
  // The SDK replaces (not merges) process.env when `env` is set, so spread it.
  if (baseUrl || apiKey) {
    options.env = {
      ...process.env,
      ...(baseUrl ? { ANTHROPIC_BASE_URL: resolveClaudeCodeBaseUrl(model ?? '', baseUrl, protocol ?? 'anthropic') } : {}),
      ...(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}),
    };
  }
  if (resume) options.resume = resume;
  const preToolUseHooks: HookCallbackMatcher[] = [];
  if (onAskUserQuestion) {
    preToolUseHooks.push({
      matcher: 'AskUserQuestion',
      hooks: [buildAskUserQuestionHook(onAskUserQuestion, abortController)],
    });
    console.log('[AskUserQuestion] registered PreToolUse hook (matcher: AskUserQuestion)');
  } else {
    console.log('[AskUserQuestion] onAskUserQuestion NOT provided — hook NOT registered');
  }
  if (onOpenUrl) {
    preToolUseHooks.push({
      matcher: 'Bash',
      hooks: [buildOpenUrlHook(onOpenUrl, cwd)],
    });
    console.log('[OpenUrl] registered PreToolUse hook (matcher: Bash)');
  }
  if (preToolUseHooks.length > 0) {
    options.hooks = { PreToolUse: preToolUseHooks };
  }
  if (onPermissionRequest) {
    options.canUseTool = async (toolName, input, { signal, toolUseID, title, displayName, description }) => {
      const res = await new Promise<ClaudePermissionResponse>((resolve) => {
        let settled = false;
        const done = (v: ClaudePermissionResponse): void => {
          if (settled) return;
          settled = true;
          resolve(v);
        };
        onPermissionRequest({ toolUseId: toolUseID, toolName, input, title, displayName, description })
          .then(done, () => done({ behavior: 'deny', message: 'Permission request failed' }));
        signal.addEventListener('abort', () => done({ behavior: 'deny', message: 'Aborted' }), { once: true });
      });
      if (res.behavior === 'allow') {
        // The Claude Code CLI (2.1.x) validates this result with a schema that
        // requires `updatedInput` to be a record even for a plain allow. Echo the
        // original input back unchanged so the shape passes validation.
        return { behavior: 'allow', updatedInput: input };
      }
      return { behavior: 'deny', message: res.message ?? 'Denied by user' };
    };
    console.log('[Permission] canUseTool registered');
  }

  const stream = claudeQuery({ prompt, options });

  try {
    for await (const msg of stream) {
      // Remember the Claude Code session id for the next turn.
      if (msg.type === 'system' && msg.subtype === 'init') {
        claudeSessionByCoderixSession.set(sessionId, msg.session_id);
        continue;
      }

      switch (msg.type) {
        case 'stream_event':
          yield { type: 'message', data: { type: 'stream_event', event: msg.event } };
          break;
        case 'assistant':
          yield { type: 'message', data: { type: 'assistant', message: msg.message } };
          break;
        case 'user':
          yield { type: 'message', data: { type: 'user', message: msg.message } };
          break;
        case 'result':
          claudeSessionByCoderixSession.set(sessionId, msg.session_id);
          if (msg.is_error) {
            const errors = (msg as { errors?: string[] }).errors;
            const message =
              errors && errors.length > 0
                ? errors.join('\n')
                : msg.subtype === 'error_max_turns'
                  ? '达到最大轮次限制'
                  : 'Claude Code 执行失败';
            yield { type: 'error', data: { message } };
          } else {
            // Emit the final result so the ipc-bridge can persist the
            // assistant turn to the Coderix session store (the in-process
            // engine does this itself; the SDK engine must hand it over).
            const result = (msg as { result?: string }).result;
            yield {
              type: 'done',
              data: {
                sessionId,
                result,
                stopReason: msg.stop_reason,
                usage: msg.usage,
                totalCost: msg.total_cost_usd,
              },
            };
          }
          break;
        default:
          // system notifications, status, tool progress, etc. — ignored.
          break;
      }
    }
  } catch (err) {
    // An interrupt surfaces as the abort signal firing — not an error.
    if (abortController.signal.aborted) return;
    throw err;
  }
}
