import React from 'react';
import { MessageSquare, Code2, Library, Settings, Sun, Moon, Brain } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';
import { useT } from '../../i18n/index.js';
import './IconSidebar.css';
import styles from './IconSidebar.module.css';

export type SidebarTab = 'sessions' | 'project' | 'library';

interface Props {
  activeTab: SidebarTab;
  onTabChange: (tab: SidebarTab) => void;
  onSettings: () => void;
}

export function IconSidebar({ activeTab, onTabChange, onSettings }: Props): React.ReactElement {
  const t = useT();
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);
  const standardMode = useUIStore((s) => s.standardMode);
  const toggleStandardMode = useUIStore((s) => s.toggleStandardMode);

  const toggleTheme = () => setTheme(theme === 'light' ? 'dark' : 'light');

  return (
    <div className={`iconSidebar ${standardMode ? '' : 'detailMode'}`}>
      {/* macOS titlebar drag area */}
      <div className="dragArea" />

      {/* Navigation icons */}
      <nav className={styles.nav}>
        <button className={`${styles.iconButton} ${activeTab === 'sessions' ? styles.active : ''}`}
          onClick={() => onTabChange('sessions')} title={t('nav.sessions')}>
          <MessageSquare size={22} strokeWidth={activeTab === 'sessions' ? 2.5 : 2} />
          <span className={styles.tooltip}>{t('nav.sessions')}</span>
        </button>
        <button className={`${styles.iconButton} ${activeTab === 'project' ? styles.active : ''}`}
          onClick={() => onTabChange('project')} title={t('nav.project')}>
          <Code2 size={22} strokeWidth={activeTab === 'project' ? 2.5 : 2} />
          <span className={styles.tooltip}>{t('nav.project')}</span>
        </button>
        <button className={`${styles.iconButton} ${activeTab === 'library' ? styles.active : ''}`}
          onClick={() => onTabChange('library')} title={t('nav.library')}>
          <Library size={22} strokeWidth={activeTab === 'library' ? 2.5 : 2} />
          <span className={styles.tooltip}>{t('nav.library')}</span>
        </button>
      </nav>

      {/* Bottom actions */}
      <div className={styles.bottomActions}>
        <button
          className={`${styles.iconButton} ${standardMode ? '' : styles.active}`}
          onClick={toggleStandardMode}
          title={standardMode ? t('nav.switchToDetail') : t('nav.switchToStandard')}
        >
          <Brain size={20} strokeWidth={standardMode ? 2 : 2.5} />
          <span className="tooltip">{standardMode ? t('nav.detailMode') : t('nav.standardMode')}</span>
        </button>
        <button className={styles.iconButton} onClick={toggleTheme} title={theme === 'light' ? t('nav.switchToDark') : t('nav.switchToLight')}>
          {theme === 'light' ? <Sun size={20} strokeWidth={2} /> : <Moon size={20} strokeWidth={2} />}
          <span className="tooltip">{theme === 'light' ? t('nav.darkMode') : t('nav.lightMode')}</span>
        </button>
        <button className={styles.iconButton} onClick={onSettings} title={t('nav.settings')}>
          <Settings size={20} strokeWidth={2} />
          <span className="tooltip">{t('nav.settings')}</span>
        </button>
      </div>
    </div>
  );
}

IconSidebar.displayName = 'IconSidebar';
