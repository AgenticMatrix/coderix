import React from 'react';
import { MessageSquare, FolderGit2, GitBranch, Settings, Sun, Moon, Brain } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';
import './IconSidebar.css';
import styles from './IconSidebar.module.css';

export type SidebarTab = 'sessions' | 'files' | 'git';

interface Props {
  activeTab: SidebarTab;
  onTabChange: (tab: SidebarTab) => void;
  onSettings: () => void;
}

export function IconSidebar({ activeTab, onTabChange, onSettings }: Props): React.ReactElement {
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);
  const standardMode = useUIStore((s) => s.standardMode);
  const toggleStandardMode = useUIStore((s) => s.toggleStandardMode);

  const toggleTheme = () => setTheme(theme === 'light' ? 'dark' : 'light');

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
        <button
          className={`${styles.iconButton} ${standardMode ? styles.active : ''}`}
          onClick={toggleStandardMode}
          title={standardMode ? '切换到详细模式' : '切换到标准模式'}
        >
          <Brain size={20} strokeWidth={standardMode ? 2.5 : 2} />
          <span className="tooltip">{standardMode ? '详细模式' : '标准模式'}</span>
        </button>
        <button className={styles.iconButton} onClick={toggleTheme} title={theme === 'light' ? 'Switch to Dark' : 'Switch to Light'}>
          {theme === 'light' ? <Sun size={20} strokeWidth={2} /> : <Moon size={20} strokeWidth={2} />}
          <span className="tooltip">{theme === 'light' ? 'Dark Mode' : 'Light Mode'}</span>
        </button>
        <button className={styles.iconButton} onClick={onSettings} title="Settings">
          <Settings size={20} strokeWidth={2} />
          <span className="tooltip">Settings</span>
        </button>
      </div>
    </div>
  );
}

IconSidebar.displayName = 'IconSidebar';
