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

import { query as claudeQuery, getSubagentMessages, getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import type { Options, HookCallback, HookCallbackMatcher, PermissionMode as SdkPermissionMode, SpawnOptions, SpawnedProcess, SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk';
import type { QueryEngineEvent, Message } from '@coderix/core';
import { PermissionMode } from '@coderix/core';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { extractOpenUrl } from './open-url.js';
import { resolveClaudeCodeBaseUrl } from './protocol-gateway/routing.js';
import { CUSTOM_SKILL_SHIM_DIR, refreshCustomSkillShim } from './skills.js';
import { listRegisteredPluginDirs } from './plugin-registry.js';
import { findClaudeCodeBinary, ensureClaudeCodeInstalled } from './claude-code-runtime.js';

/**
 * Tracks the last Claude Code session id used by each Coderix session so
 * follow-up turns resume the same conversation instead of starting fresh.
 */
const claudeSessionByCoderixSession = new Map<string, string>();

/**
 * On-disk persistence of the coderix-session → claude-session mapping (and the
 * SDK's cumulative usage per session), so a restarted desktop can resume a
 * conversation's context and keep its per-turn usage delta correct instead of
 * starting a fresh Claude Code session (the in-memory maps are lost on restart).
 */
const CLAUDE_SESSION_MAP_PATH = join(homedir(), '.coderix', 'claude-sessions.json');

interface PersistedUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

interface PersistedSessionState {
  claudeSessionId: string;
  previousUsage?: PersistedUsage;
}

function loadPersistedSessionStates(): Map<string, PersistedSessionState> {
  try {
    if (existsSync(CLAUDE_SESSION_MAP_PATH)) {
      const raw = readFileSync(CLAUDE_SESSION_MAP_PATH, 'utf-8');
      const obj = JSON.parse(raw) as Record<string, PersistedSessionState | string>;
      const map = new Map<string, PersistedSessionState>();
      for (const [k, v] of Object.entries(obj)) {
        // Accept a legacy plain-string value ({ id: "..." }).
        map.set(k, typeof v === 'string' ? { claudeSessionId: v } : v);
      }
      return map;
    }
  } catch {
    // Corrupt/missing map — fall through to empty.
  }
  return new Map();
}

function persistSessionState(
  coderixSessionId: string,
  patch: { claudeSessionId?: string; previousUsage?: PersistedUsage },
): void {
  try {
    const map = loadPersistedSessionStates();
    const existing = map.get(coderixSessionId) ?? { claudeSessionId: '' };
    if (patch.claudeSessionId) existing.claudeSessionId = patch.claudeSessionId;
    if (patch.previousUsage) existing.previousUsage = patch.previousUsage;
    map.set(coderixSessionId, existing);
    mkdirSync(dirname(CLAUDE_SESSION_MAP_PATH), { recursive: true });
    writeFileSync(CLAUDE_SESSION_MAP_PATH, JSON.stringify(Object.fromEntries(map), null, 2), 'utf-8');
  } catch {
    // best-effort — a failed persist only means the next restart resumes fresh.
  }
}

/**
 * Tracks the SDK's cumulative `result.usage` per Coderix session so each turn
 * can report its own *delta* (the SDK reports whole-session aggregates, which
 * the ipc-bridge would otherwise accumulate into inflated totals).
 */
const previousUsageBySession = new Map<string, PersistedUsage>();

/**
 * Idle timeout for a Claude Code turn. The spawned `claude` CLI streams events
 * continuously while it runs (thinking deltas, tool progress, text), so a
 * genuinely silent stream means the subprocess is wedged (a hung model call,
 * a dead gateway, a stalled lock). Without this the `for await` loop above the
 * engine would block forever and the UI would spin indefinitely. Mirrors
 * agentstation-app's `TURN_IDLE_TIMEOUT_MS`; the timer resets on every event so
 * slow-but-progressing turns (long tool runs, extended thinking) are unaffected.
 */
const TURN_IDLE_TIMEOUT_MS = 180_000;

export interface ClaudeCodeQueryOptions {
  prompt: string;
  /** Coderix session id — used as the resume key across turns. */
  sessionId: string;
  cwd: string;
  /**
   * Prior messages in this Coderix session (a snapshot taken before the current
   * turn). When no resumable claude session id is known — e.g. a conversation
   * created before cross-restart persistence existed, or whose mapping was lost —
   * these are replayed as a context preamble so the model keeps its history
   * instead of being handed a blank context.
   */
  history?: Message[];
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
  /** Skill names to enable for this turn. Empty array = no skills. */
  skills?: string[];
  /** Custom skill directories to expose to the CLI via a managed plugin shim. */
  customSkillDirs?: string[];
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
  resetIdleTimer: () => void,
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
      // The SDK emits no stream messages while the hook waits for the answer, so
      // the turn's idle watchdog (which is only reset on each stream message)
      // would otherwise fire TURN_IDLE_TIMEOUT_MS after the question is asked and
      // abort the turn mid-question — leaving the AskUserQuestion tool_use stuck
      // in "executing" with no tool_result. Keep the watchdog alive until the
      // answer arrives (or the turn is genuinely aborted).
      const keepalive = setInterval(() => resetIdleTimer(), 60_000);
      const done = (v: Record<string, string | string[]>): void => {
        if (settled) return;
        settled = true;
        clearInterval(keepalive);
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
    /* SDK not resolvable — fall through to runtime dir / PATH lookup */
  }

  // 2b. On-demand runtime dir (~/.coderix/runtimes/claude-code) — the
  //     version-pinned binary installed by claude-code-runtime.ts. Checked
  //     before PATH so an arbitrary (possibly older) user `claude` doesn't win.
  const runtimeBin = findClaudeCodeBinary();
  if (runtimeBin) return runtimeBin;

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

/**
 * Custom spawn hook for the SDK's underlying `claude` process. Filters `CLAUDE*`
 * env vars (which trigger "nested session" errors when a parent Claude Code
 * session left them set) while preserving `CLAUDE_CODE_*` config and
 * `CLAUDE_CONFIG_DIR`, then injects the bound model's endpoint/auth so the
 * spawned CLI is fully self-contained. Mirrors agentstation-app's `createSpawnFn`.
 */
function createSpawnFn(
  modelName: string,
  baseUrl: string | undefined,
  apiKey: string,
): (options: SpawnOptions) => SpawnedProcess {
  return (options: SpawnOptions): SpawnedProcess => {
    const baseEnv =
      options.env && Object.keys(options.env).length > 0
        ? { ...process.env, ...options.env }
        : { ...process.env };

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(baseEnv)) {
      if (value === undefined) continue;
      if (
        key.startsWith('CLAUDE') &&
        !key.startsWith('CLAUDE_CODE_') &&
        !key.startsWith('CLAUDE_CONFIG_DIR')
      ) {
        continue;
      }
      env[key] = value;
    }

    if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
    if (apiKey) {
      // The CLI resolves ANTHROPIC_AUTH_TOKEN (Bearer) before ANTHROPIC_API_KEY
      // (x-api-key); set both to the bound key so a stale token in the parent
      // env can't leak to this model's endpoint.
      env.ANTHROPIC_API_KEY = apiKey;
      env.ANTHROPIC_AUTH_TOKEN = apiKey;
    }
    if (modelName) env.ANTHROPIC_MODEL = modelName;

    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env,
      signal: options.signal,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });

    // Abort only closes the child's stdin; a CLI wedged on a tool call (or a
    // stuck model/gateway request) never reads stdin, so stdin-close alone
    // would leave the subprocess — and any tool subprocesses it spawned —
    // leaking and holding the project session lock, which then blocks the next
    // turn in the same cwd. Force-kill the whole process group (spawned with
    // `detached: true`, so the child is its own group leader) so nothing leaks.
    // Mirrors agentstation-app's `SdkRuntime.kill()`.
    if (options.signal) {
      const killGroup = (): void => {
        if (child.pid && !child.killed) {
          try {
            process.kill(-child.pid, 'SIGTERM');
          } catch {
            try {
              child.kill('SIGTERM');
            } catch {
              /* already gone */
            }
          }
        }
      };
      if (options.signal.aborted) {
        killGroup();
      } else {
        options.signal.addEventListener('abort', killGroup, { once: true });
      }
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8').trim();
        if (text) console.error(`[claude-code] ${text}`);
      });
    }

    return child as unknown as SpawnedProcess;
  };
}

/**
 * Max tool-result text replayed per block — long outputs add little context and
 * would balloon the preamble past the model's context budget.
 */
const REPLAY_TOOL_RESULT_MAX = 1000;
/** Max prior messages replayed into the preamble (most recent wins). */
const REPLAY_MAX_MESSAGES = 50;

/**
 * Rebuild a plain-text transcript from the Coderix session's prior messages,
 * used as a context preamble when the claude-session-id mapping is missing (a
 * conversation created before cross-restart persistence was deployed, or a
 * mapping that was lost). Tool calls are summarized rather than re-executed and
 * thinking blocks are dropped (provider-signed, can't round-trip across
 * providers). This is a fallback — the native `--resume` path preserves full
 * tool structure and is always preferred when the id is known.
 */
function buildReplayPreamble(history: Message[]): string {
  const recent = history.slice(-REPLAY_MAX_MESSAGES);
  const lines: string[] = [
    '以下是本会话之前的历史记录（由桌面恢复，仅供你参考上下文；请在此基础上继续，不要重复执行其中已经完成的工具调用）。',
    '',
  ];
  for (const msg of recent) {
    if (msg.role === 'system') continue;
    const blocks = Array.isArray(msg.content)
      ? msg.content
      : [{ type: 'text' as const, text: String(msg.content) }];
    const parts: string[] = [];
    for (const b of blocks) {
      if (b.type === 'text' && b.text) {
        parts.push(b.text);
      } else if (b.type === 'tool_use') {
        const name = b.name ?? '工具';
        const input = b.input ? ` ${JSON.stringify(b.input)}` : '';
        parts.push(`[调用了工具 ${name}${input}]`);
      } else if (b.type === 'tool_result') {
        let content = '';
        if (typeof b.content === 'string') {
          content = b.content;
        } else if (Array.isArray(b.content)) {
          content = b.content
            .map((c) => (typeof c === 'string' ? c : (c?.text ?? '')))
            .join('\n');
        }
        if (content) {
          const clipped =
            content.length > REPLAY_TOOL_RESULT_MAX
              ? content.slice(0, REPLAY_TOOL_RESULT_MAX) + '…'
              : content;
          parts.push(`[工具结果]\n${clipped}`);
        }
      }
      // `thinking` and `image` blocks can't be replayed — skip.
    }
    const text = parts.join('\n').trim();
    if (!text) continue;
    lines.push(`${msg.role === 'user' ? '用户' : '助手'}: ${text}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

export async function* runClaudeCodeQuery(
  opts: ClaudeCodeQueryOptions,
): AsyncGenerator<QueryEngineEvent> {
  const { prompt, sessionId, cwd, model, baseUrl, apiKey, permissionMode, protocol, skills, customSkillDirs, history, abortController, onAskUserQuestion, onPermissionRequest, onOpenUrl } = opts;

  // Restore the persisted claude session id + usage (survives a restart) when
  // the in-memory maps have no entry yet, so a resumed conversation keeps its
  // context and its per-turn usage delta stays correct.
  if (!claudeSessionByCoderixSession.has(sessionId) || !previousUsageBySession.has(sessionId)) {
    const persisted = loadPersistedSessionStates().get(sessionId);
    if (persisted) {
      if (persisted.claudeSessionId && !claudeSessionByCoderixSession.has(sessionId)) {
        claudeSessionByCoderixSession.set(sessionId, persisted.claudeSessionId);
      }
      if (persisted.previousUsage && !previousUsageBySession.has(sessionId)) {
        previousUsageBySession.set(sessionId, persisted.previousUsage);
      }
    }
  }

  let resume = claudeSessionByCoderixSession.get(sessionId);

  // A stale resume id (the claude session was deleted, expired, or lives in a
  // different project dir) would make the CLI silently start a fresh session
  // and drop context. Verify the session still exists before committing to it;
  // when it's gone — or there was never a mapping — replay the Coderix session's
  // transcript instead so the model keeps its history.
  if (resume) {
    try {
      let info = await getSessionInfo(resume, { dir: cwd });
      if (!info) {
        // The id wasn't found under this cwd's project dir — the session may have
        // been created under a symlinked/normalized path. Search every project
        // dir before declaring it lost (native resume beats a lossy replay).
        info = await getSessionInfo(resume);
      }
      if (!info) {
        console.warn(
          `[claude-code] persisted claude session ${resume} not found — falling back to transcript replay`,
        );
        resume = undefined;
      }
    } catch (err) {
      // Best-effort: if the lookup itself fails (permissions, SDK change), keep
      // the resume id — the init-verification below still catches a real miss.
      console.warn('[claude-code] could not verify resume session; proceeding with resume', err);
    }
  }

  // When there's no resumable claude session but the Coderix session has prior
  // messages, replay them so the model isn't handed a blank context. This is
  // what lets a conversation created before cross-restart persistence continue
  // correctly after its first restart.
  const effectivePrompt =
    !resume && history && history.length > 0
      ? buildReplayPreamble(history) + '\n\n' + prompt
      : prompt;

  let pathToClaudeCodeExecutable = resolveClaudeCodeExecutable();

  // Not bundled with the packaged app — install the native CLI on demand into
  // ~/.coderix/runtimes/claude-code (mirrors agentstation-app's engine fallback).
  // Blocking, but idempotent and shared with the boot-time pre-install.
  if (!pathToClaudeCodeExecutable) {
    console.log('[claude-code] native CLI not found — installing on demand…');
    await ensureClaudeCodeInstalled();
    pathToClaudeCodeExecutable = resolveClaudeCodeExecutable();
  }

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
  // When the model carries its own endpoint/auth, repoint the spawned `claude`
  // CLI at it (routing openai models through the in-process gateway) instead of
  // whatever `~/.claude/settings.json` sets. The CLI re-reads that file and
  // re-applies its `env` block on top of the process env, so a stale gateway
  // there (ANTHROPIC_BASE_URL/AUTH_TOKEN) would shadow the bound model's own
  // endpoint — mirror agentstation-app by dropping the `user` setting source
  // and injecting the bound model through a custom spawn hook.
  const resolvedBaseUrl = baseUrl
    ? resolveClaudeCodeBaseUrl(baseUrl, protocol ?? 'anthropic')
    : undefined;
  const options: Options = {
    cwd,
    permissionMode: sdkMode,
    allowDangerouslySkipPermissions: sdkMode === 'bypassPermissions',
    includePartialMessages: true,
    // Forward the sub-agent's full conversation (text + thinking + tool calls)
    // as messages with `parent_tool_use_id` set, so the host can render each
    // sub-agent's nested trajectory. Default is false, which only emits the
    // sub-agent's tool_use/tool_result blocks (no thinking, no final text).
    forwardSubagentText: true,
    abortController,
    // Drop `user` (~/.claude/settings.json) when a model endpoint is bound so
    // its `env` block can't override the bound baseUrl/apiKey.
    settingSources: resolvedBaseUrl ? ['project'] : ['user', 'project'],
    pathToClaudeCodeExecutable,
    spawnClaudeCodeProcess: createSpawnFn(model ?? '', resolvedBaseUrl, apiKey ?? ''),
  };
  if (model) options.model = model;
  if (resume) options.resume = resume;
  // Always set the skill filter so an empty selection is honored as "no skills"
  // (rather than falling through to the CLI's load-everything default).
  options.skills = skills ?? [];
  // Load registered plugins as local Claude Code plugins so their bundled
  // `skills/` trees are discoverable; also load the custom-skill shim. MCP
  // discovery is skipped for registered plugins — `installRegisteredPlugins`
  // registers those servers itself (they need the plugin's own python/interpreter).
  const plugins: SdkPluginConfig[] = listRegisteredPluginDirs().map((dir) => ({
    type: 'local',
    path: dir,
    skipMcpDiscovery: true,
  }));
  // Expose custom skill directories to the CLI as a managed local plugin. The
  // CLI won't discover skills outside its fixed roots, so we materialize a shim
  // (`~/.coderix/custom-skills/skills/*` symlinks) and load it via `plugins`.
  if (customSkillDirs && customSkillDirs.length > 0) {
    refreshCustomSkillShim();
    plugins.push({ type: 'local', path: CUSTOM_SKILL_SHIM_DIR });
  }
  if (plugins.length > 0) options.plugins = plugins;
  const preToolUseHooks: HookCallbackMatcher[] = [];
  // The idle watchdog is defined before the hooks so AskUserQuestion's
  // PreToolUse hook can keep it alive while the question waits for an answer.
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const resetIdleTimer = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      console.error(
        `[claude-code] turn idle for ${TURN_IDLE_TIMEOUT_MS}ms — aborting (possible hang)`,
      );
      abortController.abort();
    }, TURN_IDLE_TIMEOUT_MS);
  };
  resetIdleTimer();
  if (onAskUserQuestion) {
    preToolUseHooks.push({
      matcher: 'AskUserQuestion',
      hooks: [buildAskUserQuestionHook(onAskUserQuestion, abortController, resetIdleTimer)],
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

  const stream = claudeQuery({ prompt: effectivePrompt, options });

  // Latest turn's per-call usage (captured from the assistant messages) — used
  // at `result` to report the *current* context footprint rather than the
  // whole-session aggregate.
  let lastTurnUsage: unknown = undefined;

  try {
    for await (const msg of stream) {
      resetIdleTimer();
      // Remember the Claude Code session id for the next turn.
      if (msg.type === 'system' && msg.subtype === 'init') {
        // Verify a requested resume actually took effect. If the CLI reports a
        // DIFFERENT session id than the one we asked to resume, the resume failed
        // (stale/foreign id, wrong cwd) and this turn has no prior context. Log it
        // loudly and DON'T overwrite the on-disk mapping — the old id is the only
        // pointer to the real session, and clobbering it would destroy the
        // recovery path.
        if (resume && msg.session_id !== resume) {
          console.error(
            `[claude-code] resume of claude session ${resume} failed — CLI started ${msg.session_id} instead (this turn has no prior context)`,
          );
        } else {
          persistSessionState(sessionId, { claudeSessionId: msg.session_id });
        }
        // Always keep the in-memory map current for this run's follow-up turns.
        claudeSessionByCoderixSession.set(sessionId, msg.session_id);
        continue;
      }

      switch (msg.type) {
        case 'stream_event':
          yield { type: 'message', data: { type: 'stream_event', event: msg.event, parentToolUseId: msg.parent_tool_use_id } };
          break;
        case 'assistant':
          yield { type: 'message', data: { type: 'assistant', message: msg.message, parentToolUseId: msg.parent_tool_use_id, subagentType: msg.subagent_type, taskDescription: msg.task_description } };
          // Remember the latest turn's per-call usage so the final `result` can
          // report the *current* context footprint. The SDK's `result.usage` is
          // the whole-session aggregate (it sums input/cache-read across every
          // turn), so it can't be used to show the current footprint.
          if (msg.message.usage) {
            lastTurnUsage = msg.message.usage;
          }
          break;
        case 'user':
          yield { type: 'message', data: { type: 'user', message: msg.message, parentToolUseId: msg.parent_tool_use_id } };
          break;
        case 'result':
          // Mirror the init guard: only persist the session id when it's the one
          // we actually resumed (or there was no resume), so a failed resume
          // doesn't overwrite the recoverable on-disk mapping.
          if (!resume || msg.session_id === resume) {
            claudeSessionByCoderixSession.set(sessionId, msg.session_id);
            persistSessionState(sessionId, { claudeSessionId: msg.session_id });
          }
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
            // The SDK's `result.usage` is the whole-session aggregate (it sums
            // input/cache-read across every resumed turn). Subtract the previous
            // aggregate so the emitted usage is this turn's *delta*; the
            // ipc-bridge then accumulates deltas into session totals and prices
            // this turn's cost from the delta.
            const cur = {
              input_tokens: msg.usage.input_tokens ?? 0,
              output_tokens: msg.usage.output_tokens ?? 0,
              cache_creation_input_tokens: msg.usage.cache_creation_input_tokens ?? 0,
              cache_read_input_tokens: msg.usage.cache_read_input_tokens ?? 0,
            };
            const prev = previousUsageBySession.get(sessionId);
            const deltaUsage = prev
              ? {
                  input_tokens: cur.input_tokens - prev.input_tokens,
                  output_tokens: cur.output_tokens - prev.output_tokens,
                  cache_creation_input_tokens: cur.cache_creation_input_tokens - prev.cache_creation_input_tokens,
                  cache_read_input_tokens: cur.cache_read_input_tokens - prev.cache_read_input_tokens,
                }
              : cur;
            previousUsageBySession.set(sessionId, cur);
            persistSessionState(sessionId, { previousUsage: cur });
            yield {
              type: 'done',
              data: {
                sessionId,
                result,
                stopReason: msg.stop_reason,
                usage: deltaUsage,
                totalCost: msg.total_cost_usd,
                lastUsage: lastTurnUsage,
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
    // An interrupt (user stop, or the idle timeout above) surfaces as the abort
    // signal firing — not an error.
    if (abortController.signal.aborted) return;
    throw err;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }
}

/**
 * Resolve the Claude Code session id a Coderix session last used. Sub-agent
 * transcripts are stored under the Claude Code session, so loading them needs
 * this mapping (the coderix-session id ≠ the claude session id).
 */
export function getClaudeSessionId(coderixSessionId: string): string | undefined {
  return claudeSessionByCoderixSession.get(coderixSessionId);
}

/**
 * Load a sub-agent's full conversation transcript for the claude-code engine.
 * Returns the raw message array (role/content), or null when not found.
 */
export async function loadClaudeSubagentTranscript(
  claudeSessionId: string,
  agentId: string,
): Promise<unknown[] | null> {
  try {
    const messages = await getSubagentMessages(claudeSessionId, agentId);
    if (!messages || messages.length === 0) return null;
    return messages.map((m) => m.message).filter(Boolean);
  } catch {
    return null;
  }
}
