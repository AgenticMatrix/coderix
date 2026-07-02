import React from 'react';
import { MessageSquare, FolderOpen, Settings } from 'lucide-react';
import styles from './IconSidebar.module.css';

interface NavItem {
  id: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
  label: string;
}

const navItems: NavItem[] = [
  { id: 'chat', icon: MessageSquare, label: 'Chat' },
  { id: 'files', icon: FolderOpen, label: 'Files' },
];

export function IconSidebar(): React.ReactElement {
  const [activeNav, setActiveNav] = React.useState('chat');

  return (
    <div className={styles.iconSidebar}>
      {/* macOS titlebar drag area */}
      <div className={styles.dragArea} />

      {/* Navigation icons */}
      <nav className={styles.nav}>
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeNav === item.id;
          return (
            <button
              key={item.id}
              onClick={() => setActiveNav(item.id)}
              className={`${styles.iconButton} ${isActive ? styles.active : ''}`}
              aria-label={item.label}
            >
              <Icon size={22} strokeWidth={isActive ? 2.5 : 2} />
              <span className={styles.tooltip}>{item.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Bottom actions */}
      <div className={styles.bottomActions}>
        <button
          className={styles.iconButton}
          aria-label="Settings"
        >
          <Settings size={20} strokeWidth={2} />
          <span className={styles.tooltip}>Settings</span>
        </button>
      </div>
    </div>
  );
}

IconSidebar.displayName = 'IconSidebar';
