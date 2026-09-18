import { existsSync, mkdirSync, readFileSync, copyFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { MemorySettings } from './memory/types.js';

// ── App config (inline definition — shared by all core consumers) ───────

export interface AppConfig {
  cwd: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  provider?: string;
  /** Wire protocol of the resolved endpoint: 'anthropic' (Messages API) or 'openai' (Chat Completions). */
  protocol: 'anthropic' | 'openai';
  proxy?: string;
  maxTokens?: number;
  /** Extended-thinking mode. Undefined = auto: 'adaptive' for Anthropic's official
    * API, a fixed budget ('enabled') for third-party Anthropic-compatible endpoints. */
  thinkingMode?: 'adaptive' | 'enabled' | 'disabled';
  /** Fixed thinking budget (tokens) when `thinkingMode` is 'enabled'. Default 31999. */
  thinkingBudgetTokens?: number;
  currency?: string;
  inputPrice: number;
  outputPrice: number;
  cacheReadPrice: number;
  maxContext: number;
  /** Enable brief/concise mode to reduce token consumption. */
  briefMode: boolean;
  /** Enable automatic context compaction. When false, only manual /compact works. */
  autoCompactEnabled: boolean;
  /** Ratio (0–1) at which auto-compaction triggers. Default 0.85. */
  compactThreshold: number;
  /** UI theme: "dark" (default) or "light". */
  theme?: string;
  /** Agent engine backing turns: the in-process Coderix engine or Claude Code. */
  engine: AgentEngine;
}

/**
 * Which agent engine executes a turn.
 * - `coderix`: the built-in in-process Coderix QueryEngine.
 * - `claude-code`: the official `@anthropic-ai/claude-agent-sdk` (spawns `claude`).
 */
export type AgentEngine = 'coderix' | 'claude-code';

// ---------------------------------------------------------------------------
// Settings types — matches ~/.coderix/settings.json format
// ---------------------------------------------------------------------------

export interface ModelPrice {
  input: number;
  output: number;
  cache_read_input?: number;
  currency?: string;
  unit?: number;
  concurrency?: number;
  max_context?: number;
}

export interface ModelItem {
  name: string;
  price?: ModelPrice;
  /** Per-model sampling temperature (0–2). */
  temperature?: number;
  /** Per-model top-p sampling (0–1). */
  top_p?: number;
  /** Per-model max output tokens. */
  max_tokens?: number;
}

export interface ModelEntry {
  /** List of model IDs available for this provider — strings or {name, price} objects */
  model: Array<string | ModelItem>;
  /** Provider endpoint URL */
  base_url?: string;
  /** API key / auth token */
  auth_token_env?: string;
  /** HTTP/HTTPS proxy URL */
  proxy?: string;
  /** Maximum output tokens for this provider */
  max_tokens?: number;
  /** Provider identifier (anthropic, deepseek, openai, etc.) */
  provider?: string;
  /** Wire protocol override: 'anthropic' or 'openai'. Defaults to URL detection. */
  protocol?: 'anthropic' | 'openai';
}

export interface WebSearchConfig {
  /** Search provider: 'bing_html' (free, default), 'duckduckgo', 'brave', or 'bing_api'. */
  provider?: 'bing_html' | 'duckduckgo' | 'brave' | 'bing_api';
  /** Brave Search API key. Required when provider is 'brave'. */
  brave_api_key?: string;
  /** Bing Web Search API key. Required when provider is 'bing'. */
  bing_api_key?: string;
  /** HTTP/HTTPS proxy for web search/fetch requests. Overrides LLM proxy. */
  proxy?: string;
}

export interface WebBridgeConfig {
  /** Enable the web-bridge tool. Default: false (opt-in). */
  enabled?: boolean;
  /** Chrome DevTools Protocol debug port. Default: 9222. */
  debugPort?: number;
  /** Path to Chrome/Edge executable. Auto-detected if not set. */
  browserPath?: string;
  /** Run browser in headless mode. Default: false. */
  headless?: boolean;
  /** Custom user data directory for the browser profile. */
  userDataDir?: string;
}

export interface PermissionRuleEntry {
  /** Exact tool name, e.g. 'bash', 'write', 'read' */
  toolName: string;
  /** Optional command pattern, e.g. 'git push:*', 'npm run test' */
  ruleContent?: string;
  behavior: 'allow' | 'deny' | 'ask';
  /** Human-readable description for the rule */
  description?: string;
}

export interface CoderSettings {
  env?: Record<string, string>;
  /** Web search configuration. */
  web_search?: WebSearchConfig;
  /** Web bridge (browser automation) configuration. */
  web_bridge?: WebBridgeConfig;
  model_list?: ModelEntry[];
  /** Format: "provider/model-name" (e.g. "deepseek/deepseek-v4-pro") */
  default_model?: string;
  /** Desktop app's own default model — independent of the CLI's `default_model`. */
  desktop_default_model?: string;
  /** Global max output tokens (default: 65536) */
  max_tokens?: number;
  /** Extended-thinking mode: 'auto' (default — adaptive for Anthropic, fixed budget
    * elsewhere), 'adaptive', 'enabled', or 'disabled'. */
  thinking?: 'auto' | 'adaptive' | 'enabled' | 'disabled';
  /** Fixed thinking budget (tokens) when `thinking` is 'enabled'. Default 31999. */
  thinking_budget_tokens?: number;
  /** UI theme (dark / light) */
  theme?: string;
  /** Max concurrent tool executions (default: 32, range: 1-256). */
  max_tool_concurrency?: number;
  /** Default team name to resume on startup. */
  default_team?: string;
  /** Persistent memory system configuration. */
  memory?: MemorySettings;
  /** Enable brief/concise mode to reduce token consumption. */
  brief_mode?: boolean;
  /** Enable automatic context compaction. When false, only manual /compact works. */
  auto_compact_enabled?: boolean;
  /** Ratio (0–1) at which auto-compaction triggers. Default 0.85 (85%). */
  compact_threshold?: number;
  /** Permission rules persisted to disk. */
  permissions?: {
    allow?: PermissionRuleEntry[];
  };
  /** Default permission mode. One of 'auto', 'ask', 'plan', 'low'. Defaults to 'ask'. */
  default_permission_mode?: 'auto' | 'ask' | 'plan' | 'low';
  /** Agent engine backing turns. Defaults to 'coderix'. */
  engine?: AgentEngine;
  /** Custom Claude Code skill directories (each a folder of `<name>/SKILL.md`). */
  custom_skill_dirs?: string[];
  /** Default workspace base dir — new conversations get a hash subdir under it. */
  default_workspace_dir?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function inferProvider(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes('deepseek')) return 'deepseek';
  if (lower.includes('openai') || lower.includes('gpt') || lower.includes('o1') || lower.includes('o3') || lower.includes('o4')) return 'openai';
  return 'anthropic';
}

/**
 * Infer the wire protocol of a provider endpoint from its base URL.
 * Mirrors agentstation-app's `detectProtocol`: `/anthropic` paths are always
 * Anthropic Messages; OpenAI-compatible endpoints are recognized by a `/v\d+`
 * segment or a well-known OpenAI host (openai.com, x.ai, localhost, or the
 * vLLM `:8000` port). Everything else — including a bare `host:port` relay like
 * a "New API" gateway (`http://…:3888`) — defaults to Anthropic, the engine's
 * native protocol. (The old `:\d{4,5}` port rule wrongly classified such
 * multi-protocol relays as OpenAI-only, forcing an unnecessary conversion.)
 */
export function detectProtocol(baseUrl: string): 'anthropic' | 'openai' {
  const u = baseUrl.trim().toLowerCase().replace(/\/+$/, '');
  if (u.includes('/anthropic')) return 'anthropic';
  const openai =
    /\/v\d+/.test(u) ||
    u.includes('openai.com') ||
    u.includes('x.ai') ||
    u.includes('localhost') ||
    u.includes(':8000');
  return openai ? 'openai' : 'anthropic';
}

/**
 * Resolve the effective permission mode. Permission is a single app-wide setting
 * (`default_permission_mode`) shared by every conversation — there is no
 * per-project override. Falls back to `'ask'` when unset.
 */
export function resolvePermissionMode(
  settings: CoderSettings,
): 'auto' | 'ask' | 'plan' | 'low' {
  return settings.default_permission_mode ?? 'ask';
}

export function saveSettings(settings: CoderSettings): void {
  const settingsDir = join(homedir(), '.coderix');
  mkdirSync(settingsDir, { recursive: true });
  const settingsPath = join(settingsDir, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

export function loadSettings(): CoderSettings {
  const settingsDir = join(homedir(), '.coderix');
  const settingsPath = join(settingsDir, 'settings.json');

  if (!existsSync(settingsPath)) {
    // Copy default settings on first install
    const defaultSettingsPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '..', '..', 'config', 'default_settings.json',
    );
    if (existsSync(defaultSettingsPath)) {
      mkdirSync(settingsDir, { recursive: true });
      copyFileSync(defaultSettingsPath, settingsPath);
    }
  }

  // Copy bundled skills to ~/.coderix/skills/ on first install or update
  installBundledSkills();

  try {
    const raw = readFileSync(settingsPath, 'utf-8');
    return JSON.parse(raw) as CoderSettings;
  } catch {
    return {};
  }
}

/**
 * Copy bundled skills from resources/skills/ to ~/.coderix/skills/.
 * Skips skills that already exist (user may have customized them).
 */
export function installBundledSkills(): void {
  const skillsDir = join(homedir(), '.coderix', 'skills');
  const bundleDir = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', '..', 'resources', 'skills',
  );

  if (!existsSync(bundleDir)) return;

  mkdirSync(skillsDir, { recursive: true });

  let entries: string[];
  try {
    entries = readdirSync(bundleDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const bundlePath = join(bundleDir, entry);
    try {
      if (!statSync(bundlePath).isDirectory()) continue;
    } catch {
      continue;
    }

    const skillFile = join(bundlePath, 'SKILL.md');
    if (!existsSync(skillFile)) continue;

    const destDir = join(skillsDir, entry);
    mkdirSync(destDir, { recursive: true });

    // Copy all files from the skill directory (SKILL.md, scripts, configs, etc.)
    let fileEntries: string[];
    try {
      fileEntries = readdirSync(bundlePath);
    } catch {
      continue;
    }

    for (const fileName of fileEntries) {
      const srcPath = join(bundlePath, fileName);
      const destPath = join(destDir, fileName);
      try {
        if (!statSync(srcPath).isFile()) continue;
      } catch {
        continue;
      }
      // Don't overwrite user-customized SKILL.md
      if (fileName === 'SKILL.md' && existsSync(destPath)) continue;
      copyFileSync(srcPath, destPath);
    }
  }
}

/** Resolve max tool concurrency from settings, with bounds checking. */
export function getMaxToolConcurrency(settings?: CoderSettings): number {
  const val = settings?.max_tool_concurrency;
  if (typeof val === 'number' && val >= 1 && val <= 256) return val;
  return 32;
}

// ---------------------------------------------------------------------------
// Model resolution — matches Coderix priority:
//   1. CODER_MODEL env var (highest)
//   2. default_model parsed as "provider/model-name", looked up in model_list
//   3. First entry in model_list
//   4. Legacy env vars in settings.env
// ---------------------------------------------------------------------------

function resolveModel(
  settings: CoderSettings,
  defaultName: string | undefined = settings.default_model,
): {
  model: string;
  baseUrl: string;
  apiKey: string;
  proxy?: string;
  maxTokens?: number;
  provider: string;
  protocol?: 'anthropic' | 'openai';
  currency?: string;
  inputPrice?: number;
  outputPrice?: number;
  cacheReadPrice?: number;
  maxContext?: number;
} {
  const parseDefault = (raw: string) => {
    const parts = raw.split('/');
    return { providerName: parts[0]!, modelName: parts.length > 1 ? parts[1] : undefined };
  };

  const modelName = (m: string | ModelItem): string =>
    typeof m === 'string' ? m : m.name;

  const modelPrice = (m: string | ModelItem): ModelPrice | undefined =>
    typeof m === 'string' ? undefined : m.price;

  const resolveFromEntry = (entry: ModelEntry, preferredModel?: string) => {
    const list = entry.model;
    const found = preferredModel
      ? list.find(m => modelName(m) === preferredModel) ?? list[0]
      : list[0];
    const selectedModel = modelName(found!);
    const price = found ? modelPrice(found) : undefined;
    return {
      model: selectedModel,
      baseUrl: entry.base_url ?? '',
      apiKey: entry.auth_token_env ?? '',
      proxy: entry.proxy,
      maxTokens: entry.max_tokens,
      provider: entry.provider ?? inferProvider(selectedModel),
      protocol: entry.protocol,
      currency: price?.currency,
      inputPrice: price?.input,
      outputPrice: price?.output,
      cacheReadPrice: price?.cache_read_input,
      maxContext: price?.max_context,
    };
  };

  // 1. default model from settings ("provider/model-name" format)
  if (defaultName && settings.model_list) {
    const { providerName, modelName: preferredName } = parseDefault(defaultName);
    // 1a. Exact provider match ("provider/model-name")
    const entry = settings.model_list.find(m => m.provider === providerName);
    if (entry && entry.model.length > 0) {
      return resolveFromEntry(entry, preferredName);
    }
    // 1b. Bare model name (no "provider/") or an unknown provider — locate the
    //     model by name across all providers. Without this, a session that
    //     stored the bare name (e.g. "Atria-Dawn-Preview") silently falls back
    //     to the first model_list entry instead of its real provider.
    const bareName = preferredName ?? providerName;
    for (const e of settings.model_list) {
      if (e.model.length > 0 && e.model.some(m => modelName(m) === bareName)) {
        return resolveFromEntry(e, bareName);
      }
    }
  }

  // 2. First entry in model_list
  if (settings.model_list && settings.model_list.length > 0) {
    const entry = settings.model_list[0]!;
    if (entry.model.length > 0) {
      return resolveFromEntry(entry);
    }
  }

  throw new Error(
    'No model configured. Add model_list to ~/.coderix/settings.json.',
  );
}

/** A model resolved by name (independent of `default_model`). Used by the
 *  protocol conversion gateway to map a model name back to its endpoint. */
export interface ResolvedModel {
  model: string;
  baseUrl: string;
  apiKey: string;
  proxy?: string;
  maxTokens?: number;
  provider: string;
  protocol: 'anthropic' | 'openai';
}

/**
 * Resolve a specific model by name — either the bare model name (e.g.
 * `Atria-Dawn-Preview`) or the `"provider/model-name"` form — across
 * `model_list`. Unlike `resolveModel`, this is independent of `default_model`;
 * the protocol conversion gateway uses it to recover a model's endpoint/auth
 * from the name carried in the gateway path.
 */
export function resolveModelByName(name: string): ResolvedModel | undefined {
  if (!name) return undefined;
  const settings = loadSettings();
  if (!settings.model_list || settings.model_list.length === 0) return undefined;

  const modelName = (m: string | ModelItem): string =>
    typeof m === 'string' ? m : m.name;

  const parts = name.split('/');
  const providerName = parts[0]!;
  const preferredName = parts.length > 1 ? parts[1] : undefined;

  const pick = (entry: ModelEntry, target: string | undefined): ResolvedModel | undefined => {
    const found = target
      ? entry.model.find(m => modelName(m) === target)
      : entry.model[0];
    if (!found) return undefined;
    const selectedModel = modelName(found);
    return {
      model: selectedModel,
      baseUrl: entry.base_url ?? '',
      apiKey: entry.auth_token_env ?? '',
      proxy: entry.proxy,
      maxTokens: entry.max_tokens,
      provider: entry.provider ?? inferProvider(selectedModel),
      protocol: entry.protocol ?? detectProtocol(entry.base_url ?? ''),
    };
  };

  // 1. Exact provider match ("provider/model-name").
  if (preferredName) {
    const entry = settings.model_list.find(m => m.provider === providerName);
    if (entry) {
      const r = pick(entry, preferredName);
      if (r) return r;
    }
  }

  // 2. Bare model name — locate across all providers (mirrors resolveModel's
  //    fallback for sessions that stored the bare name).
  const bare = preferredName ?? providerName;
  for (const e of settings.model_list) {
    if (e.model.length > 0 && e.model.some(m => modelName(m) === bare)) {
      const r = pick(e, bare);
      if (r) return r;
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Public API — loadConfig
// ---------------------------------------------------------------------------

/**
 * Load AI model configuration from ~/.coderix/settings.json.
 *
 * Resolution priority:
 *   1. default_model — "provider/model-name" format, looked up in model_list
 *   2. First entry in model_list
 *
 * Settings format:
 * {
 *   "model_list": [
 *     { "model": ["deepseek-v4-pro"], "provider": "deepseek",
 *       "base_url": "https://api.deepseek.com/anthropic", "auth_token_env": "sk-..." }
 *   ],
 *   "default_model": "deepseek/deepseek-v4-pro"
 * }
 */
function buildConfig(settings: CoderSettings, defaultName: string | undefined): AppConfig {
  const resolved = resolveModel(settings, defaultName);

  const model = resolved.model;
  const apiKey = resolved.apiKey;
  const baseUrl = resolved.baseUrl;
  const proxy = resolved.proxy;
  const maxTokens = resolved.maxTokens ?? settings.max_tokens;

  if (!model) {
    throw new Error(
      'No model configured. Set default_model in ~/.coderix/settings.json.',
    );
  }

  return { cwd: process.cwd(), baseUrl, apiKey, model, provider: resolved.provider, protocol: resolved.protocol ?? detectProtocol(baseUrl), proxy, maxTokens, currency: resolved.currency, inputPrice: resolved.inputPrice ?? 0, outputPrice: resolved.outputPrice ?? 0, cacheReadPrice: resolved.cacheReadPrice ?? 0, maxContext: resolved.maxContext ?? 0, briefMode: settings.brief_mode ?? false, autoCompactEnabled: settings.auto_compact_enabled ?? true, compactThreshold: settings.compact_threshold ?? 0.85, thinkingMode: settings.thinking === 'auto' ? undefined : settings.thinking, thinkingBudgetTokens: settings.thinking_budget_tokens, engine: settings.engine ?? 'coderix' };
}

export function loadConfig(): AppConfig {
  const settings = loadSettings();
  return buildConfig(settings, settings.default_model);
}

/** Desktop's default model is independent of the CLI's (`default_model`), so
 *  each app picks its own default without clobbering the other. Falls back to
 *  `default_model` on first upgrade so existing installs keep working. */
export function loadDesktopConfig(): AppConfig {
  const settings = loadSettings();
  return buildConfig(settings, settings.desktop_default_model ?? settings.default_model);
}
