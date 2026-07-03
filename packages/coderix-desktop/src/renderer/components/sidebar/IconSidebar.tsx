import React from 'react';
import { MessageSquare, FolderOpen, Settings } from 'lucide-react';
import './IconSidebar.css';

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
    <div className="iconSidebar">
      {/* macOS titlebar drag area */}
      <div className="dragArea" />

      {/* Navigation icons */}
      <nav className="nav">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeNav === item.id;
          return (
            <button
              key={item.id}
              onClick={() => setActiveNav(item.id)}
              className={`icon-button ${isActive ? 'active' : ''}`}
              aria-label={item.label}
            >
              <Icon size={22} strokeWidth={isActive ? 2.5 : 2} />
              <span className="tooltip">{item.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Bottom actions */}
      <div className="bottomActions">
        <button
          className="iconButton"
          aria-label="Settings"
        >
          <Settings size={20} strokeWidth={2} />
          <span className="tooltip">Settings</span>
        </button>
      </div>
    </div>
  );
}

IconSidebar.displayName = 'IconSidebar';
