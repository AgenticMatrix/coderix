import React from 'react';
import { Bot, ArrowUp, ArrowDown, DollarSign, GitBranch, Command, Terminal } from 'lucide-react';
import { Badge, type BadgeProps } from './Badge';
import { useT, type TranslationKey } from '../../i18n/index.js';
import './StatusBar.css';

export interface StatusBarProps {
  /** Current agent engine id (e.g. "coderix" / "claude-code") */
  engine?: string;
  /** Tokens used */
  inputTokens?: number;
  outputTokens?: number;
  /** Cost in USD */
  cost?: number;
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
  /** Additional CSS classes */
  className?: string;
}

function formatTokens(num: number): string {
  if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
  return String(num);
}

function formatCost(cost: number): string {
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  if (cost >= 0.01) return `$${cost.toFixed(2)}`;
  return '<$0.01';
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
  cost,
  gitBranch,
  gitAhead = 0,
  gitBehind = 0,
  agentStatus = 'idle',
  terminalOpen = false,
  onToggleTerminal,
  className = '',
}: StatusBarProps): React.ReactElement {
  const t = useT();
  const status = statusConfig[agentStatus];

  return (
    <div
      className={`
        h-8 flex items-center px-4 gap-4 text-xs
        bg-[var(--color-bg-secondary)] border-t border-[var(--color-separator)]
        select-none font-sans text-[var(--color-text-secondary)]
        ${className}
      `}
    >
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
          <span className="inline-flex items-center gap-1">
            <DollarSign size={10} className="text-[var(--color-text-tertiary)]" />
            <span>{formatCost(cost)}</span>
          </span>
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
  );
}

StatusBar.displayName = 'StatusBar';
