import React, { useState, useRef, useEffect } from 'react';
import { Server, ChevronDown, Check, Loader2, AlertCircle, Link2 } from 'lucide-react';
import type { McpServerStatus } from '../../ipc-client.js';
import { useT } from '../../i18n/index.js';
// Reuses the SkillPicker popup styles (same checkbox-list look).
import './SkillPicker.css';

export interface McpPickerProps {
  /** All configured MCP servers (from `mcp:list`). */
  servers: McpServerStatus[];
  /** Names of the servers currently enabled for the active session. */
  selected: string[];
  /** Called with the next selection whenever a server is toggled. */
  onChange: (next: string[]) => void;
}

/** A server is usable when it is connected and exposes at least one tool. */
const STATUS_ICON: Record<string, React.ReactNode> = {
  connected: <span className="mcp-status-dot mcp-status-ok" />,
  failed: <AlertCircle size={12} className="text-[var(--color-danger)]" />,
  'needs-auth': <Link2 size={12} className="text-[var(--color-warning,var(--color-info))]" />,
  disabled: <span className="mcp-status-dot mcp-status-off" />,
  unconnected: <span className="mcp-status-dot mcp-status-off" />,
  pending: <Loader2 size={12} className="animate-spin text-[var(--color-info)]" />,
};

/**
 * Composer MCP picker: a small button next to the skill picker that opens an
 * upward popup listing every configured MCP server. Toggling an entry binds the
 * active session to that server's tools (per-session, persisted via
 * `session:setMcpServers` and applied to the next turn).
 */
export function McpPicker({ servers, selected, onChange }: McpPickerProps): React.ReactElement {
  const t = useT();
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const selectedSet = new Set(selected);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const toggle = (name: string) => {
    const next = selectedSet.has(name)
      ? selected.filter((s) => s !== name)
      : [...selected, name];
    onChange(next);
  };

  return (
    <div className="skill-picker-wrap" ref={popupRef}>
      <button
        type="button"
        className="model-picker-btn skill-picker-btn"
        onClick={() => setOpen((v) => !v)}
        title={t('mcp.title')}
      >
        <Server size={13} />
        <span className="skill-picker-label">
          {selected.length > 0 ? t('mcp.selectedCount', { count: selected.length }) : t('mcp.button')}
        </span>
        <ChevronDown size={10} />
      </button>

      {open && (
        <div className="skill-picker-popup">
          <div className="skill-picker-header">{t('mcp.title')}</div>
          <div className="skill-picker-list">
            {servers.length === 0 ? (
              <div className="skill-picker-empty">{t('mcp.empty')}</div>
            ) : (
              servers.map((s) => {
                const active = selectedSet.has(s.name);
                return (
                  <button
                    key={s.name}
                    type="button"
                    className={`skill-picker-item${active ? ' active' : ''}`}
                    onClick={() => toggle(s.name)}
                  >
                    <span className="skill-picker-checkbox" aria-hidden>
                      {active && <Check size={12} />}
                    </span>
                    <span className="mcp-status-icon">{STATUS_ICON[s.status] ?? STATUS_ICON.unconnected}</span>
                    <span className="skill-picker-meta">
                      <span className="skill-picker-name">{s.name}</span>
                      <span className="skill-picker-desc">
                        {s.toolCount > 0 ? `${s.toolCount} tools` : s.status}
                      </span>
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

McpPicker.displayName = 'McpPicker';
