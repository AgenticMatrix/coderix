import React, { useEffect, useRef, useState } from 'react';
import { Plus, X, ArrowLeft, ArrowRight, RotateCw, Home, Globe, Maximize2, Minimize2 } from 'lucide-react';
import { useBrowserStore, HOME_URL } from '../../store/browserStore.js';
import { useT } from '../../i18n/index.js';
import { useUIStore } from '../../store/uiStore';

/**
 * BrowserPanel — an embedded Chromium browser (WebContentsView) shown as a
 * right-hand sidebar. The page itself is a native view layered over the
 * viewport; this component only draws the tab bar, address bar and the
 * measured container the native view is positioned into (mirrors
 * agentstation-app's BrowserPanel).
 */

function browserAPI(): Window['coderixAPI']['browser'] | undefined {
  return window.coderixAPI?.browser;
}

// Fit-to-width: zoom the page so a desktop-width layout fits the panel width
// exactly, keeping the whole page visible and centered (no horizontal scroll).
const BASE_WIDTH = 1280;
// Minimum zoom the fit-to-width is allowed to reach. Below this the text is
// too small to read, so instead of shrinking further the page stops zooming
// out and overflows horizontally — the user scrolls the page sideways (wheel /
// scrollbar) rather than squinting at tiny text.
const MIN_SCALE = 0.5;

function applyFitScale(tabId: string, width: number) {
  if (width <= 0) return;
  // Never zoom *in* past 100%: a panel wider than the base width must not
  // magnify the page (which reads as "the page/enlarged font changed when I
  // dragged the boundary"). And never zoom *out* below MIN_SCALE: past that
  // point the page keeps its readable size and scrolls horizontally instead.
  const scale = Math.min(1, Math.max(MIN_SCALE, width / BASE_WIDTH));
  browserAPI()?.setZoomFactor(tabId, scale).catch(() => {});
}

// ── Tab Bar ────────────────────────────────────────────────────────────────

const TabBar: React.FC = () => {
  const { tabs, activeTabId, openTab, closeTab, setActiveTab } = useBrowserStore();
  const t = useT();

  const handleClose = (e: React.MouseEvent, tabId: string) => {
    e.stopPropagation();
    browserAPI()?.destroy(tabId).catch(() => {});
    closeTab(tabId);
  };

  return (
    <div className="flex-1 flex items-center gap-0.5 overflow-x-auto min-w-0">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          onClick={() => setActiveTab(tab.id)}
          className={`flex items-center gap-1 px-3 py-1 rounded-t-md cursor-pointer text-xs max-w-[160px] min-w-[80px] select-none group shrink-0 ${
            tab.id === activeTabId
              ? 'bg-[var(--color-bg-primary)] text-[var(--color-text-primary)]'
              : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]'
          }`}
        >
          <span className="truncate flex-1">{tab.title || tab.url || t('browser.newTab')}</span>
          <button
            onClick={(e) => handleClose(e, tab.id)}
            className="opacity-0 group-hover:opacity-100 hover:bg-[var(--color-bg-tertiary)] rounded-full p-0.5 shrink-0"
            title={t('browser.closeTab')}
          >
            <X size={12} />
          </button>
        </div>
      ))}
      <button
        onClick={() => openTab(HOME_URL)}
        className="p-1 hover:bg-[var(--color-bg-tertiary)] rounded-md text-[var(--color-text-secondary)] shrink-0"
        title={t('browser.newTab')}
      >
        <Plus size={16} />
      </button>
    </div>
  );
};

// ── Address Bar ─────────────────────────────────────────────────────────────

interface AddressBarProps {
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
  onNavigate: (url: string) => void;
  onGoBack: () => void;
  onGoForward: () => void;
  onReload: () => void;
  onHome: () => void;
}

const AddressBar: React.FC<AddressBarProps> = ({
  url,
  canGoBack,
  canGoForward,
  onNavigate,
  onGoBack,
  onGoForward,
  onReload,
  onHome,
}) => {
  const [inputValue, setInputValue] = useState(url);
  const t = useT();

  useEffect(() => {
    setInputValue(url);
  }, [url]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    let target = inputValue.trim();
    if (!target) return;
    if (!target.includes('.') && !target.startsWith('localhost') && !target.startsWith('http')) {
      target = `https://www.baidu.com/s?wd=${encodeURIComponent(target)}`;
    } else if (!target.startsWith('http://') && !target.startsWith('https://')) {
      target = `https://${target}`;
    }
    onNavigate(target);
  };

  const btnCls =
    'p-1 rounded-md hover:bg-[var(--color-bg-tertiary)] disabled:opacity-30 text-[var(--color-text-secondary)] disabled:cursor-not-allowed';

  return (
    <div className="flex items-center gap-1 px-2 py-1.5 bg-[var(--color-bg-primary)] border-b border-[var(--color-separator)]">
      <button onClick={onGoBack} disabled={!canGoBack} className={btnCls} title={t('browser.back')}>
        <ArrowLeft size={16} />
      </button>
      <button onClick={onGoForward} disabled={!canGoForward} className={btnCls} title={t('browser.forward')}>
        <ArrowRight size={16} />
      </button>
      <button onClick={onReload} className={btnCls} title={t('browser.reload')}>
        <RotateCw size={14} />
      </button>
      <button onClick={onHome} className={btnCls} title={t('browser.home')}>
        <Home size={14} />
      </button>
      <form onSubmit={handleSubmit} className="flex-1">
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          className="w-full px-3 py-1 text-xs rounded-full bg-[var(--color-bg-secondary)] text-[var(--color-text-primary)] outline-none focus:ring-1 focus:ring-[var(--color-brand)] border border-[var(--color-separator)]"
          placeholder={t('browser.searchPlaceholder')}
          spellCheck={false}
        />
      </form>
    </div>
  );
};

// ── Native View Wrapper ─────────────────────────────────────────────────────

const BrowserViewWrapper: React.FC<{ tabId: string; url: string; active: boolean }> = ({
  tabId,
  url: initialUrl,
  active,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);

  // Create + show / hide — sequenced to avoid an IPC race.
  useEffect(() => {
    const a = browserAPI();
    if (!a) return;
    let cancelled = false;

    (async () => {
      try {
        await a.create(tabId, initialUrl);
      } catch (err) {
        console.warn('[BrowserPanel] create failed:', err);
      }
      if (cancelled) return;

      if (active) {
        const container = containerRef.current;
        if (container) {
          const r = container.getBoundingClientRect();
          await a.show(tabId, {
            x: Math.round(r.x),
            y: Math.round(r.y),
            width: Math.round(r.width),
            height: Math.round(r.height),
          });
          applyFitScale(tabId, r.width);
        }
      } else {
        await a.hide(tabId);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [tabId, active]);

  // Keep the native view glued to the container while it is active.
  useEffect(() => {
    if (!active) return;
    const a = browserAPI();
    const container = containerRef.current;
    if (!a || !container) return;

    const updateBounds = () => {
      const r = container.getBoundingClientRect();
      a.setBounds(tabId, {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      });
      applyFitScale(tabId, r.width);
    };
    updateBounds();

    const ro = new ResizeObserver(updateBounds);
    ro.observe(container);
    window.addEventListener('resize', updateBounds);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', updateBounds);
    };
  }, [tabId, active]);

  // Hide the native view when the panel/tab unmounts (don't destroy — tabs persist).
  useEffect(() => {
    return () => {
      browserAPI()?.hide(tabId).catch(() => {});
    };
  }, [tabId]);

  // Re-apply fit scale after navigation (zoom may reset per-origin).
  useEffect(() => {
    if (!active) return;
    const a = browserAPI();
    if (!a) return;
    const cleanup = a.onEvent((ev) => {
      if (ev.tabId !== tabId) return;
      if (ev.type !== 'did-navigate') return;
      const container = containerRef.current;
      if (container) applyFitScale(tabId, container.getBoundingClientRect().width);
    });
    return cleanup;
  }, [tabId, active]);

  return (
    <div
      ref={containerRef}
      className="bg-white"
      style={{
        display: active ? 'block' : 'none',
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
      }}
    />
  );
};

// ── Empty state (no tabs) ───────────────────────────────────────────────────

const EmptyState: React.FC = () => {
  const t = useT();
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-2 text-[var(--color-text-tertiary)]">
      <Globe size={32} strokeWidth={1.5} />
      <span className="text-sm">{t('browser.emptyHint')}</span>
    </div>
  );
};

// ── BrowserPanel ────────────────────────────────────────────────────────────

export function BrowserPanel({ onClose }: { onClose?: () => void }): React.ReactElement {
  const { tabs, activeTabId, openTab, updateTab } = useBrowserStore();
  const didInit = useRef(false);
  const t = useT();

  // Fullscreen (maximize) toggle — mirrors agentstation-app's browser panel.
  const maximizedPanel = useUIStore((s) => s.maximizedPanel);
  const setMaximizedPanel = useUIStore((s) => s.setMaximizedPanel);
  const isMaximized = maximizedPanel === 'browser';
  const toggleMaximize = () => setMaximizedPanel(isMaximized ? 'none' : 'browser');

  // Open an initial tab on first mount.
  useEffect(() => {
    if (!didInit.current && tabs.length === 0) {
      didInit.current = true;
      openTab(HOME_URL);
    }
  }, [tabs.length, openTab]);

  // Reflect main-process navigation events in the tab metadata.
  useEffect(() => {
    const a = browserAPI();
    if (!a) return;
    const cleanup = a.onEvent((ev) => {
      switch (ev.type) {
        case 'did-start-loading':
          updateTab(ev.tabId, { isLoading: true, loadError: undefined });
          break;
        case 'did-stop-loading':
          updateTab(ev.tabId, { isLoading: false });
          break;
        case 'did-navigate':
        case 'did-navigate-in-page':
          updateTab(ev.tabId, {
            url: ev.url || '',
            canGoBack: ev.canGoBack ?? false,
            canGoForward: ev.canGoForward ?? false,
            loadError: undefined,
          });
          break;
        case 'page-title-updated':
          if (ev.title) updateTab(ev.tabId, { title: ev.title });
          break;
        case 'did-fail-load':
          updateTab(ev.tabId, { isLoading: false, loadError: ev.errorDescription || 'Load failed' });
          break;
      }
    });
    return cleanup;
  }, [updateTab]);

  // target=_blank / window.open → new tab.
  useEffect(() => {
    const a = browserAPI();
    if (!a) return;
    return a.onOpenNewTab((url) => {
      if (url) openTab(url);
    });
  }, [openTab]);

  const activeTab = tabs.find((tab) => tab.id === activeTabId);

  return (
    <div className="h-full flex flex-col bg-[var(--color-bg-secondary)]">
      {/* Tab bar row — the browser's Globe close button lives here so the column
          is self-identified: it stays anchored in the browser column (not the chat
          header) after the panel is opened, mirroring agentstation-app. */}
      <div className="flex items-center gap-2 px-2 shrink-0 border-b border-[var(--color-separator)] h-10 bg-[var(--color-bg-secondary)]">
        <TabBar />
        <button
          onClick={toggleMaximize}
          className={`shrink-0 w-7 h-7 flex items-center justify-center rounded-[var(--radius-sm)] transition-colors ${isMaximized ? 'text-[var(--color-brand)]' : 'text-[var(--color-text-tertiary)] hover:bg-[var(--color-bg-tertiary)]'}`}
          title={t(isMaximized ? 'nav.restore' : 'nav.maximize')}
          aria-label={t(isMaximized ? 'nav.restore' : 'nav.maximize')}
        >
          {isMaximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
        <button
          onClick={() => { setMaximizedPanel('none'); onClose?.(); }}
          className="shrink-0 w-7 h-7 flex items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-brand)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
          title={t('nav.browser')}
          aria-label={t('nav.browser')}
        >
          <Globe size={15} strokeWidth={1.75} />
        </button>
      </div>

      {activeTab && (
        <AddressBar
          url={activeTab.url}
          canGoBack={activeTab.canGoBack}
          canGoForward={activeTab.canGoForward}
          onNavigate={(url) => {
            updateTab(activeTab.id, { url });
            browserAPI()?.navigate(activeTab.id, url).catch(() => {});
          }}
          onGoBack={() => browserAPI()?.goBack(activeTab.id).catch(() => {})}
          onGoForward={() => browserAPI()?.goForward(activeTab.id).catch(() => {})}
          onReload={() => browserAPI()?.reload(activeTab.id).catch(() => {})}
          onHome={() => {
            updateTab(activeTab.id, { url: HOME_URL });
            browserAPI()?.navigate(activeTab.id, HOME_URL).catch(() => {});
          }}
        />
      )}

      {/* Native view container */}
      <div className="flex-1 relative overflow-hidden bg-white">
        {tabs.length === 0 ? (
          <EmptyState />
        ) : (
          tabs.map((tab) => (
            <BrowserViewWrapper
              key={tab.id}
              tabId={tab.id}
              url={tab.url}
              active={tab.id === activeTabId}
            />
          ))
        )}
      </div>

      {/* Load-failure banner — sits above the native view's bounds. */}
      {activeTab?.loadError && (
        <div className="shrink-0 px-3 py-1.5 text-xs text-red-600 bg-red-50 border-t border-[var(--color-separator)]">
          {activeTab.loadError}
        </div>
      )}
    </div>
  );
}

BrowserPanel.displayName = 'BrowserPanel';
