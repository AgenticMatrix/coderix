import React, { useState } from 'react';
import { Search, Plus, MessageSquare, FolderGit2, Users, Settings } from 'lucide-react';
import { motion } from 'framer-motion';
import { SessionList } from './SessionList';
import { FileExplorer } from './FileExplorer';
import { IconButton } from '../shared/IconButton';
import styles from './Sidebar.module.css';

export interface SidebarProps {
  /** Currently active session ID */
  activeSessionId?: string;
  /** Callback when session is selected */
  onSessionSelect?: (sessionId: string) => void;
  /** Callback to create new session */
  onNewSession?: () => void;
  /** Callback to open settings */
  onOpenSettings?: () => void;
}

type SidebarTab = 'sessions' | 'files' | 'team';

const tabs: { key: SidebarTab; label: string; icon: React.ReactNode }[] = [
  { key: 'sessions', label: 'Sessions', icon: <MessageSquare size={14} /> },
  { key: 'files', label: 'Files', icon: <FolderGit2 size={14} /> },
  { key: 'team', label: 'Team', icon: <Users size={14} /> },
];

export function Sidebar({
  activeSessionId,
  onSessionSelect,
  onNewSession,
  onOpenSettings,
}: SidebarProps): React.ReactElement {
  const [activeTab, setActiveTab] = useState<SidebarTab>('sessions');
  const [searchQuery, setSearchQuery] = useState('');

  return (
    <div className="h-full flex flex-col">
      {/* Header — search + new session */}
      <div className="px-3 pt-3 pb-2 space-y-2">
        <div className="flex items-center gap-2">
          <div className="flex-1 relative">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--color-text-tertiary)]" />
            <input
              type="text"
              placeholder="Search sessions..."
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
          <IconButton
            label="New session"
            icon={<Plus size={14} />}
            size="sm"
            onClick={onNewSession}
            shortcut="⌘N"
          />
        </div>

        {/* Tab selector */}
        <div className="flex rounded-[var(--radius-md)] bg-[var(--color-bg-tertiary)] p-0.5">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`
                flex-1 flex items-center justify-center gap-1.5 py-1.5 px-2 text-xs font-medium
                rounded-[var(--radius-sm)] transition-all duration-100
                ${
                  activeTab === tab.key
                    ? 'bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] shadow-[var(--shadow-sm)]'
                    : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]'
                }
              `}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        {activeTab === 'sessions' && (
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
        )}
        {activeTab === 'files' && (
          <motion.div
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.15 }}
          >
            <FileExplorer />
          </motion.div>
        )}
        {activeTab === 'team' && (
          <motion.div
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.15 }}
            className="p-4 text-xs text-[var(--color-text-tertiary)] text-center"
          >
            Team view — coming soon
          </motion.div>
        )}
      </div>

      {/* Footer */}
      <div className="p-2 border-t border-[var(--color-separator)]">
        <IconButton
          label="Settings"
          icon={<Settings size={14} />}
          size="sm"
          variant="ghost"
          onClick={onOpenSettings}
          tooltip="Settings"
          shortcut="⌘,"
        />
      </div>
    </div>
  );
}

Sidebar.displayName = 'Sidebar';
