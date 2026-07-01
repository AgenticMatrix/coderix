import React, { type ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ResizablePanel } from '../shared/ResizablePanel';
import { StatusBar, type StatusBarProps } from '../shared/StatusBar';

export interface AppLayoutProps {
  /** Sidebar content */
  sidebar: ReactNode;
  /** Is sidebar visible */
  sidebarVisible?: boolean;
  /** Sidebar width */
  sidebarWidth?: number;
  /** Sidebar width callback */
  onSidebarResize?: (width: number) => void;
  /** Main content */
  children: ReactNode;
  /** Detail panel content */
  detailPanel?: ReactNode;
  /** Is detail panel visible */
  detailVisible?: boolean;
  /** Detail panel width */
  detailWidth?: number;
  /** Detail panel width callback */
  onDetailResize?: (width: number) => void;
  /** Status bar props */
  statusBarProps?: StatusBarProps;
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
}: AppLayoutProps): React.ReactElement {
  return (
    <div className="h-screen flex flex-col bg-[var(--color-bg-primary)] overflow-hidden">
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
    </div>
  );
}

AppLayout.displayName = 'AppLayout';
