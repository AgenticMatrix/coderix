import React, { useState } from 'react';
import { Check, Sparkles, FolderOpen, Plus, BookOpen } from 'lucide-react';
import type { SkillInfo } from '../../ipc-client.js';
import { useT } from '../../i18n/index.js';

type LibraryTab = 'skills' | 'knowledge' | 'projects';

export interface LibraryViewProps {
  /** All discoverable skills (from `skills:list`). */
  skills: SkillInfo[];
  /** Names of the skills currently selected for the active session. */
  selectedSkills: string[];
  /** Called with the next selection whenever a skill card is toggled. */
  onSkillsChange: (next: string[]) => void;
  /** Recent project directories (absolute paths). */
  projects: string[];
  /** Currently active project path (highlighted in the projects grid). */
  currentProject?: string;
  /** Open an existing project's management view (double-click a card). */
  onOpenProject: (path: string) => void;
  /** Open the directory picker to add a new project. */
  onAddProject: () => void;
}

/** Last path segment (folder name) without pulling in Node's `path`. */
function folderName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

const SOURCE_LABEL: Record<SkillInfo['source'], string> = {
  user: 'User',
  project: 'Project',
  plugin: 'Plugin',
  custom: 'Custom',
  builtin: 'Built-in',
};

/** Clamp description text to two lines (no Tailwind line-clamp plugin here). */
const clamp2: React.CSSProperties = {
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
};

/**
 * LibraryView — the full-page 「库」 surface. Replaces the chat column while the
 * library icon is active. Three tabs sit near the top of the interface, and
 * each tab's content renders as a tiled card grid (块平铺, product-card style)
 * rather than a file list.
 */
export function LibraryView({
  skills,
  selectedSkills,
  onSkillsChange,
  projects,
  currentProject,
  onOpenProject,
  onAddProject,
}: LibraryViewProps): React.ReactElement {
  const [tab, setTab] = useState<LibraryTab>('skills');
  const t = useT();
  const selectedSet = new Set(selectedSkills);

  const toggleSkill = (name: string) => {
    const next = selectedSet.has(name)
      ? selectedSkills.filter((s) => s !== name)
      : [...selectedSkills, name];
    onSkillsChange(next);
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden bg-[var(--color-bg-primary)]">
      {/* Tab bar — near the top of the library view */}
      <div className="flex-shrink-0 px-6 pt-3 border-b border-[var(--color-separator)]">
        <div className="flex items-center gap-1">
          <TabButton active={tab === 'projects'} onClick={() => setTab('projects')} label={t('library.tabProjects')} />
          <TabButton active={tab === 'skills'} onClick={() => setTab('skills')} label={t('library.tabSkills')} />
          <TabButton active={tab === 'knowledge'} onClick={() => setTab('knowledge')} label={t('library.tabKnowledge')} />
        </div>
      </div>

      {/* Content — tiled card grid */}
      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
        {tab === 'skills' &&
          (skills.length === 0 ? (
            <EmptyState icon={<Sparkles size={20} />} text={t('skills.empty')} />
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
              {skills.map((s) => {
                const active = selectedSet.has(s.name);
                return (
                  <button
                    key={s.name}
                    type="button"
                    onClick={() => toggleSkill(s.name)}
                    className={`flex flex-col text-left p-4 rounded-[var(--radius-lg)] border transition-colors cursor-pointer
                      ${active
                        ? 'border-[var(--color-brand)] bg-[var(--color-brand-muted)]'
                        : 'border-[var(--color-separator)] bg-[var(--color-bg-secondary)] hover:border-[var(--color-brand)]/40 hover:bg-[var(--color-bg-tertiary)]'}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="flex items-center justify-center w-10 h-10 rounded-[var(--radius-md)] bg-[var(--color-brand-muted)] text-[var(--color-brand)]">
                        <Sparkles size={18} />
                      </span>
                      {active && (
                        <span className="flex items-center justify-center w-5 h-5 rounded-full bg-[var(--color-brand)] text-white">
                          <Check size={12} strokeWidth={3} />
                        </span>
                      )}
                    </div>
                    <span className="mt-3 text-sm font-semibold text-[var(--color-text-primary)] truncate">{s.name}</span>
                    <span className="mt-1 text-xs text-[var(--color-text-tertiary)] leading-snug" style={clamp2}>
                      {s.description}
                    </span>
                    <span className="mt-3 pt-2 border-t border-[var(--color-separator)]/60 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-[var(--color-text-tertiary)]">
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-brand)]" />
                      {SOURCE_LABEL[s.source]}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}

        {tab === 'knowledge' && <EmptyState icon={<BookOpen size={20} />} text={t('library.knowledgeEmpty')} />}

        {tab === 'projects' && (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
            {projects.map((p) => {
              const active = p === currentProject;
              return (
                <button
                  key={p}
                  type="button"
                  onDoubleClick={() => onOpenProject(p)}
                  title={p}
                  className={`flex flex-col text-left p-4 rounded-[var(--radius-lg)] border transition-colors cursor-pointer
                    ${active
                      ? 'border-[var(--color-brand)] bg-[var(--color-brand-muted)]'
                      : 'border-[var(--color-separator)] bg-[var(--color-bg-secondary)] hover:border-[var(--color-brand)]/40 hover:bg-[var(--color-bg-tertiary)]'}`}
                >
                  <span
                    className={`flex items-center justify-center w-10 h-10 rounded-[var(--radius-md)] ${
                      active
                        ? 'bg-[var(--color-brand-muted)] text-[var(--color-brand)]'
                        : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-tertiary)]'
                    }`}
                  >
                    <FolderOpen size={18} />
                  </span>
                  <span className="mt-3 text-sm font-semibold text-[var(--color-text-primary)] truncate">{folderName(p)}</span>
                  <span className="mt-3 pt-2 border-t border-[var(--color-separator)]/60 flex items-center gap-1.5 text-[10px] text-[var(--color-text-tertiary)]">
                    {active ? (
                      <>
                        <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-brand)]" />
                        {t('library.currentProject')}
                      </>
                    ) : (
                      ' '
                    )}
                  </span>
                </button>
              );
            })}
            <button
              type="button"
              onClick={onAddProject}
              className="flex flex-col items-center justify-center gap-2 p-4 min-h-[136px] rounded-[var(--radius-lg)]
                         border border-dashed border-[var(--color-separator)] text-[var(--color-text-tertiary)]
                         hover:text-[var(--color-text-primary)] hover:border-[var(--color-brand)]/40 transition-colors cursor-pointer"
            >
              <span className="flex items-center justify-center w-10 h-10 rounded-[var(--radius-md)] bg-[var(--color-bg-tertiary)]">
                <Plus size={18} />
              </span>
              <span className="text-xs">{t('library.addProject')}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

LibraryView.displayName = 'LibraryView';

function TabButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px
        ${active
          ? 'border-[var(--color-brand)] text-[var(--color-text-primary)]'
          : 'border-transparent text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]'}`}
    >
      {label}
    </button>
  );
}

function EmptyState({ icon, text }: { icon: React.ReactNode; text: string }): React.ReactElement {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-[var(--color-text-tertiary)]">
      <span className="opacity-60">{icon}</span>
      <span className="text-xs">{text}</span>
    </div>
  );
}
