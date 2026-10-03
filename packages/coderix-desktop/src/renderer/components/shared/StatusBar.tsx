import React from 'react';
import { Bot, ArrowUp, ArrowDown, GitBranch, Command, Terminal, Gauge, Sun, Moon, Settings } from 'lucide-react';
import { Badge, type BadgeProps } from './Badge';
import { useT, type TranslationKey } from '../../i18n/index.js';
import { useUIStore } from '../../store/uiStore';
import './StatusBar.css';

export interface StatusBarProps {
  /** Current agent engine id (e.g. "coderix" / "claude-code") */
  engine?: string;
  /** Tokens used */
  inputTokens?: number;
  outputTokens?: number;
  /** Cache-read tokens (accumulated, part of the context footprint) */
  cacheReadTokens?: number;
  /** Current context footprint in tokens (last turn's input + output + cache-read) */
  contextTokens?: number;
  /** Maximum context window size in tokens */
  contextMax?: number;
  /** Cost */
  cost?: number;
  /** Currency code for the cost (e.g. "USD", "CNY", "EUR"). */
  currency?: string;
  /** Git branch */
  gitBranch?: string;
  /** Git ahead/behind counts */
  gitAhead?: number;
  gitBehind?: number;
  /** Agent status */
  agentStatus?: 'idle' | 'thinking' | 'executing' | 'output' | 'waiting' | 'error';
  /** Whether the terminal panel is open */
  terminalOpen?: boolean;
  /** Toggle the terminal panel */
  onToggleTerminal?: () => void;
  /** Open the settings modal */
  onOpenSettings?: () => void;
  /** Width of the left sidebar column. When > 0, theme + settings render in a
   *  fixed-width leading slot so the engine/status items stay clear of the
   *  sidebar (mirrors the header's sidebar/chat split). */
  leadingWidth?: number;
  /** Additional CSS classes */
  className?: string;
}

function formatTokens(num: number): string {
  if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
  return String(num);
}

function currencySymbol(currency?: string): string {
  switch ((currency ?? 'USD').toUpperCase()) {
    case 'USD': return '$';
    case 'CNY': return '¥';
    case 'EUR': return '€';
    case 'GBP': return '£';
    case 'JPY': return '¥';
    case 'KRW': return '₩';
    default: return '$';
  }
}

function formatCost(cost: number, currency?: string): string {
  const sym = currencySymbol(currency);
  if (cost >= 0.01) return `${sym}${cost.toFixed(2)}`;
  return `<${sym}0.01`;
}

const statusConfig: Record<NonNullable<StatusBarProps['agentStatus']>, { labelKey: TranslationKey; variant: NonNullable<BadgeProps['variant']> }> = {
  idle: { labelKey: 'status.idle', variant: 'success' },
  thinking: { labelKey: 'status.thinking', variant: 'purple' },
  executing: { labelKey: 'status.executing', variant: 'warning' },
  output: { labelKey: 'status.output', variant: 'blue' },
  waiting: { labelKey: 'status.waiting', variant: 'warning' },
  error: { labelKey: 'status.error', variant: 'danger' },
};

const ENGINE_LABELS: Record<string, string> = {
  coderix: 'Coderix',
  'claude-code': 'Claude Code',
};

export function StatusBar({
  engine,
  inputTokens,
  outputTokens,
  cacheReadTokens,
  contextTokens: contextFootprint,
  contextMax,
  cost,
  currency,
  gitBranch,
  gitAhead = 0,
  gitBehind = 0,
  agentStatus = 'idle',
  terminalOpen = false,
  onToggleTerminal,
  onOpenSettings,
  leadingWidth = 0,
  className = '',
}: StatusBarProps): React.ReactElement {
  const t = useT();
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);
  const status = statusConfig[agentStatus];

  const toggleTheme = () => setTheme(theme === 'light' ? 'dark' : 'light');

  // Context footprint mirrors the CLI: output + input + cache-read tokens for
  // the *current* turn. Prefer the engine-supplied footprint; fall back to the
  // accumulated counters for callers that don't pass it.
  const contextTokens =
    contextFootprint ??
    (inputTokens ?? 0) + (outputTokens ?? 0) + (cacheReadTokens ?? 0);
  const contextRatio = contextMax && contextMax > 0 ? contextTokens / contextMax : 0;
  const contextPercent = Math.min(100, Math.round(contextRatio * 100));
  const contextColor = contextRatio > 0.9
    ? 'var(--color-danger)'
    : contextRatio > 0.7
      ? 'var(--color-warning)'
      : 'var(--color-success)';

  const leading = (
    <>
      {/* Theme toggle */}
      <button
        type="button"
        onClick={toggleTheme}
        className="inline-flex items-center gap-1 transition-colors cursor-pointer text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
        title={theme === 'light' ? t('nav.switchToDark') : t('nav.switchToLight')}
        aria-label={theme === 'light' ? t('nav.darkMode') : t('nav.lightMode')}
      >
        {theme === 'light' ? <Sun size={12} /> : <Moon size={12} />}
      </button>

      {/* Settings */}
      {onOpenSettings && (
        <button
          type="button"
          onClick={onOpenSettings}
          className="inline-flex items-center gap-1 transition-colors cursor-pointer text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
          title={t('nav.settings')}
          aria-label={t('nav.settings')}
        >
          <Settings size={12} />
        </button>
      )}
    </>
  );

  return (
    <div
      className={`
        h-8 flex items-stretch
        bg-[var(--color-bg-secondary)] border-t border-[var(--color-separator)]
        select-none font-sans text-[var(--color-text-secondary)]
        ${className}
      `}
    >
      {/* Leading slot — theme + settings, pinned to the sidebar's width so the
          engine/status items below stay clear of the sidebar. */}
      {leadingWidth > 0 && (
        <div
          className="flex-shrink-0 h-full flex items-center px-4 gap-4 text-xs border-r border-[var(--color-separator)]"
          style={{ width: leadingWidth }}
        >
          {leading}
        </div>
      )}

      <div className="flex-1 flex items-center px-4 gap-4 text-xs min-w-0">
        {leadingWidth === 0 && leading}
        {leadingWidth === 0 && <div className="w-px h-3 bg-[var(--color-separator)]" />}

        {/* Engine */}
      {engine && (
        <>
          <span className="inline-flex items-center gap-1 text-[var(--color-text-secondary)]" title={t('status.engine')}>
            <Bot size={12} className="text-[var(--color-text-tertiary)]" />
            <span className="font-medium">{ENGINE_LABELS[engine] ?? engine}</span>
          </span>
          <div className="w-px h-3 bg-[var(--color-separator)]" />
        </>
      )}

      {/* Token usage */}
      {(inputTokens !== undefined || outputTokens !== undefined) && (
        <>
          <div className="flex items-center gap-3">
            {inputTokens !== undefined && (
              <span className="inline-flex items-center gap-1">
                <ArrowUp size={10} className="text-[var(--color-text-tertiary)]" />
                <span>{formatTokens(inputTokens)}</span>
              </span>
            )}
            {outputTokens !== undefined && (
              <span className="inline-flex items-center gap-1">
                <ArrowDown size={10} className="text-[var(--color-text-tertiary)]" />
                <span>{formatTokens(outputTokens)}</span>
              </span>
            )}
          </div>
          <div className="w-px h-3 bg-[var(--color-separator)]" />
        </>
      )}

      {/* Cost */}
      {cost !== undefined && (
        <>
          <span>{formatCost(cost, currency)}</span>
          <div className="w-px h-3 bg-[var(--color-separator)]" />
        </>
      )}

      {/* Context usage */}
      {contextMax !== undefined && contextMax > 0 && (
        <>
          <div className="flex items-center gap-1.5" title={t('status.context')}>
            <Gauge size={11} className="text-[var(--color-text-tertiary)]" />
            <div className="w-14 h-1.5 rounded-full bg-[var(--color-bg-tertiary)] overflow-hidden">
              <div
                className="h-full rounded-full"
                style={{ width: `${contextPercent}%`, backgroundColor: contextColor }}
              />
            </div>
            <span className="font-mono">{contextPercent}%</span>
            <span className="text-[var(--color-text-tertiary)]">
              {formatTokens(contextTokens)}/{formatTokens(contextMax)}
            </span>
          </div>
          <div className="w-px h-3 bg-[var(--color-separator)]" />
        </>
      )}

      {/* Agent status */}
      <Badge variant={status.variant} dot size="sm">
        {t(status.labelKey)}
      </Badge>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Git branch */}
      {gitBranch && (
        <>
          <span className="inline-flex items-center gap-1">
            <GitBranch size={10} className="text-[var(--color-text-tertiary)]" />
            <span>{gitBranch}</span>
            {gitAhead > 0 && (
              <span className="inline-flex items-center gap-0.5 text-[#4caf50]">
                <ArrowUp size={9} />
                <span>{gitAhead}</span>
              </span>
            )}
            {gitBehind > 0 && (
              <span className="inline-flex items-center gap-0.5 text-[#2196f3]">
                <ArrowDown size={9} />
                <span>{gitBehind}</span>
              </span>
            )}
          </span>
          <div className="w-px h-3 bg-[var(--color-separator)]" />
        </>
      )}

      {/* Command palette hint */}
      <span className="inline-flex items-center gap-1 text-[var(--color-text-tertiary)]">
        <Command size={10} />
        <span>{t('status.commands')}</span>
      </span>

      {/* Terminal toggle */}
      {onToggleTerminal && (
        <>
          <div className="w-px h-3 bg-[var(--color-separator)]" />
          <button
            type="button"
            onClick={onToggleTerminal}
            className={`inline-flex items-center gap-1 transition-colors cursor-pointer ${
              terminalOpen ? 'text-[var(--color-brand)]' : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]'
            }`}
            title={terminalOpen ? t('status.hideTerminal') : t('status.toggleTerminal')}
            aria-label={t('status.toggleTerminal')}
          >
            <Terminal size={12} />
            <span>{t('status.terminal')}</span>
          </button>
        </>
      )}
      </div>
    </div>
  );
}

StatusBar.displayName = 'StatusBar';
