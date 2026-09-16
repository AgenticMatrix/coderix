import React, { useState } from 'react';
import { FileExplorer } from './FileExplorer';
import { GitPanel } from './GitPanel';
import { useT } from '../../i18n/index.js';

type ProjectTab = 'files' | 'git';

/**
 * ProjectPanel — the merged "项目管理" view. Combines the file explorer and the
 * source-control (git) manager behind a two-tab segmented control so they share
 * one icon-sidebar entry instead of two.
 */
export function ProjectPanel({ projectPath }: { projectPath?: string }): React.ReactElement {
  const [tab, setTab] = useState<ProjectTab>('files');
  const t = useT();

  return (
    <div className="h-full flex flex-col">
      {/* Tab bar — sits above the file/git list, Apple-style segmented control */}
      <div className="px-3 pt-2 pb-2 flex-shrink-0">
        <div className="flex bg-[var(--color-bg-tertiary)] rounded-[var(--radius-md)] p-0.5">
          <TabButton
            active={tab === 'files'}
            onClick={() => setTab('files')}
            label={t('project.tabFiles')}
          />
          <TabButton
            active={tab === 'git'}
            onClick={() => setTab('git')}
            label={t('project.tabGit')}
          />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        {tab === 'files' ? (
          <FileExplorer projectPath={projectPath} />
        ) : (
          <GitPanel projectPath={projectPath} />
        )}
      </div>
    </div>
  );
}

ProjectPanel.displayName = 'ProjectPanel';

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
      className={`flex-1 flex items-center justify-center py-1 text-xs font-medium rounded-[var(--radius-sm)] transition-colors
        ${active
          ? 'bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] shadow-sm'
          : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]'}`}
    >
      {label}
    </button>
  );
}
