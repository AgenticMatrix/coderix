import React, { useState } from 'react';
import { Check, Sparkles, FolderOpen, Plus, BookOpen, Plug } from 'lucide-react';
import type { SkillInfo, McpServerStatus } from '../../ipc-client.js';
import { useT } from '../../i18n/index.js';
import { APPS, type AppDefinition } from '../apps/registry';

type LibraryTab = 'projects' | 'knowledge';

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

// ── Skills view ────────────────────────────────────────────────────────────

export interface SkillsViewProps {
  /** All discoverable skills (from `skills:list`). */
  skills: SkillInfo[];
  /** Names of the skills currently selected for the active session. */
  selectedSkills: string[];
  /** Called with the next selection whenever a skill card is toggled. */
  onSkillsChange: (next: string[]) => void;
}

/**
 * SkillsView — the full-page 「技能」 surface reached from the sidebar. Shows the
 * discoverable skills as a tiled card grid (mirrors the former library tab).
 */
export function SkillsView({
  skills,
  selectedSkills,
  onSkillsChange,
}: SkillsViewProps): React.ReactElement {
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
      <div className="flex-shrink-0 px-6 pt-3 pb-2 border-b border-[var(--color-separator)]">
        <span className="text-sm font-semibold text-[var(--color-text-primary)]">{t('library.tabSkills')}</span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
        {skills.length === 0 ? (
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
        )}
      </div>
    </div>
  );
}

SkillsView.displayName = 'SkillsView';

// ── Plugins view ───────────────────────────────────────────────────────────

export interface PluginsViewProps {
  /** Attach an app (plugin) to the current conversation. */
  onOpenApp: (app: AppDefinition) => void;
  /** All configured MCP servers with live status (「链接器」 tab). */
  mcpServers: McpServerStatus[];
  /** MCP server names enabled for the active session. */
  selectedMcp: string[];
  /** Toggle the active session's MCP server selection. */
  onMcpChange: (names: string[]) => void;
}

/**
 * PluginsView — the full-page 「链接器」 surface reached from the sidebar. Two tabs:
 * 「应用插件」(apps) first, 「链接器」(MCP servers) second.
 */
export function PluginsView({ onOpenApp, mcpServers, selectedMcp, onMcpChange }: PluginsViewProps): React.ReactElement {
  const t = useT();
  const [tab, setTab] = useState<'apps' | 'mcp'>('apps');

  const toggleMcp = (name: string) => {
    const next = selectedMcp.includes(name)
      ? selectedMcp.filter((s) => s !== name)
      : [...selectedMcp, name];
    onMcpChange(next);
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden bg-[var(--color-bg-primary)]">
      {/* Tab bar — 应用插件 first, 链接器 second */}
      <div className="flex-shrink-0 px-6 pt-3 border-b border-[var(--color-separator)]">
        <div className="flex items-center gap-1">
          <TabButton active={tab === 'apps'} onClick={() => setTab('apps')} label={t('plugins.tabApps')} />
          <TabButton active={tab === 'mcp'} onClick={() => setTab('mcp')} label={t('plugins.tabMcp')} />
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
        {tab === 'apps' && (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
            {APPS.map((app) => {
              const Icon = app.icon;
              return (
                <button
                  key={app.id}
                  type="button"
                  onClick={() => onOpenApp(app)}
                  className="flex flex-col items-start gap-3 p-4 rounded-[var(--radius-lg)] border border-[var(--color-separator)] bg-[var(--color-bg-secondary)] text-left hover:border-[var(--color-brand)]/40 hover:bg-[var(--color-bg-tertiary)] transition-colors cursor-pointer"
                >
                  <span className="flex items-center justify-center w-10 h-10 rounded-[var(--radius-md)] bg-[var(--color-brand-muted)] text-[var(--color-brand)]">
                    <Icon size={20} />
                  </span>
                  <span className="space-y-1">
                    <span className="block text-sm font-medium text-[var(--color-text-primary)]">{app.name}</span>
                    <span className="block text-xs text-[var(--color-text-tertiary)]">{app.description}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {tab === 'mcp' && (
          mcpServers.length === 0 ? (
            <div className="py-10 text-center text-sm text-[var(--color-text-tertiary)]">{t('plugins.empty')}</div>
          ) : (
            <div className="flex flex-col gap-2 max-w-2xl">
              {mcpServers.map((s) => {
                const enabled = selectedMcp.includes(s.name);
                return (
                  <button
                    key={s.name}
                    type="button"
                    onClick={() => toggleMcp(s.name)}
                    className="flex items-center gap-3 p-3 rounded-[var(--radius-md)] border border-[var(--color-separator)] bg-[var(--color-bg-secondary)] text-left hover:border-[var(--color-brand)]/40 transition-colors cursor-pointer"
                  >
                    <span
                      className={`flex items-center justify-center w-5 h-5 rounded border ${
                        enabled
                          ? 'bg-[var(--color-brand)] border-[var(--color-brand)] text-white'
                          : 'border-[var(--color-separator)] text-transparent'
                      }`}
                    >
                      <Check size={13} />
                    </span>
                    <Plug size={15} className="text-[var(--color-brand)]" />
                    <span className="flex-1">
                      <span className="block text-sm font-medium text-[var(--color-text-primary)]">{s.name}</span>
                      <span className="block text-xs text-[var(--color-text-tertiary)]">
                        {s.toolCount > 0 ? `${s.toolCount} tools` : s.status}
                      </span>
                    </span>
                    <span className="text-xs text-[var(--color-text-tertiary)]">{s.status}</span>
                  </button>
                );
              })}
            </div>
          )
        )}
      </div>
    </div>
  );
}

PluginsView.displayName = 'PluginsView';

// ── Library view (projects + knowledge) ────────────────────────────────────

export interface LibraryViewProps {
  /** Recent project directories (absolute paths). */
  projects: string[];
  /** Currently active project path (highlighted in the projects grid). */
  currentProject?: string;
  /** Open an existing project's management view (double-click a card). */
  onOpenProject: (path: string) => void;
  /** Open the directory picker to add a new project. */
  onAddProject: () => void;
  /** Right-click 「移除」: drop the project from the app's list (no file deletion). */
  onRemoveProject?: (path: string) => void;
}

/**
 * LibraryView — the 「库」 surface reached from the sidebar. Its skills/plugins
 * tabs have moved up into the sidebar, so only 项目 (projects) and 知识库
 * (knowledge) remain here.
 */
export function LibraryView({
  projects,
  currentProject,
  onOpenProject,
  onAddProject,
  onRemoveProject,
}: LibraryViewProps): React.ReactElement {
  const [tab, setTab] = useState<LibraryTab>('projects');
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const t = useT();

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden bg-[var(--color-bg-primary)]">
      {/* Tab bar — near the top of the library view */}
      <div className="flex-shrink-0 px-6 pt-3 border-b border-[var(--color-separator)]">
        <div className="flex items-center gap-1">
          <TabButton active={tab === 'projects'} onClick={() => setTab('projects')} label={t('library.tabProjects')} />
          <TabButton active={tab === 'knowledge'} onClick={() => setTab('knowledge')} label={t('library.tabKnowledge')} />
        </div>
      </div>

      {/* Content — tiled card grid */}
      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
        {tab === 'knowledge' && <EmptyState icon={<BookOpen size={20} />} text={t('library.knowledgeEmpty')} />}

        {tab === 'projects' && (
          <>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
            {projects.map((p) => {
              const active = p === currentProject;
              return (
                <button
                  key={p}
                  type="button"
                  onDoubleClick={() => onOpenProject(p)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (onRemoveProject) setMenu({ path: p, x: e.clientX, y: e.clientY });
                  }}
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
          {menu && onRemoveProject && (
            <>
              <div
                className="fixed inset-0 z-50"
                onClick={() => setMenu(null)}
                onContextMenu={(e) => { e.preventDefault(); setMenu(null); }}
              />
              <div
                className="fixed z-50 rounded-[var(--radius-md)] bg-[var(--color-bg-primary)] border border-[var(--color-separator)] shadow-lg py-1 w-40"
                style={{ left: menu.x, top: menu.y }}
              >
                <button
                  type="button"
                  onClick={() => { onRemoveProject(menu.path); setMenu(null); }}
                  className="w-full text-left px-3 py-1.5 text-xs text-[var(--color-danger)] hover:bg-[var(--color-bg-tertiary)]"
                >
                  {t('library.removeProject')}
                </button>
              </div>
            </>
          )}
          </>
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
