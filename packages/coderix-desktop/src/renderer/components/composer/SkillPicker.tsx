import React, { useState, useRef, useEffect } from 'react';
import { Sparkles, ChevronDown, Check, Plus, X } from 'lucide-react';
import type { SkillInfo } from '../../ipc-client.js';
import { useT } from '../../i18n/index.js';
import './SkillPicker.css';

export interface SkillPickerProps {
  /** All discoverable skills (from `skills:list`). */
  skills: SkillInfo[];
  /** Names of the skills currently selected for the active session. */
  selected: string[];
  /** Called with the next selection whenever a skill is toggled. */
  onChange: (next: string[]) => void;
  /** Custom skill directories (app-level, persisted in settings.json). */
  customDirs: string[];
  /** Open a directory picker to add a custom skill directory. */
  onAddDir: () => void;
  /** Remove a custom skill directory by path. */
  onRemoveDir: (path: string) => void;
}

/** Last path segment (folder name) without pulling in Node's `path`. */
function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/**
 * Composer skill picker: a small button next to the model picker that opens an
 * upward popup listing every discoverable Claude Code skill. Toggling an entry
 * updates the active session's selection, which is persisted (via
 * `session:setSkills`) and applied to the next turn (`options.skills`).
 *
 * A footer manages custom skill directories: the user can add any folder of
 * `<name>/SKILL.md` skills, and the app will expose them to the CLI.
 */
export function SkillPicker({ skills, selected, onChange, customDirs, onAddDir, onRemoveDir }: SkillPickerProps): React.ReactElement {
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
        title={t('skills.title')}
      >
        <Sparkles size={13} />
        <span className="skill-picker-label">
          {selected.length > 0 ? t('skills.selectedCount', { count: selected.length }) : t('skills.button')}
        </span>
        <ChevronDown size={10} />
      </button>

      {open && (
        <div className="skill-picker-popup">
          <div className="skill-picker-header">{t('skills.title')}</div>
          <div className="skill-picker-list">
            {skills.length === 0 ? (
              <div className="skill-picker-empty">{t('skills.empty')}</div>
            ) : (
              skills.map((s) => {
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
                    <span className="skill-picker-meta">
                      <span className="skill-picker-name">{s.name}</span>
                      {s.description && <span className="skill-picker-desc">{s.description}</span>}
                    </span>
                  </button>
                );
              })
            )}
          </div>

          {/* Custom skill directories */}
          <div className="skill-picker-footer">
            <div className="skill-picker-footer-head">
              <span className="skill-picker-footer-title">{t('skills.customDirs')}</span>
              <button type="button" className="skill-picker-add" onClick={onAddDir} title={t('skills.addDir')}>
                <Plus size={12} />
                <span>{t('skills.addDir')}</span>
              </button>
            </div>
            {customDirs.length === 0 ? (
              <div className="skill-picker-empty">{t('skills.noCustomDirs')}</div>
            ) : (
              customDirs.map((dir) => (
                <div key={dir} className="skill-picker-dir">
                  <span className="skill-picker-dir-name" title={dir}>{basename(dir)}</span>
                  <button
                    type="button"
                    className="skill-picker-dir-remove"
                    onClick={() => onRemoveDir(dir)}
                    title={t('skills.removeDir')}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

SkillPicker.displayName = 'SkillPicker';
