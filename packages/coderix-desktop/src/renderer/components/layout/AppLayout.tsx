import React, { type ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ResizablePanel } from '../shared/ResizablePanel';
import { StatusBar, type StatusBarProps } from '../shared/StatusBar';
import { IconSidebar } from '../sidebar/IconSidebar';
import type { SidebarTab } from '../sidebar/IconSidebar';

export interface AppLayoutProps {
  sidebar: ReactNode;
  sidebarVisible?: boolean;
  sidebarWidth?: number;
  onSidebarResize?: (width: number) => void;
  children: ReactNode;
  detailPanel?: ReactNode;
  detailVisible?: boolean;
  detailWidth?: number;
  onDetailResize?: (width: number) => void;
  statusBarProps?: StatusBarProps;
  headerActions?: ReactNode;
  iconActiveTab: SidebarTab;
  onIconTabChange: (tab: SidebarTab) => void;
  onIconSettings: () => void;
}

/**
 * WeChat × Apple animation presets:
 * Fast, smooth, subtle — no bouncy overshoots.
 * 0.2s, ease-out matches Apple's standard UI animation curve.
 */
const sidebarTransition = {
  duration: 0.2,
  ease: [0, 0, 0.2, 1], // Apple ease-out
};

const sidebarAnimation = {
  initial: { width: 0, opacity: 0 },
  animate: { width: 'auto', opacity: 1 },
  exit: { width: 0, opacity: 0 },
  transition: sidebarTransition,
};

const detailAnimation = {
  initial: { width: 0, opacity: 0, x: 12 },
  animate: { width: 'auto', opacity: 1, x: 0 },
  exit: { width: 0, opacity: 0, x: 12 },
  transition: sidebarTransition,
};

export function AppLayout({
  sidebar,
  sidebarVisible = true,
  sidebarWidth = 260,
  onSidebarResize,
  children,
  detailPanel,
  detailVisible = false,
  detailWidth = 380,
  onDetailResize,
  statusBarProps,
  headerActions,
  iconActiveTab,
  onIconTabChange,
  onIconSettings,
}: AppLayoutProps): React.ReactElement {
  return (
    <div className="h-screen flex bg-[var(--color-bg-primary)] overflow-hidden">
      <IconSidebar activeTab={iconActiveTab} onTabChange={onIconTabChange} onSettings={onIconSettings} />

      <div className="flex-1 flex flex-col min-w-0">
      {/* Header bar — draggable titlebar for frameless window */}
      <header
        className="titlebar-drag flex items-center h-10 px-4 flex-shrink-0
                   bg-[var(--color-bg-primary)] border-b border-[var(--color-separator)]
                   select-none z-[var(--z-sticky)]"
      >
        {/* App name */}
        <span className="text-[13px] font-semibold text-[var(--color-text-secondary)] tracking-tight">
          Coderix
        </span>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Window action buttons — no-drag so they remain clickable */}
        <div className="titlebar-no-drag flex items-center gap-1">
          {/* Sidebar toggle */}
          <button
            className="w-7 h-7 flex items-center justify-center rounded-[var(--radius-sm)]
                       text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]
                       hover:bg-[var(--color-bg-tertiary)] transition-colors"
            onClick={() => window.dispatchEvent(new CustomEvent('coderix:toggle-sidebar'))}
            title="Toggle Sidebar (⌘B)"
            aria-label="Toggle Sidebar"
          >
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.2">
              <rect x="1.5" y="2.5" width="12" height="10" rx="1.5" />
              <path d="M5.5 2.5v10" />
            </svg>
          </button>
        </div>
      </header>

      {/* Main content area */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* Sidebar — WeChat-style frosted glass with subtle right border */}
        <AnimatePresence initial={false}>
          {sidebarVisible && (
            <motion.div
              {...sidebarAnimation}
              className="overflow-hidden flex-shrink-0"
            >
              <ResizablePanel
                direction="right"
                defaultSize={sidebarWidth}
                minSize={200}
                maxSize={400}
                onResize={onSidebarResize}
                className="h-full glass-sidebar border-r border-[var(--color-separator)]"
              >
                {sidebar}
              </ResizablePanel>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Main content */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden bg-[var(--color-bg-primary)]">
          {children}
        </div>

        {/* Detail panel — clean white/dark surface */}
        <AnimatePresence initial={false}>
          {detailVisible && detailPanel && (
            <motion.div
              {...detailAnimation}
              className="overflow-hidden flex-shrink-0"
            >
              <ResizablePanel
                direction="left"
                defaultSize={detailWidth}
                minSize={280}
                maxSize={600}
                onResize={onDetailResize}
                className="h-full bg-[var(--color-bg-secondary)] border-l border-[var(--color-separator)]"
              >
                {detailPanel}
              </ResizablePanel>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Status bar */}
      <StatusBar {...statusBarProps} />
      </div>{/* closes flex-1 flex-col min-w-0 */}
    </div>
  );
}

AppLayout.displayName = 'AppLayout';
