import React, { useEffect, useRef, useState } from 'react';
import { X, FileBox, Loader2, RefreshCw } from 'lucide-react';
import { useT } from '../../i18n/index.js';
import type { AppDefinition } from './registry';

/**
 * AppDisplayPanel — the right-hand "app display page" for an attached app.
 *
 * For the `cad-viewer` kind: spawns the self-contained 3D viewer (port 3245),
 * embeds it as a native WebContentsView over a measured container, and lists
 * the CAD artifacts in the conversation workspace below it — clicking one
 * navigates the viewer to that file. The conversation (left) drives generation;
 * this panel only displays the result.
 */

const TAB_ID = 'app-display';

interface CadFile {
  name: string;
  relativePath: string;
}

type ViewerStatus = 'stopped' | 'starting' | 'running' | 'error';

function cadViewerAPI(): Window['coderixAPI']['cadViewer'] | undefined {
  return window.coderixAPI?.cadViewer;
}
function browserAPI(): Window['coderixAPI']['browser'] | undefined {
  return window.coderixAPI?.browser;
}
function fsAPI(): Window['coderixAPI']['fs'] | undefined {
  return window.coderixAPI?.fs;
}

function buildViewerUrl(baseUrl: string, workspaceDir: string, fileRel: string): string {
  const abs = workspaceDir.replace(/\\/g, '/');
  const pathPart = abs.startsWith('/') ? abs : `/${abs}`;
  const base = `${baseUrl}${pathPart}`;
  return fileRel ? `${base}?file=${encodeURIComponent(fileRel)}` : base;
}

export function AppDisplayPanel({
  app,
  workspaceDir,
  onClose,
}: {
  app: AppDefinition;
  workspaceDir: string;
  onClose: () => void;
}): React.ReactElement {
  const t = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<ViewerStatus>('stopped');
  const [baseUrl, setBaseUrl] = useState('');
  const [error, setError] = useState('');
  const [files, setFiles] = useState<CadFile[]>([]);
  const [selected, setSelected] = useState('');
  const [created, setCreated] = useState(false);

  // ── Spawn the cad-viewer + subscribe to its lifecycle ──────────────────
  useEffect(() => {
    const c = cadViewerAPI();
    if (!c) return;
    let cancelled = false;
    const apply = (info: { status: string; baseUrl?: string; error?: string }): void => {
      if (cancelled) return;
      setStatus(info.status as ViewerStatus);
      if (info.baseUrl) setBaseUrl(info.baseUrl);
      setError(info.status === 'error' ? (info.error ?? '') : '');
    };
    c.status()
      .then((info) => {
        apply(info);
        if (info.status !== 'running') c.start().then(apply).catch(() => apply({ status: 'error' }));
      })
      .catch(() => apply({ status: 'error' }));
    const unsubscribe = c.onStatusChanged(apply);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // ── Poll the workspace for CAD artifacts (scan-on-demand, like cad_harness) ──
  useEffect(() => {
    if (!workspaceDir) return;
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      const fs = fsAPI();
      if (!fs) return;
      try {
        const res = await fs.listCadFiles(workspaceDir);
        if (!cancelled) setFiles(res.files ?? []);
      } catch {
        // ignore transient listing errors
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [workspaceDir]);

  const url =
    status === 'running' && baseUrl && workspaceDir
      ? buildViewerUrl(baseUrl, workspaceDir, selected)
      : '';

  // ── Create + show the native view, glued to the container ──────────────
  useEffect(() => {
    if (!url) return;
    const a = browserAPI();
    const container = containerRef.current;
    if (!a || !container) return;
    let cancelled = false;

    const urlAtCreate = url;
    (async () => {
      try {
        await a.create(TAB_ID, urlAtCreate);
      } catch (err) {
        console.warn('[AppDisplay] create failed:', err);
      }
      if (cancelled) return;
      setCreated(true);
      const r = container.getBoundingClientRect();
      await a.show(TAB_ID, {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      });
    })();

    const updateBounds = (): void => {
      const r = container.getBoundingClientRect();
      a.setBounds(TAB_ID, {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      });
    };
    const ro = new ResizeObserver(updateBounds);
    ro.observe(container);
    window.addEventListener('resize', updateBounds);

    return () => {
      cancelled = true;
      ro.disconnect();
      window.removeEventListener('resize', updateBounds);
      a.hide(TAB_ID).catch(() => {});
    };
  }, [status, baseUrl, workspaceDir]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Navigate the already-created view when the selected file changes ───
  useEffect(() => {
    if (!created || !url) return;
    browserAPI()?.navigate(TAB_ID, url).catch(() => {});
  }, [created, url]);

  const handleSelect = (file: CadFile): void => {
    setSelected(file.relativePath);
  };

  return (
    <div className="h-full flex flex-col bg-[var(--color-bg-secondary)]">
      {/* Header */}
      <div className="flex items-center gap-2 h-10 px-3 shrink-0 border-b border-[var(--color-separator)] bg-[var(--color-bg-primary)]">
        <span className="flex-1 text-sm font-medium text-[var(--color-text-primary)] truncate">{app.name}</span>
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

      {/* Viewer area (native WebContentsView) */}
      <div className="flex-1 relative overflow-hidden bg-white min-h-0">
        <div ref={containerRef} className="absolute inset-0 bg-white" />
        {status !== 'running' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center bg-[var(--color-bg-secondary)]">
            {status === 'error' ? (
              <>
                <RefreshCw size={26} className="text-[var(--color-text-tertiary)]" />
                <div className="text-sm font-medium text-[var(--color-text-primary)]">{t('apps.viewerFailed')}</div>
                {error && <div className="text-xs text-[var(--color-text-tertiary)] max-w-sm break-all">{error}</div>}
              </>
            ) : (
              <>
                <Loader2 size={26} className="animate-spin text-[var(--color-brand)]" />
                <div className="text-sm text-[var(--color-text-secondary)]">{t('apps.viewerStarting')}</div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Artifact list */}
      <div className="shrink-0 border-t border-[var(--color-separator)] flex flex-col max-h-[180px]">
        <div className="px-3 py-1.5 text-[11px] font-medium text-[var(--color-text-tertiary)] uppercase tracking-wide">
          {t('apps.artifacts')}
        </div>
        <div className="overflow-y-auto px-1 pb-1">
          {files.length === 0 ? (
            <div className="px-2 py-3 text-xs text-[var(--color-text-tertiary)]">{t('apps.noArtifacts')}</div>
          ) : (
            files.map((file) => (
              <button
                key={file.relativePath}
                type="button"
                onClick={() => handleSelect(file)}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-sm)] text-left text-xs transition-colors ${
                  file.relativePath === selected
                    ? 'bg-[var(--color-brand-muted)] text-[var(--color-brand)]'
                    : 'text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)]'
                }`}
              >
                <FileBox size={13} className="shrink-0" />
                <span className="truncate" title={file.relativePath}>{file.name}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

AppDisplayPanel.displayName = 'AppDisplayPanel';
