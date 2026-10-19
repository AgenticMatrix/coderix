import React, { useCallback, useEffect, useRef, useState } from 'react';
import { X, Loader2, RefreshCw } from 'lucide-react';
import { useT } from '../../i18n/index.js';
import type { AppDefinition } from './registry';

/**
 * OfficeHarnessPanel — right-hand display for the `office-viewer` app kind.
 *
 * The OfficeHarness plugin ships a browser-hosted LibreOffice/Impress editor.
 * `window.coderixAPI.officeHarness` starts (or reuses) the plugin's managed host
 * and returns the workspace URL; the page is then embedded with the same native
 * WebContentsView mechanism the browser/CAD panels use. The host enforces
 * COOP/COEP, so the WASM editor stays cross-origin isolated.
 */

const TAB_ID = 'app-display-officeharness';

type ViewerStatus = 'stopped' | 'starting' | 'running' | 'error';

interface OfficeHarnessInfo {
  status: string;
  url: string;
  port: number;
  root: string;
  error?: string;
}

export function OfficeHarnessPanel({
  app,
  onClose,
}: {
  app: AppDefinition;
  onClose: () => void;
}): React.ReactElement {
  const t = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<ViewerStatus>('stopped');
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');

  const apply = useCallback((info: OfficeHarnessInfo): void => {
    setStatus(info.status as ViewerStatus);
    if (info.url) setUrl(info.url);
    setError(info.status === 'error' ? info.error ?? '' : '');
  }, []);

  const connect = useCallback(async (): Promise<void> => {
    const api = window.coderixAPI?.officeHarness;
    if (!api) {
      setStatus('error');
      setError('OfficeHarness API unavailable');
      return;
    }
    try {
      const current = await api.status();
      if (current.status === 'running' && current.url) {
        apply(current);
        return;
      }
      apply(await api.start());
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [apply]);

  // Start or reuse the host, then follow its lifecycle.
  useEffect(() => {
    const api = window.coderixAPI?.officeHarness;
    if (!api) {
      setStatus('error');
      setError('OfficeHarness API unavailable');
      return;
    }
    let cancelled = false;
    const unsubscribe = api.onStatusChanged((info) => {
      if (!cancelled) apply(info);
    });
    void connect();
    return () => {
      cancelled = true;
      unsubscribe();
      window.coderixAPI?.browser?.hide(TAB_ID).catch(() => {});
    };
  }, [apply, connect]);

  // The host is a detached process; poll it while the panel is open so a crash
  // surfaces the retry affordance instead of leaving a dead native view.
  useEffect(() => {
    if (status !== 'running') return;
    const timer = setInterval(() => {
      window.coderixAPI?.officeHarness
        ?.status()
        .then((info) => {
          if (info.status !== 'running') apply(info);
        })
        .catch(() => {
          setStatus('error');
          setError('OfficeHarness host unavailable');
        });
    }, 5000);
    return () => clearInterval(timer);
  }, [status, apply]);

  // Mount the native view over the measured container and keep it sized.
  useEffect(() => {
    if (status !== 'running' || !url) return;
    const browser = window.coderixAPI?.browser;
    const container = containerRef.current;
    if (!browser || !container) return;

    let cancelled = false;
    const bounds = (): { x: number; y: number; width: number; height: number } => {
      const r = container.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
    };

    void (async () => {
      try {
        await browser.create(TAB_ID, url);
        if (cancelled) return;
        // `create` is a no-op when the view already exists (e.g. the panel was
        // closed and reopened); only navigate when the host origin changed.
        const info = await browser.getPageInfo(TAB_ID).catch(() => null);
        let sameOrigin = false;
        try {
          sameOrigin = info?.url ? new URL(info.url).origin === url : false;
        } catch {
          sameOrigin = false;
        }
        if (!sameOrigin) await browser.navigate(TAB_ID, url);
        if (!cancelled) await browser.show(TAB_ID, bounds());
      } catch (err) {
        if (!cancelled) {
          setStatus('error');
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();

    const updateBounds = (): void => {
      void browser.setBounds(TAB_ID, bounds());
    };
    const ro = new ResizeObserver(updateBounds);
    ro.observe(container);
    window.addEventListener('resize', updateBounds);
    return () => {
      cancelled = true;
      ro.disconnect();
      window.removeEventListener('resize', updateBounds);
      void browser.hide(TAB_ID).catch(() => {});
    };
  }, [status, url]);

  return (
    <div className="h-full flex flex-col bg-[var(--color-bg-secondary)]">
      <div className="flex items-center gap-2 h-10 px-3 shrink-0 border-b border-[var(--color-separator)] bg-[var(--color-bg-primary)]">
        <span className="flex-1 text-sm font-medium text-[var(--color-text-primary)] truncate">{app.name}</span>
        {status !== 'running' && (
          <button
            type="button"
            onClick={() => void connect()}
            className="w-7 h-7 flex items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-tertiary)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
            title="重新连接"
            aria-label="重新连接"
          >
            <RefreshCw size={14} />
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="w-7 h-7 flex items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-tertiary)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
          title={t('apps.back')}
          aria-label={t('apps.back')}
        >
          <X size={15} />
        </button>
      </div>

      <div className="flex-1 relative overflow-hidden bg-white min-h-0">
        <div ref={containerRef} className="absolute inset-0 bg-white" />
        {status !== 'running' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center bg-[var(--color-bg-secondary)]">
            {status === 'error' ? (
              <>
                <RefreshCw size={26} className="text-[var(--color-text-tertiary)]" />
                <div className="text-sm font-medium text-[var(--color-text-primary)]">{t('apps.officeFailed')}</div>
                {error && <div className="text-xs text-[var(--color-text-tertiary)] max-w-sm break-all">{error}</div>}
              </>
            ) : (
              <>
                <Loader2 size={26} className="animate-spin text-[var(--color-brand)]" />
                <div className="text-sm text-[var(--color-text-secondary)]">{t('apps.officeStarting')}</div>
              </>
            )}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-[var(--color-separator)] px-3 py-2 bg-[var(--color-bg-primary)] text-[11px] leading-5 text-[var(--color-text-tertiary)]">
        在画布中直接编辑；左侧对话可通过 OfficeHarness 工具修改同一份文稿。保存前请确认本地文件绑定。
      </div>
    </div>
  );
}

OfficeHarnessPanel.displayName = 'OfficeHarnessPanel';
