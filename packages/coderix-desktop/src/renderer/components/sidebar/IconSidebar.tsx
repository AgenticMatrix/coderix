import React from 'react';
import { MessageSquare, FolderGit2, GitBranch, Settings } from 'lucide-react';
import './IconSidebar.css';
import styles from './IconSidebar.module.css';

export type SidebarTab = 'sessions' | 'files' | 'git';

interface Props {
  activeTab: SidebarTab;
  onTabChange: (tab: SidebarTab) => void;
  onSettings: () => void;
}

export function IconSidebar({ activeTab, onTabChange, onSettings }: Props): React.ReactElement {
  return (
    <div className="iconSidebar">
      {/* macOS titlebar drag area */}
      <div className="dragArea" />

      {/* Navigation icons */}
      <nav className={styles.nav}>
        <button className={`${styles.iconButton} ${activeTab === 'sessions' ? styles.active : ''}`}
          onClick={() => onTabChange('sessions')} title="Sessions">
          <MessageSquare size={22} strokeWidth={activeTab === 'sessions' ? 2.5 : 2} />
          <span className={styles.tooltip}>Sessions</span>
        </button>
        <button className={`${styles.iconButton} ${activeTab === 'files' ? styles.active : ''}`}
          onClick={() => onTabChange('files')} title="Explorer">
          <FolderGit2 size={22} strokeWidth={activeTab === 'files' ? 2.5 : 2} />
          <span className={styles.tooltip}>Explorer</span>
        </button>
        <button className={`${styles.iconButton} ${activeTab === 'git' ? styles.active : ''}`}
          onClick={() => onTabChange('git')} title="Source Control">
          <GitBranch size={22} strokeWidth={activeTab === 'git' ? 2.5 : 2} />
          <span className={styles.tooltip}>Source Control</span>
        </button>
      </nav>

      {/* Bottom actions */}
      <div className={styles.bottomActions}>
        <button className={styles.iconButton} onClick={onSettings} title="Settings">
          <Settings size={20} strokeWidth={2} />
          <span className="tooltip">Settings</span>
        </button>
      </div>
    </div>
  );
}

IconSidebar.displayName = 'IconSidebar';
