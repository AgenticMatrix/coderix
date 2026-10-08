import React, { useState } from 'react';
import { Search, Plus, Library, Sparkles, Plug } from 'lucide-react';
import { motion } from 'framer-motion';
import { SessionList } from './SessionList';
import { useT } from '../../i18n/index.js';
import './Sidebar.css';

/** Which surface the main area shows. `sessions` = chat (no nav button). */
export type SidebarTab = 'sessions' | 'skills' | 'plugins' | 'library';

export interface SidebarProps {
  /** Currently active session ID */
  activeSessionId?: string;
  /** Callback when session is selected */
  onSessionSelect?: (sessionId: string) => void;
  /** Callback to create new session (新建任务) */
  onNewSession?: () => void;
  /** The currently-active surface (skills / plugins / library). */
  activeView: SidebarTab;
  /** Navigate to a surface (技能 / 插件 / 库). */
  onNavigate: (view: SidebarTab) => void;
}

export function Sidebar({
  activeSessionId,
  onSessionSelect,
  onNewSession,
  activeView,
  onNavigate,
}: SidebarProps): React.ReactElement {
  const [searchQuery, setSearchQuery] = useState('');
  const t = useT();

  const navBtn = (active: boolean) =>
    `w-full flex items-center gap-2 h-8 px-2.5 text-[13px] rounded-[var(--radius-md)] transition-colors ${
      active
        ? 'bg-[var(--color-brand-muted)] text-[var(--color-brand)]'
        : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)]'
    }`;

  return (
    <div className="h-full flex flex-col">
      {/* Top actions — 新建任务 / 技能 / 插件 / 库 (Zcode-style rail) */}
      <div className="px-3 pt-3 pb-2 flex flex-col gap-1 flex-shrink-0">
        <button
          type="button"
          onClick={onNewSession}
          className="w-full flex items-center justify-center gap-2 h-8 text-[13px] font-medium
                     rounded-[var(--radius-md)] bg-[var(--color-brand-light)] text-white
                     hover:opacity-90 transition-opacity"
        >
          <Plus size={15} />
          <span>{t('session.newSession')}</span>
        </button>

        <button type="button" onClick={() => onNavigate('skills')} className={navBtn(activeView === 'skills')}>
          <Sparkles size={15} />
          <span>{t('library.tabSkills')}</span>
        </button>

        <button type="button" onClick={() => onNavigate('plugins')} className={navBtn(activeView === 'plugins')}>
          <Plug size={15} />
          <span>{t('library.tabPlugins')}</span>
        </button>

        <button type="button" onClick={() => onNavigate('library')} className={navBtn(activeView === 'library')}>
          <Library size={15} />
          <span>{t('nav.library')}</span>
        </button>
      </div>

      {/* Divider */}
      <div className="mx-3 border-t border-[var(--color-separator)] flex-shrink-0" />

      {/* Session search */}
      <div className="px-3 pt-2 pb-2 flex-shrink-0">
        <div className="relative">
          <Search size={12} className="absolute left-2 top-0 bottom-0 my-auto pointer-events-none text-[var(--color-text-tertiary)]" />
          <input
            type="text"
            placeholder={t('session.search')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="
              w-full h-7 pl-7 pr-2 text-xs rounded-[var(--radius-md)]
              bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)]
              placeholder:text-[var(--color-text-tertiary)]
              border border-transparent
              focus:border-[var(--color-brand)] focus:outline-none focus:ring-1 focus:ring-[var(--color-brand)]/20
              transition-colors
            "
          />
        </div>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        <motion.div
          initial={{ opacity: 0, x: -10 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.15 }}
        >
          <SessionList
            activeSessionId={activeSessionId}
            onSessionSelect={onSessionSelect}
            searchQuery={searchQuery}
          />
        </motion.div>
      </div>
    </div>
  );
}

Sidebar.displayName = 'Sidebar';
