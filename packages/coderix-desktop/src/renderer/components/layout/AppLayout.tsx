import React, { useRef, useCallback, useState, useEffect, type ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Globe, Maximize2, Minimize2 } from 'lucide-react';
import { StatusBar, type StatusBarProps } from '../shared/StatusBar';
import { Notifications } from '../shared/Notifications';
import { IconSidebar } from '../sidebar/IconSidebar';
import type { SidebarTab } from '../sidebar/IconSidebar';
import { EditorTabs } from '../editor/EditorTabs';
import { useT } from '../../i18n/index.js';
import { useUIStore } from '../../store/uiStore';

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
  browserPanel?: ReactNode;
  browserPanelVisible?: boolean;
  onToggleBrowserPanel?: () => void;
  onToggleDetailPanel?: () => void;
}

/** Fixed width of the embedded browser sidebar. */
const BROWSER_WIDTH = 720;
/** Minimum width the browser column collapses to before the chat area yields. */
const BROWSER_MIN_WIDTH = 200;
/** Minimum width of the chat area (browser shrinks first, then chat to this floor). */
const CHAT_MIN_WIDTH = 200;
/** Maximum width the file/detail column can be dragged out to. */
const DETAIL_MAX_WIDTH = 1600;
/** Fixed width of the icon rail on the far left. */
const ICON_SIDEBAR_WIDTH = 65;

/**
 * WeChat × Apple animation presets:
 * Fast, smooth, subtle — no bouncy overshoots.
 * 0.2s, ease-out matches Apple's standard UI animation curve.
 */
const sidebarTransition = {
  duration: 0.2,
  ease: [0, 0, 0.2, 1], // Apple ease-out
};

// Animate only opacity/transform — never `width`. Animating `width` to the
// string 'auto' forces framer-motion to measure the column's natural width;
// during a re-render where the sidebar content is swapped (e.g. selecting a
// session whose cwd differs re-renders the `sidebar` prop) that measurement can
// resolve to 0 and the column collapses to zero width, taking the header title
// with it and leaving only the chat area. The inner fixed-width div already
// sets the real width, so dropping the width keyframe can't collapse anything.
const sidebarAnimation = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: sidebarTransition,
};

const detailAnimation = {
  initial: { opacity: 0, x: 12 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: 12 },
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
  browserPanel,
  browserPanelVisible = false,
  onToggleBrowserPanel,
  onToggleDetailPanel,
}: AppLayoutProps): React.ReactElement {
  const t = useT();
  // Browser column width — lives here (not inside the panel) so it survives
  // the panel being closed and reopened.
  const [browserWidth, setBrowserWidth] = useState(BROWSER_WIDTH);
  // Detail width is lifted here (like browserWidth) so the header's spacer and
  // the resizable panel always agree. Otherwise the header's browser/sidebar
  // toggle buttons stay pinned to the default width while the panel drags.
  const [detailWidthState, setDetailWidthState] = useState(detailWidth || 380);

  // Which panel (if any) is expanded to fill the window — mirrors
  // agentstation-app's `maximizedPanel`. Only one column can be maximized at a
  // time; the icon rail stays visible and the chosen column fills the rest.
  const maximizedPanel = useUIStore((s) => s.maximizedPanel);
  const setMaximizedPanel = useUIStore((s) => s.setMaximizedPanel);

  // Track the window width so a right-hand column can never be dragged wider
  // than the space that remains for the left columns. The browser column's
  // flex-basis is its own width while its sibling (the left column) has
  // flex-basis 0 — so without this clamp, dragging the browser past the window
  // width collapses the left column to zero and breaks the layout.
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // The left column must always keep room for the (fixed, non-shrinking) sidebar
  // plus the chat area's readable minimum. The file/detail column is allowed to
  // shrink away (flex-shrink + min-w-0), so it is not part of this floor. Use
  // the sidebar's *actual* width (not a hard-coded minimum) — otherwise a
  // 260–400px sidebar still lets the browser be dragged wide enough to squeeze
  // the chat below 200px and clip the sidebar, which is the "sidebar shrunk /
  // layout broken" symptom.
  const leftColumnMinWidth =
    (sidebarVisible ? (sidebarWidth || 260) : 0) + CHAT_MIN_WIDTH;
  const browserMaxWidth = Math.max(
    BROWSER_MIN_WIDTH,
    windowWidth - ICON_SIDEBAR_WIDTH - leftColumnMinWidth,
  );

  // If the window shrinks after the browser was dragged wide, clamp the state so
  // the next drag starts from the actually-rendered width (the CSS max-width
  // already clamps the visual; this keeps the state consistent with it).
  useEffect(() => {
    setBrowserWidth((w) => (w > browserMaxWidth ? browserMaxWidth : w));
  }, [browserMaxWidth]);

  // Fullscreen (maximize) state — mirrors agentstation-app: one column expands
  // to fill the window (minus the always-visible icon rail) and the rest hide.
  // Columns are: main (sidebar + chat), detail (file management), browser.
  const fsDetail = maximizedPanel === 'detail';
  const fsBrowser = maximizedPanel === 'browser';
  const fsNone = maximizedPanel === 'none';

  // The main column (sidebar + chat) has no dedicated fullscreen state: filling
  // it means collapsing the file + browser columns (the main column already
  // occupies everything they don't). So "maximize main" just closes those two.
  const showSidebar = fsNone && sidebarVisible;
  const showChat = fsNone;
  const showDetail = fsNone ? detailVisible : fsDetail;
  const showBrowser = fsNone ? browserPanelVisible : fsBrowser;

  return (
    <div className="h-screen flex bg-[var(--color-bg-primary)] overflow-hidden">
      <IconSidebar
        activeTab={iconActiveTab}
        onTabChange={(tab) => {
          // Switching views leaves fullscreen. While a panel is maximized its
          // restore button may be hidden (e.g. the chat), so a tab click is the
          // reliable way back to the normal layout.
          setMaximizedPanel('none');
          onIconTabChange(tab);
        }}
        onSettings={onIconSettings}
      />

      <div className="flex-1 flex flex-col min-w-0">
        {/* Main row: header+content (sidebar | chat | detail) on the left,
            full-height browser column on the right. */}
        <div className="flex flex-1 min-h-0">
          <div
            className={fsBrowser ? 'hidden' : 'flex-1 flex flex-col'}
            style={{ minWidth: leftColumnMinWidth }}
          >
      {/* Header bar — one header per column, mirroring the content row below:
          sidebar (app title) | chat (actions) | detail */}
      <header
        className="flex items-stretch h-10 flex-shrink-0
                   bg-[var(--color-bg-primary)] border-b border-[var(--color-separator)]
                   select-none z-[var(--z-sticky)]"
      >
        {/* Sidebar column header — app title. The sidebar (conversation list)
            belongs to the main column, so it carries no maximize button of its
            own — the main column's button lives in the chat header. */}
        <AnimatePresence initial={false}>
          {showSidebar && (
            <motion.div {...sidebarAnimation} className="overflow-hidden flex-shrink-0">
              <div
                style={{ width: sidebarWidth || 260, minWidth: 200, maxWidth: 400 }}
                className="h-full flex items-center px-4 titlebar-drag border-r border-[var(--color-separator)]"
              >
                <span className="text-[13px] font-semibold text-[var(--color-text-secondary)] tracking-tight">
                  Coderix
                </span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Chat column header — browser + sidebar toggles at this column's far right.
            Kept mounted (hidden via CSS) so the composer draft survives maximization. */}
        <div
          className={`${showChat ? 'flex flex-1' : 'hidden'} items-center justify-end px-4 titlebar-drag`}
          style={{ minWidth: CHAT_MIN_WIDTH }}
        >
          <div className="titlebar-no-drag flex items-center gap-1">
            {/* Sidebar toggle */}
            <button
              className="w-7 h-7 flex items-center justify-center rounded-[var(--radius-sm)]
                         text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]
                         hover:bg-[var(--color-bg-tertiary)] transition-colors"
              onClick={() => window.dispatchEvent(new CustomEvent('coderix:toggle-sidebar'))}
              title={t('nav.toggleSidebar')}
              aria-label={t('nav.toggleSidebar')}
            >
              <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.2">
                <rect x="1.5" y="2.5" width="12" height="10" rx="1.5" />
                <path d="M5.5 2.5v10" />
              </svg>
            </button>

            {/* File panel toggle — shown here only while the panel is collapsed,
                so it acts as a "reopen" affordance. Once expanded it moves above
                the file panel itself (see the detail column header). */}
            {!detailVisible && (
              <button
                className="w-7 h-7 flex items-center justify-center rounded-[var(--radius-sm)]
                           text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]
                           hover:bg-[var(--color-bg-tertiary)] transition-colors"
                onClick={onToggleDetailPanel}
                title={t('nav.toggleFilePanel')}
                aria-label={t('nav.toggleFilePanel')}
              >
                <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.2">
                  <rect x="1.5" y="2.5" width="12" height="10" rx="1.5" />
                  <path d="M9.5 2.5v10" />
                </svg>
              </button>
            )}

            {/* Browser sidebar toggle — hidden while the browser is open, because
                the Globe close button then lives in the browser column's own
                header (keeps it anchored to the column, mirroring agentstation-app). */}
            {!browserPanelVisible && (
              <button
                className="w-7 h-7 flex items-center justify-center rounded-[var(--radius-sm)]
                           text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]
                           hover:bg-[var(--color-bg-tertiary)] transition-colors"
                onClick={onToggleBrowserPanel}
                title={t('nav.browser')}
                aria-label={t('nav.browser')}
              >
                <Globe size={16} />
              </button>
            )}
            {/* Maximize the main column — collapses the file + browser columns so
                the main column fills the window (its "fullscreen"). Only useful
                while at least one of them is open. */}
            {(detailVisible || browserPanelVisible) && (
              <MaximizeButton
                active={false}
                onToggle={() => {
                  if (detailVisible) onToggleDetailPanel?.();
                  if (browserPanelVisible) onToggleBrowserPanel?.();
                }}
                label={t('nav.maximize')}
              />
            )}
          </div>
        </div>

        {/* Detail column header — hosts the file tabs (mirroring the browser's
            tab bar at the very top) plus a collapse button at its right edge. */}
        <AnimatePresence initial={false}>
          {showDetail && detailPanel && (
            <motion.div
              {...sidebarAnimation}
              className={fsDetail ? 'flex-1 overflow-hidden min-w-0' : 'overflow-hidden flex-shrink min-w-0'}
              style={fsDetail ? { minWidth: 0 } : { width: detailWidthState, maxWidth: DETAIL_MAX_WIDTH, minWidth: 0 }}
            >
              <div className="h-full flex items-stretch w-full">
                <div className="flex-1 min-w-0 overflow-hidden">
                  <EditorTabs />
                </div>
                <MaximizeButton
                  active={fsDetail}
                  onToggle={() => setMaximizedPanel(fsDetail ? 'none' : 'detail')}
                  label={t(fsDetail ? 'nav.restore' : 'nav.maximize')}
                />
                <button
                  onClick={onToggleDetailPanel}
                  title={t('nav.toggleFilePanel')}
                  aria-label={t('nav.toggleFilePanel')}
                  className="w-7 flex-shrink-0 flex items-center justify-center
                             text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]
                             hover:bg-[var(--color-bg-tertiary)] transition-colors"
                >
                  <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.2">
                    <rect x="1.5" y="2.5" width="12" height="10" rx="1.5" />
                    <path d="M9.5 2.5v10" />
                  </svg>
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </header>

      {/* Main content area */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* Sidebar — WeChat-style frosted glass with subtle right border */}
        <AnimatePresence initial={false}>
          {showSidebar && (
            <motion.div
              {...sidebarAnimation}
              className="overflow-hidden flex-shrink-0"
            >
              <div
                style={{
                  width: sidebarWidth || 260, minWidth: 200, maxWidth: 400,
                  resize: 'horizontal', overflow: 'auto',
                }}
                className="h-full glass-sidebar border-r border-[var(--color-separator)]"
              >
                {sidebar}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Main content — min-width floor so the browser column shrinks before
            the chat area is squeezed below its readable minimum. Kept mounted
            (hidden via CSS) so composer/terminal state survives maximization. */}
        <div
          className={`${showChat ? 'flex-1 flex flex-col' : 'hidden'} overflow-hidden bg-[var(--color-bg-primary)]`}
          style={{ minWidth: CHAT_MIN_WIDTH }}
        >
          {children}
        </div>

        {/* Detail panel — clean white/dark surface */}
        <AnimatePresence initial={false}>
          {showDetail && detailPanel && (
            <motion.div
              {...detailAnimation}
              className={fsDetail ? 'flex-1 overflow-hidden min-w-0' : 'overflow-hidden flex-shrink min-w-0'}
              style={fsDetail ? { minWidth: 0 } : { width: detailWidthState, maxWidth: DETAIL_MAX_WIDTH, minWidth: 0 }}
            >
              <DetailResizablePanel width={detailWidthState} onResize={setDetailWidthState}>
                {detailPanel}
              </DetailResizablePanel>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
          </div>{/* closes header+content column */}

          {/* Browser column — full height so its tab bar sits at the very top.
              The drag handle is a leading sibling (not drawn inside the panel),
              because the native WebContentsView renders above the DOM and would
              otherwise cover it. */}
          {showBrowser && browserPanel && (
            <BrowserResizableColumn
              width={fsBrowser ? Math.max(0, windowWidth - ICON_SIDEBAR_WIDTH) : browserWidth}
              onResize={setBrowserWidth}
              minWidth={BROWSER_MIN_WIDTH}
              maxWidth={fsBrowser ? Math.max(0, windowWidth - ICON_SIDEBAR_WIDTH) : browserMaxWidth}
              resizable={!fsBrowser}
            >
              {browserPanel}
            </BrowserResizableColumn>
          )}
        </div>{/* closes main row */}

      {/* Status bar */}
      <StatusBar {...statusBarProps} />
      </div>{/* closes flex-1 flex-col min-w-0 */}

      {/* Toast notifications — fixed overlay */}
      <Notifications />
    </div>
  );
}

AppLayout.displayName = 'AppLayout';

// ── Column resize ──────────────────────────────────────────────────────────

/**
 * Shared drag-to-resize logic for the right-hand columns. Returns a mousedown
 * handler that starts a drag on the panel's left edge: dragging left widens the
 * column, dragging right narrows it (clamped to [minWidth, maxWidth]).
 */
function useColumnResize(opts: {
  width: number;
  onResize: (w: number) => void;
  minWidth: number;
  maxWidth: number;
}): (e: React.MouseEvent) => void {
  const { width, onResize, minWidth, maxWidth } = opts;
  const dragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(0);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      startX.current = e.clientX;
      startW.current = width;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [width],
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = startX.current - e.clientX;
      onResize(Math.max(minWidth, Math.min(maxWidth, startW.current + delta)));
    };
    const onUp = () => {
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [onResize, minWidth, maxWidth]);

  return onMouseDown;
}

/**
 * Maximize/restore toggle — the per-column "fullscreen" button, mirroring
 * agentstation-app. Shows a Maximize2 icon normally and a brand-tinted
 * Minimize2 icon when the column is expanded.
 */
function MaximizeButton({
  active,
  onToggle,
  label,
}: {
  active: boolean;
  onToggle: () => void;
  label: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={label}
      aria-label={label}
      className={`w-7 h-7 flex items-center justify-center rounded-[var(--radius-sm)] transition-colors ${
        active
          ? 'text-[var(--color-brand)] hover:bg-[var(--color-bg-tertiary)]'
          : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)]'
      }`}
    >
      {active ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
    </button>
  );
}

/**
 * Browser column — a full-height panel with a 4px drag handle on its left edge.
 * The handle is rendered as a leading sibling of the panel (not inside it) so it
 * stays grabbable: the embedded WebContentsView is a native layer that paints
 * over the DOM and would hide a handle drawn within the panel's bounds.
 */
function BrowserResizableColumn({
  children,
  width,
  onResize,
  minWidth,
  maxWidth,
  resizable = true,
}: {
  children: ReactNode;
  width: number;
  onResize: (w: number) => void;
  minWidth: number;
  maxWidth: number;
  resizable?: boolean;
}): React.ReactElement {
  const onMouseDown = useColumnResize({ width, onResize, minWidth, maxWidth });
  return (
    // No `flex-shrink-0`: when the window shrinks this column yields width to
    // the chat area (whose 200px floor is enforced in the main-content div),
    // collapsing down to `minWidth` before the chat gets squeezed.
    <div className="h-full flex">
      {resizable && (
        // Drag handle — 4px grab zone with a solid 1px divider line through its
        // center, so the browser/chat boundary stays visible (not just on hover).
        <div
          onMouseDown={onMouseDown}
          style={{ width: 4, cursor: 'col-resize', flexShrink: 0 }}
          className="relative group hover:bg-[var(--color-brand)]/40 active:bg-[var(--color-brand)]/60 transition-colors"
        >
          <div className="absolute left-1/2 top-0 bottom-0 w-px -translate-x-1/2 bg-[var(--color-separator)] group-hover:bg-[var(--color-brand)] transition-colors" />
        </div>
      )}
      <div
        style={{ width, minWidth, maxWidth, flexShrink: 1 }}
        className="h-full bg-[var(--color-bg-secondary)]"
      >
        {children}
      </div>
    </div>
  );
}

// ── Simple resizable panel with visible drag handle ──

function DetailResizablePanel({ children, width, onResize }: {
  children: ReactNode; width?: number; onResize?: (w: number) => void;
}) {
  const dragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(0);
  const w = width || 380;

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    startX.current = e.clientX;
    startW.current = w;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [w]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = startX.current - e.clientX;
      const newW = Math.max(280, Math.min(DETAIL_MAX_WIDTH, startW.current + delta));
      onResize?.(newW);
    };
    const onUp = () => {
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [onResize]);

  return (
    <div style={{ position: 'relative', width: '100%', minWidth: 0 }} className="h-full bg-[var(--color-bg-secondary)] border-l border-[var(--color-separator)]">
      {/* Drag handle — left edge */}
      <div
        onMouseDown={onMouseDown}
        style={{
          position: 'absolute', left: 0, top: 0, bottom: 0, width: '4px',
          cursor: 'col-resize', zIndex: 10,
        }}
        className="hover:bg-[var(--color-brand)]/40 active:bg-[var(--color-brand)]/60 transition-colors"
      />
      {children}
    </div>
  );
}
