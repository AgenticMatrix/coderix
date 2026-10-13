import React, { useEffect, useState } from 'react';
import { X, Camera, Play } from 'lucide-react';
import { useT } from '../../i18n/index.js';
import type { AppDefinition } from './registry';

/**
 * BlenderDisplayPanel — the right-hand "app display page" for the blender-harness
 * app. Blender itself is auto-launched and tiled flush to the RIGHT of the coderix
 * window (as a separate native window), so the live GUI is visible next to the
 * app — no in-panel 3D viewer is needed. This panel just shows connection status
 * and offers a re-launch button.
 */

function blenderAPI(): Window['coderixAPI']['blender'] | undefined {
  return window.coderixAPI?.blender;
}

export function BlenderDisplayPanel({
  app,
  onClose,
}: {
  app: AppDefinition;
  onClose: () => void;
}): React.ReactElement {
  const t = useT();
  const [connected, setConnected] = useState(false);
  const [launching, setLaunching] = useState(false);

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

  const relaunch = async (): Promise<void> => {
    const b = blenderAPI();
    if (!b) return;
    setLaunching(true);
    try {
      await b.launch();
      const res = await b.status();
      setConnected(res.connected);
    } catch {
      // best-effort
    } finally {
      setLaunching(false);
    }
  };

  return (
    <div className="h-full flex flex-col bg-[var(--color-bg-secondary)]">
      {/* Header */}
      <div className="flex items-center gap-2 h-10 px-3 shrink-0 border-b border-[var(--color-separator)] bg-[var(--color-bg-primary)]">
        <span className="flex-1 text-sm font-medium text-[var(--color-text-primary)] truncate">{app.name}</span>
        <span
          className={`w-2 h-2 rounded-full ${connected ? 'bg-[var(--color-success,#22c55e)]' : 'bg-[var(--color-text-tertiary)]'}`}
          title={connected ? t('apps.blender.connected') : t('apps.blender.disconnected')}
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

      {/* Body — status only */}
      <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center">
        <Camera size={28} className="text-[var(--color-text-tertiary)]" />
        <div className="text-sm font-medium text-[var(--color-text-primary)]">
          {connected ? t('apps.blender.connected') : t('apps.blender.disconnected')}
        </div>
        <div className="text-xs text-[var(--color-text-tertiary)] max-w-sm">{t('apps.blender.tiled')}</div>
        <button
          type="button"
          onClick={relaunch}
          disabled={launching}
          className="mt-1 flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-md)] bg-[var(--color-brand)] text-white text-xs font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          <Play size={13} />
          {t('apps.blender.relaunch')}
        </button>
      </div>
    </div>
  );
}

BlenderDisplayPanel.displayName = 'BlenderDisplayPanel';
