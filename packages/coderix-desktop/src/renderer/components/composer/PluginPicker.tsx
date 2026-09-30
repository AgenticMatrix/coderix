import React, { useState, useRef, useEffect } from 'react';
import { Puzzle, ChevronDown, Check } from 'lucide-react';
import type { AppDefinition } from '../apps/registry';
import { useT } from '../../i18n/index.js';
// Reuses the SkillPicker popup styles (same checkbox-list look).
import './SkillPicker.css';

export interface PluginPickerProps {
  /** Registered plugins (from the app registry). */
  plugins: AppDefinition[];
  /** Names of the skills currently enabled for the active session. */
  selectedSkills: string[];
  /** Called when a plugin is toggled: `checked` is the target state. */
  onToggle: (plugin: AppDefinition, checked: boolean) => void;
}

/**
 * Composer plugin picker: a small button next to the skill picker that opens an
 * upward popup listing every registered plugin. Toggling a plugin enables (or
 * disables) its skills for the current conversation — a shorthand for bundling
 * the plugin's skills together, mirroring the library's「插件」tab.
 */
export function PluginPicker({ plugins, selectedSkills, onToggle }: PluginPickerProps): React.ReactElement {
  const t = useT();
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // A plugin is "checked" when all of its skills are enabled.
  const isChecked = (plugin: AppDefinition) =>
    plugin.skills.length > 0 && plugin.skills.every((s) => selectedSkills.includes(s));

  const checkedCount = plugins.filter(isChecked).length;

  return (
    <div className="skill-picker-wrap" ref={popupRef}>
      <button
        type="button"
        className="model-picker-btn skill-picker-btn"
        onClick={() => setOpen((v) => !v)}
        title={t('plugins.title')}
      >
        <Puzzle size={13} />
        <span className="skill-picker-label">
          {checkedCount > 0 ? t('plugins.selectedCount', { count: checkedCount }) : t('plugins.button')}
        </span>
        <ChevronDown size={10} />
      </button>

      {open && (
        <div className="skill-picker-popup">
          <div className="skill-picker-header">{t('plugins.title')}</div>
          <div className="skill-picker-list">
            {plugins.length === 0 ? (
              <div className="skill-picker-empty">{t('plugins.empty')}</div>
            ) : (
              plugins.map((p) => {
                const checked = isChecked(p);
                const Icon = p.icon;
                return (
                  <button
                    key={p.id}
                    type="button"
                    className={`skill-picker-item${checked ? ' active' : ''}`}
                    onClick={() => onToggle(p, !checked)}
                  >
                    <span className="skill-picker-checkbox" aria-hidden>
                      {checked && <Check size={12} />}
                    </span>
                    <span className="flex-shrink-0 flex items-center justify-center w-6 h-6 rounded-[var(--radius-md)] bg-[var(--color-brand-muted)] text-[var(--color-brand)]">
                      <Icon size={14} />
                    </span>
                    <span className="skill-picker-meta">
                      <span className="skill-picker-name">{p.name}</span>
                      {p.description && <span className="skill-picker-desc">{p.description}</span>}
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

PluginPicker.displayName = 'PluginPicker';
