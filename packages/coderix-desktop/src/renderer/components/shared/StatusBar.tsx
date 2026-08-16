import React, { useState, useEffect, useRef } from 'react';
import { Cpu, ArrowUp, ArrowDown, DollarSign, GitBranch, Command, FolderOpen, ChevronDown, Terminal } from 'lucide-react';
import { Badge } from './Badge';
import './StatusBar.css';

function useModelList(): string[] {
  const [models, setModels] = useState<string[]>([]);
  useEffect(() => {
    const api = window.coderixAPI?.config;
    if (api?.getModelList) {
      api.getModelList().then((list: any) => {
        const names = (list as any[])?.flatMap((e: any) =>
          (e.model || []).map((m: any) => typeof m === 'string' ? m : m.name)
        ) || [];
        setModels(names);
      }).catch(() => {});
    }
  }, []);
  return models;
}

export interface StatusBarProps {
  /** Current model name */
  model?: string;
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
  agentStatus?: 'idle' | 'thinking' | 'executing' | 'waiting' | 'error';
  /** Current project path */
  projectPath?: string;
  /** Select project directory callback */
  onSelectProject?: () => void;
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

const statusConfig: Record<NonNullable<StatusBarProps['agentStatus']>, { label: string; color: string }> = {
  idle: { label: 'Idle', color: 'bg-[var(--color-text-tertiary)]' },
  thinking: { label: 'Thinking…', color: 'bg-[var(--color-info)] animate-pulse' },
  executing: { label: 'Executing…', color: 'bg-[var(--color-warning)] animate-pulse' },
  waiting: { label: 'Waiting for input…', color: 'bg-[var(--color-warning)]' },
  error: { label: 'Error', color: 'bg-[var(--color-danger)]' },
};

export function StatusBar({
  model = 'sonnet 4.5',
  inputTokens,
  outputTokens,
  cost,
  gitBranch,
  gitAhead = 0,
  gitBehind = 0,
  agentStatus = 'idle',
  projectPath,
  onSelectProject,
  terminalOpen = false,
  onToggleTerminal,
  className = '',
}: StatusBarProps): React.ReactElement {
  const status = statusConfig[agentStatus];
  const models = useModelList();
  const [modelOpen, setModelOpen] = useState(false);
  const modelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const clickOut = (e: MouseEvent) => {
      if (modelRef.current && !modelRef.current.contains(e.target as Node)) setModelOpen(false);
    };
    document.addEventListener('mousedown', clickOut);
    return () => document.removeEventListener('mousedown', clickOut);
  }, []);

  return (
    <div
      className={`
        h-8 flex items-center px-4 gap-4 text-xs
        bg-[var(--color-bg-secondary)] border-t border-[var(--color-separator)]
        select-none font-sans text-[var(--color-text-secondary)]
        ${className}
      `}
    >
      {/* Model selector */}
      <div ref={modelRef} className="relative">
        <button
          type="button"
          onClick={() => setModelOpen(!modelOpen)}
          className="flex items-center gap-1.5 text-[var(--color-text-primary)] hover:text-[var(--color-brand)] transition-colors cursor-pointer"
          title="切换模型"
        >
          <Cpu size={12} className="text-[var(--color-text-tertiary)]" />
          <span className="font-medium">{model || '选择模型'}</span>
          <ChevronDown size={10} />
        </button>
        {modelOpen && models.length > 0 && (
          <div className="absolute bottom-full left-0 mb-1 bg-[var(--color-bg-primary)] border border-[var(--color-separator)] rounded-[var(--radius-md)] shadow-lg z-50 min-w-[160px] max-h-[200px] overflow-y-auto py-1">
            {models.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  setModelOpen(false);
                  // Write to settings and trigger hot-reload
                  const api = window.coderixAPI;
                  if (api?.config?.set && api?.config?.reload) {
                    api.config.set('', { default_model: m }).then(() => api.config.reload());
                  }
                }}
                className={`w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--color-bg-tertiary)] ${m === model ? 'text-[var(--color-brand)] font-medium' : 'text-[var(--color-text-primary)]'}`}
              >
                {m}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Divider */}
      <div className="w-px h-3 bg-[var(--color-separator)]" />

      {/* Project path — clickable to change */}
      {onSelectProject && (
        <>
          <button
            type="button"
            onClick={onSelectProject}
            className="inline-flex items-center gap-1 text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] transition-colors cursor-pointer max-w-[200px]"
            title={projectPath || '选择项目目录'}
          >
            <FolderOpen size={10} className="flex-shrink-0" />
            <span className="truncate">{projectPath ? projectPath.split('/').pop() || projectPath : '选择目录'}</span>
          </button>
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
      <Badge variant={agentStatus === 'error' ? 'danger' : agentStatus === 'executing' ? 'warning' : 'default'} dot size="sm">
        {status.label}
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
        <span>K commands</span>
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
            title={terminalOpen ? 'Hide Terminal (⌘`)' : 'Toggle Terminal (⌘`)'}
            aria-label="Toggle Terminal"
          >
            <Terminal size={12} />
            <span>Terminal</span>
          </button>
        </>
      )}
    </div>
  );
}

StatusBar.displayName = 'StatusBar';
