import { create } from 'zustand';
import { getConfig, setConfig } from '../ipc-client.js';
import type { PermissionMode, Theme } from './uiStore.js';

// ---------------------------------------------------------------------------
// UI-side settings shape (SettingsView tabs)
// ---------------------------------------------------------------------------

export interface ModelConfig {
  name: string;
  temperature: number;
  maxTokens: number;
}

export interface ProviderConfig {
  name: string;
  apiKey: string;
  baseUrl: string;
  models: ModelConfig[];
  connected: boolean;
}

export interface SettingsData {
  providers: ProviderConfig[];
  defaultModel: string;
  defaultPermissionMode: PermissionMode;
  theme: Theme;
  mcpServers: Array<{ name: string; url: string; enabled: boolean }>;
}

// ---------------------------------------------------------------------------
// Core-side settings shape (from ~/.coderix/settings.json via loadSettings())
// ---------------------------------------------------------------------------

interface CoreModelItem {
  name: string;
  price?: { input: number; output: number };
}

interface CoreModelEntry {
  model: Array<string | CoreModelItem>;
  provider?: string;
  base_url?: string;
  auth_token_env?: string;
  max_tokens?: number;
}

interface CoderSettings {
  model_list?: CoreModelEntry[];
  default_model?: string;
  theme?: string;
  max_tokens?: number;
  env?: Record<string, string>;
  web_search?: unknown;
}

// ---------------------------------------------------------------------------
// Adapters: Core ↔ UI
// ---------------------------------------------------------------------------

/** Detect default placeholder API keys that ship with Coderix. */
function isPlaceholderKey(key: string): boolean {
  const upper = key.toUpperCase();
  return (
    upper === 'LOCAL_NO_KEY' ||
    upper.startsWith('YOUR_') ||
    upper.startsWith('SK-YOUR-')
  );
}

function settingsToUI(config: CoderSettings): SettingsData {
  return {
    providers:
      config.model_list?.map((entry) => ({
        name: entry.provider ?? 'unknown',
        apiKey: entry.auth_token_env ?? '',
        baseUrl: entry.base_url ?? '',
        models:
          entry.model?.map((m) => ({
            name: typeof m === 'string' ? m : m.name,
            temperature: 0.7,
            maxTokens: entry.max_tokens ?? config.max_tokens ?? 32768,
          })) ?? [],
        connected: !!(entry.auth_token_env && entry.auth_token_env.length > 0 && !isPlaceholderKey(entry.auth_token_env)),
      })) ?? [],
    defaultModel: config.default_model ?? '',
    defaultPermissionMode: 'auto',
    theme: (config.theme as Theme) ?? 'light',
    mcpServers: [],
  };
}

function uiToSettings(data: SettingsData): Partial<CoderSettings> {
  return {
    theme: data.theme,
    default_model: data.defaultModel,
    model_list: data.providers.map((p) => ({
      provider: p.name.toLowerCase(),
      base_url: p.baseUrl,
      auth_token_env: p.apiKey,
      model: p.models.map((m) => m.name),
    })),
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface SettingsStore {
  settings: SettingsData | null;
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  save: (data: SettingsData) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Mainstream model catalog per provider
// ---------------------------------------------------------------------------

export const PROVIDER_CATALOG: Record<string, { baseUrl: string; models: string[]; isRelay?: boolean }> = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com/anthropic',
    models: ['deepseek-v4-pro', 'deepseek-v3', 'deepseek-r1', 'deepseek-chat'],
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    models: ['claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-fable-5'],
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4.1', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4o-mini', 'o4-mini', 'o3-mini'],
  },
  google: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
  },
  // ── 中转站 / Relay — one key + one URL, any model ──
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['openai/gpt-4.1', 'anthropic/claude-sonnet-4', 'google/gemini-2.5-pro', 'deepseek/deepseek-v3', 'meta-llama/llama-4-maverick'],
    isRelay: true,
  },
  oneapi: {
    baseUrl: 'https://your-oneapi-host.com/v1',
    models: ['gpt-4o', 'claude-sonnet-4-20250514', 'deepseek-v4-pro'],
    isRelay: true,
  },
  moonshot: {
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
  },
  zhipu: {
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash'],
  },
  qwen: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen3-235b-a22b'],
  },
};

export function getProviderModels(providerName: string): string[] {
  const key = providerName.toLowerCase();
  return PROVIDER_CATALOG[key]?.models ?? ['default-model'];
}

export function getProviderBaseUrl(providerName: string): string {
  const key = providerName.toLowerCase();
  return PROVIDER_CATALOG[key]?.baseUrl ?? 'https://api.example.com';
}

export const useSettingsStore = create<SettingsStore>()((set) => ({
  settings: null,
  loading: false,
  error: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const raw = (await getConfig()) as Record<string, unknown>;
      // Check if settings were saved as a nested 'settings' key (old bug)
      if (raw && raw.settings && typeof raw.settings === 'object') {
        // Old format: settings were saved under a nested key
        const ui = raw.settings as unknown as SettingsData;
        set({ settings: ui, loading: false });
      } else if (raw && raw.model_list) {
        // New format: core CoderSettings at root level
        set({ settings: settingsToUI(raw as unknown as CoderSettings), loading: false });
      } else {
        // Empty/unknown — use defaults, will populate on save
        set({
          settings: {
            providers: [],
            defaultModel: '',
            defaultPermissionMode: 'auto',
            theme: 'light',
            mcpServers: [],
          },
          loading: false,
        });
      }
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
    }
  },

  save: async (data: SettingsData) => {
    set({ loading: true, error: null });
    try {
      const toSave = uiToSettings(data);
      // Pass empty key to trigger top-level merge in CONFIG_SET handler
      await setConfig('', toSave);
      // Re-run through settingsToUI to recalculate connected flags
      const refreshed = settingsToUI(toSave as CoderSettings);
      set({ settings: refreshed, loading: false });
      // Hot-reload: reinitialize QueryEngine with new model/API key
      if (window.coderixAPI?.config?.reload) {
        await window.coderixAPI.config.reload();
      }
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
    }
  },
}));
