import React, { useEffect, useRef, useState, useMemo } from 'react';
import { X, Loader2, RefreshCw } from 'lucide-react';
import { useT } from '../../i18n/index.js';
import type { AppDefinition } from './registry';
import { listCadSteps } from '../../ipc-client.js';
import type { CadStep } from '../../types.js';

/**
 * AppDisplayPanel — the right-hand "app display page" for an attached app.
 *
 * For the `cad-viewer` kind: spawns the self-contained 3D viewer (port 3245),
 * embeds it as a native WebContentsView over a measured container, and lists the
 * CAD artifacts below it using cad_harness's native form — two rows (装配体 /
 * 零件), each a name `<select>` + a 版本 `<select>` of that name's versions.
 */

const TAB_ID = 'app-display';

type ViewerStatus = 'stopped' | 'starting' | 'running' | 'error';

function cadViewerAPI(): Window['coderixAPI']['cadViewer'] | undefined {
  return window.coderixAPI?.cadViewer;
}
function browserAPI(): Window['coderixAPI']['browser'] | undefined {
  return window.coderixAPI?.browser;
}

function buildViewerUrl(baseUrl: string, workspaceDir: string, fileRel: string): string {
  const abs = workspaceDir.replace(/\\/g, '/');
  const pathPart = abs.startsWith('/') ? abs : `/${abs}`;
  const base = `${baseUrl}${pathPart}`;
  return fileRel ? `${base}?file=${encodeURIComponent(fileRel)}` : base;
}

const FRAME_RE = /^frame_\d+$/i;
function isFrameStep(step: CadStep): boolean {
  return step.kind === 'frame' || FRAME_RE.test(step.baseName ?? step.name);
}
function baseNameOf(step: CadStep): string {
  return step.baseName ?? step.name;
}
function versionOf(step: CadStep): number {
  return step.version ?? 1;
}

interface StepGroup {
  baseName: string;
  versions: CadStep[];
}

/** Keep versions of the same part adjacent: baseName asc, latest first, versions asc. */
function sortSteps(steps: CadStep[]): CadStep[] {
  return [...steps].sort((a, b) => {
    const an = baseNameOf(a);
    const bn = baseNameOf(b);
    if (an !== bn) return an.localeCompare(bn);
    if (!!a.isLatest !== !!b.isLatest) return a.isLatest ? -1 : 1;
    return versionOf(a) - versionOf(b);
  });
}

function groupSteps(steps: CadStep[]): StepGroup[] {
  const map = new Map<string, CadStep[]>();
  for (const step of steps) {
    const key = baseNameOf(step);
    const list = map.get(key);
    if (list) list.push(step);
    else map.set(key, [step]);
  }
  return [...map.entries()]
    .map(([baseName, versions]) => ({ baseName, versions }))
    .sort((a, b) => a.baseName.localeCompare(b.baseName));
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
  const [steps, setSteps] = useState<CadStep[]>([]);
  const [selectedStepId, setSelectedStepId] = useState<string>('');
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

  // ── Poll the workspace for structured CAD steps (grouped + versioned) ───
  useEffect(() => {
    if (!workspaceDir) return;
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      try {
        const res = await listCadSteps(workspaceDir);
        if (!cancelled) setSteps(res ?? []);
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

  // ── Auto-select the default step on first load (latest assembly, else first part) ──
  useEffect(() => {
    if (selectedStepId || steps.length === 0) return;
    const nonFrames = steps.filter((s) => !isFrameStep(s));
    const assemblies = nonFrames.filter((s) => s.kind !== 'part');
    const pick = (list: CadStep[]): CadStep | undefined => {
      // latest live entry, else highest numbered version.
      const live = list.find((s) => s.isLatest);
      return live ?? list.reduce((a, b) => (versionOf(a) >= versionOf(b) ? a : b), list[0]);
    };
    const target = assemblies.length > 0 ? pick(assemblies) : pick(nonFrames.filter((s) => s.kind === 'part'));
    if (target) setSelectedStepId(target.id);
  }, [steps, selectedStepId]);

  const ordered = useMemo(() => sortSteps(steps).filter((s) => !isFrameStep(s)), [steps]);
  const assemblyGroups = useMemo(() => groupSteps(ordered.filter((s) => s.kind !== 'part')), [ordered]);
  const partGroups = useMemo(() => groupSteps(ordered.filter((s) => s.kind === 'part')), [ordered]);

  const selectedStep = steps.find((s) => s.id === selectedStepId);
  const url =
    status === 'running' && baseUrl && workspaceDir
      ? buildViewerUrl(baseUrl, workspaceDir, selectedStep?.viewerFile ?? '')
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

  const statusLabel = (s: CadStep['status']): string =>
    s === 'generated' ? t('apps.status.generated') : t('apps.status.generating');
  const versionLabel = (step: CadStep): string =>
    step.isLatest
      ? `${t('apps.latest')} · ${statusLabel(step.status)}`
      : `${t('apps.version', { n: step.version })} · ${statusLabel(step.status)}`;

  const renderGroupSelect = (label: string, groups: StepGroup[], selectPlaceholder: string): React.ReactElement => {
    let selectedBase = '';
    for (const group of groups) {
      if (group.versions.some((v) => v.id === selectedStepId)) {
        selectedBase = group.baseName;
        break;
      }
    }
    const selectedGroup = groups.find((g) => g.baseName === selectedBase);

    const selectBase = (base: string): void => {
      const group = groups.find((g) => g.baseName === base);
      if (!group || group.versions.length === 0) return;
      const live = group.versions.find((v) => v.isLatest);
      setSelectedStepId((live ?? group.versions[group.versions.length - 1]).id);
    };

    return (
      <div className="flex items-center gap-2">
        <span className="w-11 shrink-0 text-[11px] font-medium text-[var(--color-text-tertiary)]">{label}</span>
        <select
          value={selectedBase}
          onChange={(e) => selectBase(e.target.value)}
          className="min-w-0 flex-1 rounded-[var(--radius-sm)] border border-[var(--color-separator)] bg-[var(--color-bg-primary)] px-2 py-1 text-xs text-[var(--color-text-primary)] focus:outline-none"
        >
          <option value="">{groups.length === 0 ? t('apps.none') : selectPlaceholder}</option>
          {groups.map((group) => (
            <option key={group.baseName} value={group.baseName}>
              {group.baseName}
            </option>
          ))}
        </select>
        <span className="shrink-0 text-[11px] font-medium text-[var(--color-text-tertiary)]">{t('apps.versionLabel')}</span>
        <select
          value={selectedStepId}
          onChange={(e) => {
            if (e.target.value) setSelectedStepId(e.target.value);
          }}
          className="min-w-0 flex-1 rounded-[var(--radius-sm)] border border-[var(--color-separator)] bg-[var(--color-bg-primary)] px-2 py-1 text-xs text-[var(--color-text-primary)] focus:outline-none disabled:opacity-50"
          disabled={!selectedGroup}
        >
          {selectedGroup ? (
            selectedGroup.versions.map((v) => (
              <option key={v.id} value={v.id}>
                {versionLabel(v)}
              </option>
            ))
          ) : (
            <option value="">{t('apps.selectVersion')}</option>
          )}
        </select>
      </div>
    );
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

      {/* Artifact selector — cad_harness's native form: 装配体 / 零件 rows, each name + 版本 selects */}
      <div className="shrink-0 border-t border-[var(--color-separator)] flex flex-col gap-1.5 px-3 py-2 bg-[var(--color-bg-primary)]">
        {renderGroupSelect(t('apps.assembly'), assemblyGroups, t('apps.selectAssembly'))}
        {renderGroupSelect(t('apps.part'), partGroups, t('apps.selectPart'))}
      </div>
    </div>
  );
}

AppDisplayPanel.displayName = 'AppDisplayPanel';
