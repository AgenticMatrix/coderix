import React, { useState, useEffect, useCallback } from 'react';
import { useUIStore, type PermissionMode, type Theme } from '../../store/uiStore.js';
import * as ipc from '../../ipc-client.js';

// ── Types ──────────────────────────────────────────────────

interface ModelConfig {
  name: string;
  temperature: number;
  maxTokens: number;
}

interface ProviderConfig {
  name: string;
  apiKey: string;
  baseUrl: string;
  models: ModelConfig[];
  connected: boolean;
}

interface SettingsData {
  providers: ProviderConfig[];
  defaultModel: string;
  defaultPermissionMode: PermissionMode;
  theme: Theme;
  mcpServers: Array<{ name: string; url: string; enabled: boolean }>;
}

// ── Constants ──────────────────────────────────────────────

const TABS = [
  'Provider' as const,
  '模型管理' as const,
  '外观' as const,
  '权限' as const,
  'MCP' as const,
] as const;

type TabKey = (typeof TABS)[number];

const defaultProviders: ProviderConfig[] = [
  {
    name: 'Anthropic',
    apiKey: '',
    baseUrl: 'https://api.anthropic.com',
    models: [
      { name: 'claude-sonnet-4-20250514', temperature: 0.7, maxTokens: 8192 },
      { name: 'claude-opus-4-20250514', temperature: 0.7, maxTokens: 8192 },
    ],
    connected: false,
  },
  {
    name: 'DeepSeek',
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
    models: [
      { name: 'deepseek-chat', temperature: 0.7, maxTokens: 8192 },
    ],
    connected: false,
  },
  {
    name: 'OpenAI',
    apiKey: '',
    baseUrl: 'https://api.openai.com/v1',
    models: [
      { name: 'gpt-4o', temperature: 0.7, maxTokens: 8192 },
    ],
    connected: false,
  },
];

// ── Component ──────────────────────────────────────────────

/**
 * SettingsView — main settings panel for Coderix Desktop.
 *
 * Sections:
 *   1. Provider — API key management per provider
 *   2. Model — default model, temperature, max tokens
 *   3. Appearance — theme (light/dark), font size
 *   4. Permissions — default permission mode
 *   5. MCP — MCP server management
 *
 * Settings are persisted via the `config:set` IPC channel and
 * applied immediately to the UI store for theme and permission mode.
 */
export default function SettingsView({ onClose }: { onClose?: () => void }): React.ReactElement {
  const [activeTab, setActiveTab] = useState<TabKey>('Provider');
  const [settings, setSettings] = useState<SettingsData>({
    providers: defaultProviders,
    defaultModel: 'claude-sonnet-4-20250514',
    defaultPermissionMode: 'ask',
    theme: 'light',
    mcpServers: [],
  });
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const { theme, permissionMode, setTheme, setPermissionMode } = useUIStore();

  // Load settings on mount
  useEffect(() => {
    ipc.getConfig().then((config) => {
      if (config && typeof config === 'object') {
        setSettings((prev) => ({
          ...prev,
          ...(config as Partial<SettingsData>),
        }));
      }
    }).catch(() => {
      // Config not yet set — use defaults
    });
  }, []);

  // ── Provider Tab ──────────────────────────────────────────
  const handleApiKeyChange = useCallback((providerName: string, apiKey: string) => {
    setSettings((prev) => ({
      ...prev,
      providers: prev.providers.map((p) =>
        p.name === providerName ? { ...p, apiKey, connected: apiKey.length > 0 } : p,
      ),
    }));
  }, []);

  const handleBaseUrlChange = useCallback((providerName: string, baseUrl: string) => {
    setSettings((prev) => ({
      ...prev,
      providers: prev.providers.map((p) =>
        p.name === providerName ? { ...p, baseUrl } : p,
      ),
    }));
  }, []);

  // ── Model Tab ─────────────────────────────────────────────
  const handleModelChange = useCallback((model: string) => {
    setSettings((prev) => ({ ...prev, defaultModel: model }));
  }, []);

  // ── Theme Tab ─────────────────────────────────────────────
  const handleThemeChange = useCallback((newTheme: Theme) => {
    setSettings((prev) => ({ ...prev, theme: newTheme }));
    setTheme(newTheme);
  }, [setTheme]);

  // ── Permission Tab ────────────────────────────────────────
  const handlePermissionChange = useCallback((mode: PermissionMode) => {
    setSettings((prev) => ({ ...prev, defaultPermissionMode: mode }));
    setPermissionMode(mode);
  }, [setPermissionMode]);

  // ── Save ──────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      await ipc.setConfig('settings', settings);
      setSaveMsg('设置已保存');
      setTimeout(() => setSaveMsg(null), 3000);
    } catch (err) {
      setSaveMsg(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }, [settings]);

  // ── Render ─────────────────────────────────────────────────
  return (
    <div
      className="settings-view"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: 'var(--color-bg-primary)',
        color: 'var(--color-text-primary)',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '7px 12px 7px 24px',
          borderBottom: '1px solid var(--color-separator)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexShrink: 0,
        }}
      >
        <h2
          style={{
            fontSize: 'var(--text-base)',
            fontWeight: 600,
            margin: 0,
          }}
        >
          设置
        </h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              padding: '6px 16px',
              borderRadius: 'var(--radius-md)',
              background: 'var(--color-brand)',
              color: 'var(--color-text-inverse)',
              border: 'none',
              cursor: 'pointer',
              fontSize: 'var(--text-sm)',
              fontWeight: 500,
              opacity: saving ? 0.6 : 1,
            }}
          >
            {saving ? '保存中...' : '保存'}
          </button>
          {saveMsg && (
            <span
              style={{
                fontSize: 'var(--text-xs)',
                color: saveMsg.includes('失败') ? 'var(--color-danger)' : 'var(--color-success)',
              }}
            >
              {saveMsg}
            </span>
          )}
          {onClose && (
            <button
              onClick={onClose}
              style={{
                width: '28px',
                height: '28px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: '6px',
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                fontSize: '16px',
                color: 'var(--color-text-secondary)',
              }}
              aria-label="Close settings"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Body: Sidebar Tabs + Content */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Tab List */}
        <nav
          style={{
            width: '180px',
            borderRight: '1px solid var(--color-separator)',
            padding: '8px 0',
            flexShrink: 0,
          }}
        >
          {TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '8px 20px',
                border: 'none',
                background:
                  activeTab === tab
                    ? 'var(--color-brand-muted)'
                    : 'transparent',
                color: 'var(--color-text-primary)',
                fontSize: 'var(--text-sm)',
                cursor: 'pointer',
                borderRadius: '0 6px 6px 0',
                fontWeight: activeTab === tab ? 500 : 400,
              }}
            >
              {tab}
            </button>
          ))}
        </nav>

        {/* Content Area */}
        <div
          style={{
            flex: 1,
            padding: '24px',
            overflowY: 'auto',
          }}
        >
          {/* ── Provider Tab ────────────────────────────────── */}
          {activeTab === 'Provider' && (
            <div>
              <h3 style={{ fontSize: 'var(--text-lg)', fontWeight: 600, marginBottom: '16px' }}>
                Provider 管理
              </h3>
              {settings.providers.map((provider) => (
                <div
                  key={provider.name}
                  style={{
                    marginBottom: '16px',
                    padding: '16px',
                    borderRadius: 'var(--radius-lg)',
                    background: 'var(--color-bg-secondary)',
                    border: '1px solid var(--color-separator)',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      marginBottom: '12px',
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>{provider.name}</span>
                    <span
                      style={{
                        fontSize: 'var(--text-xs)',
                        padding: '2px 8px',
                        borderRadius: 'var(--radius-full)',
                        background: provider.connected
                          ? 'var(--color-success)'
                          : 'var(--color-text-tertiary)',
                        color: 'var(--color-text-inverse)',
                      }}
                    >
                      {provider.connected ? '已连接' : '未连接'}
                    </span>
                  </div>

                  <label
                    style={{
                      display: 'block',
                      fontSize: 'var(--text-xs)',
                      color: 'var(--color-text-secondary)',
                      marginBottom: '4px',
                    }}
                  >
                    API Key
                  </label>
                  <input
                    type="password"
                    value={provider.apiKey}
                    onChange={(e) => handleApiKeyChange(provider.name, e.target.value)}
                    placeholder="输入 API Key..."
                    style={{
                      width: '100%',
                      padding: '8px 12px',
                      borderRadius: 'var(--radius-md)',
                      border: '1px solid var(--color-separator)',
                      background: 'var(--color-input-bg)',
                      color: 'var(--color-text-primary)',
                      fontSize: 'var(--text-sm)',
                      fontFamily: 'var(--font-mono)',
                      marginBottom: '8px',
                    }}
                  />

                  <label
                    style={{
                      display: 'block',
                      fontSize: 'var(--text-xs)',
                      color: 'var(--color-text-secondary)',
                      marginBottom: '4px',
                    }}
                  >
                    Base URL
                  </label>
                  <input
                    type="text"
                    value={provider.baseUrl}
                    onChange={(e) => handleBaseUrlChange(provider.name, e.target.value)}
                    style={{
                      width: '100%',
                      padding: '8px 12px',
                      borderRadius: 'var(--radius-md)',
                      border: '1px solid var(--color-separator)',
                      background: 'var(--color-input-bg)',
                      color: 'var(--color-text-primary)',
                      fontSize: 'var(--text-sm)',
                      fontFamily: 'var(--font-mono)',
                    }}
                  />
                </div>
              ))}
            </div>
          )}

          {/* ── Model Tab ───────────────────────────────────── */}
          {activeTab === '模型管理' && (
            <div>
              <h3 style={{ fontSize: 'var(--text-lg)', fontWeight: 600, marginBottom: '16px' }}>
                默认模型
              </h3>
              <div style={{ marginBottom: '24px' }}>
                <label
                  style={{
                    display: 'block',
                    fontSize: 'var(--text-xs)',
                    color: 'var(--color-text-secondary)',
                    marginBottom: '6px',
                  }}
                >
                  选择默认模型
                </label>
                <select
                  value={settings.defaultModel}
                  onChange={(e) => handleModelChange(e.target.value)}
                  style={{
                    width: '100%',
                    maxWidth: '400px',
                    padding: '8px 12px',
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--color-separator)',
                    background: 'var(--color-input-bg)',
                    color: 'var(--color-text-primary)',
                    fontSize: 'var(--text-sm)',
                  }}
                >
                  {settings.providers.flatMap((p) =>
                    p.models.map((m) => (
                      <option key={`${p.name}:${m.name}`} value={m.name}>
                        {p.name} — {m.name}
                      </option>
                    )),
                  )}
                </select>
              </div>
            </div>
          )}

          {/* ── Appearance Tab ───────────────────────────────── */}
          {activeTab === '外观' && (
            <div>
              <h3 style={{ fontSize: 'var(--text-lg)', fontWeight: 600, marginBottom: '16px' }}>
                主题
              </h3>
              <div style={{ display: 'flex', gap: '12px' }}>
                {(['light', 'dark'] as Theme[]).map((t) => (
                  <button
                    key={t}
                    onClick={() => handleThemeChange(t)}
                    style={{
                      padding: '12px 24px',
                      borderRadius: 'var(--radius-lg)',
                      border:
                        settings.theme === t
                          ? '2px solid var(--color-brand)'
                          : '1px solid var(--color-separator)',
                      background:
                        t === 'light'
                          ? '#FAF9F5'
                          : '#262624',
                      color:
                        t === 'light'
                          ? '#29261B'
                          : '#EDEBE0',
                      cursor: 'pointer',
                      fontSize: 'var(--text-sm)',
                      fontWeight: settings.theme === t ? 600 : 400,
                      minWidth: '120px',
                    }}
                  >
                    {t === 'light' ? '☀ 浅色' : '🌙 深色'}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ── Permission Tab ───────────────────────────────── */}
          {activeTab === '权限' && (
            <div>
              <h3 style={{ fontSize: 'var(--text-lg)', fontWeight: 600, marginBottom: '16px' }}>
                默认权限模式
              </h3>
              <p
                style={{
                  fontSize: 'var(--text-sm)',
                  color: 'var(--color-text-secondary)',
                  marginBottom: '16px',
                }}
              >
                控制 Agent 在执行工具操作时的默认行为。
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {([
                  { mode: 'plan' as PermissionMode, label: '先出计划再执行', desc: 'Agent 会先制定计划，您审批后再执行。最安全。' },
                  { mode: 'ask' as PermissionMode, label: '每次操作前询问', desc: '每个工具调用都需要您确认。适合谨慎使用。' },
                  { mode: 'auto' as PermissionMode, label: '自动执行', desc: 'Agent 自动执行所有操作，不询问。请谨慎使用。' },
                ]).map(({ mode, label, desc }) => (
                  <button
                    key={mode}
                    onClick={() => handlePermissionChange(mode)}
                    style={{
                      textAlign: 'left',
                      padding: '12px 16px',
                      borderRadius: 'var(--radius-lg)',
                      border:
                        settings.defaultPermissionMode === mode
                          ? '2px solid var(--color-brand)'
                          : '1px solid var(--color-separator)',
                      background: 'var(--color-bg-secondary)',
                      cursor: 'pointer',
                    }}
                  >
                    <div
                      style={{
                        fontWeight: 600,
                        fontSize: 'var(--text-sm)',
                        color: 'var(--color-text-primary)',
                      }}
                    >
                      {label}
                    </div>
                    <div
                      style={{
                        fontSize: 'var(--text-xs)',
                        color: 'var(--color-text-secondary)',
                        marginTop: '4px',
                      }}
                    >
                      {desc}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ── MCP Tab ──────────────────────────────────────── */}
          {activeTab === 'MCP' && (
            <div>
              <h3 style={{ fontSize: 'var(--text-lg)', fontWeight: 600, marginBottom: '16px' }}>
                MCP 服务器管理
              </h3>
              <p
                style={{
                  fontSize: 'var(--text-sm)',
                  color: 'var(--color-text-secondary)',
                  marginBottom: '16px',
                }}
              >
                管理与 Coderix 连接的 MCP (Model Context Protocol) 服务器。
              </p>
              {settings.mcpServers.length === 0 ? (
                <div
                  style={{
                    padding: '32px',
                    textAlign: 'center',
                    color: 'var(--color-text-tertiary)',
                    fontSize: 'var(--text-sm)',
                  }}
                >
                  暂无 MCP 服务器
                  <br />
                  <span style={{ fontSize: 'var(--text-xs)' }}>
                    配置文件编辑 MCP 服务器列表
                  </span>
                </div>
              ) : (
                settings.mcpServers.map((server) => (
                  <div
                    key={server.name}
                    style={{
                      padding: '12px 16px',
                      borderRadius: 'var(--radius-md)',
                      background: 'var(--color-bg-secondary)',
                      marginBottom: '8px',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 500, fontSize: 'var(--text-sm)' }}>
                        {server.name}
                      </div>
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-tertiary)' }}>
                        {server.url}
                      </div>
                    </div>
                    <span
                      style={{
                        width: '8px',
                        height: '8px',
                        borderRadius: '50%',
                        background: server.enabled
                          ? 'var(--color-success)'
                          : 'var(--color-text-tertiary)',
                      }}
                    />
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

SettingsView.displayName = 'SettingsView';
