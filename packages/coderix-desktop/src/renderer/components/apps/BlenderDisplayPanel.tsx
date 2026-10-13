import React, { useEffect, useRef, useState } from 'react';
import { X, Box } from 'lucide-react';
import { useT } from '../../i18n/index.js';
import type { AppDefinition } from './registry';

/**
 * BlenderDisplayPanel — the right-hand "app display page" for the blender-harness
 * app. Two views of the model:
 *   - 「实时视口」: a live MJPEG feed of Blender's render (`<img src=…>`), giving a
 *     "watching Blender work" feel — the closest web way to putting Blender itself
 *     in the panel (its native GUI can't be embedded in Electron).
 *   - 「3D 模型」: an interactive three.js `.glb` viewer embedded as a native
 *     WebContentsView (the Blender analogue of cad_harness's `.step`/`.glb` viewer).
 * Blender is auto-launched on open and runs as a separate native window.
 */

const TAB_ID = 'blender-viewer';

/** Poll interval for the workspace .glb scan (ms). */
const POLL_INTERVAL_MS = 10_000;

interface BlenderModel {
  name: string;
  path: string;
  mtime: number;
}

function blenderAPI(): Window['coderixAPI']['blender'] | undefined {
  return window.coderixAPI?.blender;
}
function blenderViewerAPI(): Window['coderixAPI']['blenderViewer'] | undefined {
  return window.coderixAPI?.blenderViewer;
}
function blenderStreamAPI(): Window['coderixAPI']['blenderStream'] | undefined {
  return window.coderixAPI?.blenderStream;
}
function browserAPI(): Window['coderixAPI']['browser'] | undefined {
  return window.coderixAPI?.browser;
}

export function BlenderDisplayPanel({
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
  const lastUrlRef = useRef('');
  const [viewMode, setViewMode] = useState<'stream' | 'model'>('stream');
  const [streamUrl, setStreamUrl] = useState('');
  const [models, setModels] = useState<BlenderModel[]>([]);
  const [selectedPath, setSelectedPath] = useState('');
  const [viewerUrl, setViewerUrl] = useState('');
  const [connected, setConnected] = useState(false);

  // ── Auto-launch Blender + poll connection status (cheap ping) ─────────
  useEffect(() => {
    const b = blenderAPI();
    if (!b) return;
    let cancelled = false;
    void b.launch().catch(() => {});
    const refresh = async (): Promise<void> => {
      try {
        const res = await b.status();
        if (!cancelled) setConnected(res.connected);
      } catch {
        if (!cancelled) setConnected(false);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  // ── Resolve the MJPEG stream URL ──────────────────────────────────────
  useEffect(() => {
    const s = blenderStreamAPI();
    if (!s) return;
    let cancelled = false;
    s.url()
      .then((r) => {
        if (!cancelled) setStreamUrl(r.url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Scan the workspace for exported .glb files (poll so new exports appear) ──
  useEffect(() => {
    if (!workspaceDir) return;
    const bv = blenderViewerAPI();
    if (!bv) return;
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      try {
        const list = await bv.listModels(workspaceDir);
        if (!cancelled) setModels(list ?? []);
      } catch {
        // Scan failed — leave the existing list.
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [workspaceDir]);

  // ── Auto-select the newest model ──────────────────────────────────────
  useEffect(() => {
    if (selectedPath || models.length === 0) return;
    setSelectedPath(models[0].path);
  }, [models, selectedPath]);

  // ── Resolve the selected model to a viewer URL ────────────────────────
  useEffect(() => {
    if (!selectedPath) {
      setViewerUrl('');
      return;
    }
    const bv = blenderViewerAPI();
    if (!bv) return;
    let cancelled = false;
    bv
      .viewerUrl(selectedPath)
      .then((r) => {
        if (!cancelled) setViewerUrl(r.url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selectedPath]);

  // ── Create + show the native .glb view, glued to the container ────────
  useEffect(() => {
    if (viewMode !== 'model' || !viewerUrl) return;
    const a = browserAPI();
    const container = containerRef.current;
    if (!a || !container) return;
    let cancelled = false;

    const urlAtCreate = viewerUrl;
    (async () => {
      try {
        await a.create(TAB_ID, urlAtCreate);
      } catch (err) {
        console.warn('[BlenderDisplay] create failed:', err);
      }
      if (cancelled) return;
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
  }, [viewMode, viewerUrl]);

  // ── Navigate the already-created view when the selected model changes ──
  useEffect(() => {
    if (viewMode !== 'model' || !viewerUrl || viewerUrl === lastUrlRef.current) return;
    lastUrlRef.current = viewerUrl;
    browserAPI()?.navigate(TAB_ID, viewerUrl).catch(() => {});
  }, [viewMode, viewerUrl]);

  return (
    <div className="h-full flex flex-col bg-[var(--color-bg-secondary)]">
      {/* Header */}
      <div className="flex items-center gap-2 h-10 px-3 shrink-0 border-b border-[var(--color-separator)] bg-[var(--color-bg-primary)]">
        <span className="flex-1 text-sm font-medium text-[var(--color-text-primary)] truncate">{app.name}</span>
        <span
          className={`w-2 h-2 rounded-full ${connected ? 'bg-[var(--color-success,#22c55e)]' : 'bg-[var(--color-text-tertiary)]'}`}
          title={connected ? 'Blender connected' : t('apps.blender.disconnected')}
        />
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

      {/* View toggle */}
      <div className="flex items-center gap-1 h-8 px-3 shrink-0 border-b border-[var(--color-separator)] bg-[var(--color-bg-primary)]">
        {(['stream', 'model'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => setViewMode(mode)}
            className={`px-3 py-0.5 rounded-[var(--radius-sm)] text-xs font-medium transition-colors ${
              viewMode === mode
                ? 'bg-[var(--color-brand)] text-white'
                : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]'
            }`}
          >
            {mode === 'stream' ? t('apps.blender.stream') : t('apps.blender.model3d')}
          </button>
        ))}
      </div>

      {/* Main area */}
      <div className="flex-1 relative overflow-hidden bg-[#18181c] min-h-0">
        {viewMode === 'stream' ? (
          <>
            {streamUrl && <img src={streamUrl} alt="Blender live viewport" className="w-full h-full object-contain" />}
            {!connected && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center bg-[#18181c]/70">
                <Box size={26} className="text-[var(--color-text-tertiary)]" />
                <div className="text-sm text-[var(--color-text-secondary)]">{t('apps.blender.disconnected')}</div>
                <div className="text-xs text-[var(--color-text-tertiary)] max-w-sm">{t('apps.blender.hint')}</div>
              </div>
            )}
          </>
        ) : (
          <>
            <div ref={containerRef} className="absolute inset-0" />
            {!viewerUrl && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
                <Box size={26} className="text-[var(--color-text-tertiary)]" />
                <div className="text-sm text-[var(--color-text-secondary)] max-w-sm">{t('apps.blender.noModel')}</div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Bottom bar — model selector (model mode only) */}
      {viewMode === 'model' && (
        <div className="shrink-0 border-t border-[var(--color-separator)] flex items-center gap-2 px-3 py-2 bg-[var(--color-bg-primary)]">
          <span className="shrink-0 text-[11px] font-medium text-[var(--color-text-tertiary)]">{t('apps.blender.model')}</span>
          <select
            value={selectedPath}
            onChange={(e) => setSelectedPath(e.target.value)}
            className="min-w-0 flex-1 rounded-[var(--radius-sm)] border border-[var(--color-separator)] bg-[var(--color-bg-primary)] px-2 py-1 text-xs text-[var(--color-text-primary)] focus:outline-none"
          >
            {models.length === 0 ? (
              <option value="">{t('apps.blender.noModel')}</option>
            ) : (
              models.map((m) => (
                <option key={m.path} value={m.path}>
                  {m.name}
                </option>
              ))
            )}
          </select>
        </div>
      )}
    </div>
  );
}

BlenderDisplayPanel.displayName = 'BlenderDisplayPanel';
