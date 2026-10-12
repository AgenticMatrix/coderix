/**
 * CAD step scanner — a focused port of cad_harness's `step-scanner.ts` for the
 * desktop's right-hand CAD panel.
 *
 * cad_harness's native UI groups CAD artifacts by `baseName`, shows a 1-based
 * version number per generation, and classifies each as an assembly / part /
 * animation frame. The versioning is content-addressed: a `.step.py` generator
 * whose bytes change becomes a new, immutable version, archived under
 * `history/<base>/<version>/` and never overwritten.
 *
 * This module reproduces that scan → group → classify → version → archive
 * pipeline, statelessly (recomputed on each poll). It omits cad_harness's
 * `inspect validate` status loop (slow, display-irrelevant) — status here is
 * `generating` (no `.step` yet) vs `generated` — and its SSE/sessions.json
 * persistence (versions are derived from the `history/` layout + a content hash).
 *
 * Simplification vs the native scanner: the version fingerprint hashes only the
 * primary source (`.step.py`, falling back to `.step`), not the transitive
 * first-party import closure. Editing a part's own generator bumps its version;
 * editing a shared helper it imports does not. Archives are flattened (source
 * keeps its basename) rather than mirroring the workspace layout.
 */

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import path from 'node:path';

export type CadStepKind = 'assembly' | 'part' | 'frame';
export type CadStepStatus = 'generating' | 'generated';

export interface CadStep {
  /** Stable id, e.g. `bracket-latest` or `bracket-2`. */
  id: string;
  /** Display name, e.g. `bracket` (v1) or `bracket-2` (v2). */
  name: string;
  /** Original part name shared across all versions of the same artifact. */
  baseName: string;
  /** 1-based version number. */
  version: number;
  /** True for the synthetic step pointing at the live (non-archived) workspace files. */
  isLatest: boolean;
  kind: CadStepKind;
  status: CadStepStatus;
  /** Workspace-relative file the viewer should navigate to. */
  viewerFile?: string;
  /** SHA-1 of the live source (`.step.py`, falling back to `.step`/`.glb`) — a change signals the viewer to re-render. */
  renderHash?: string;
  /** mtime (ms) of the live source, for "most recently updated" ordering. */
  sourceMtime?: number;
  sourcePath?: string;
  stepPath?: string;
  glbPath?: string;
  snapshotPath?: string;
}

const ARCHIVE_DIR = 'history';

const SKIPPED_DIRS = new Set([
  'node_modules',
  '__pycache__',
  '.git',
  '.cadgen',
  '__cadgen__', // cadgen tessellation cache — not source artifacts
  '.cache',
  'cache',
  'artifacts',
  '.claude',
  '.coderix',
  ARCHIVE_DIR,
  'frames', // animation-frame STEP exports, transient
]);

/** Animation frames (`frame_<n>`) are transient scaffolding, not selectable parts. */
const FRAME_RE = /^frame_\d+$/i;

/** Make a base name safe to use as a filesystem directory segment. */
function safeBaseName(name: string): string {
  const slug = name.replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '');
  return slug || 'step';
}

/**
 * Coalesce rapid-fire edits into one version: a fingerprint that differs from
 * the newest archive is only minted once it has stayed stable for this long.
 */
const VERSION_DEBOUNCE_MS = 5 * 60 * 1000;

/** Mint a version after this many cumulative fingerprint changes, even if it never stabilizes. */
const VERSION_CHANGE_LIMIT = 10;

/** Per-artifact pending fingerprint → first-seen timestamp + change count (in-memory; resets on restart). */
const pendingFingerprints = new Map<string, { fp: string; since: number; changes: number }>();

/** Recursively walk a directory, returning absolute file paths (skipping dot + skip dirs). */
function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name) && !entry.name.startsWith('.')) stack.push(abs);
      } else if (entry.isFile()) {
        out.push(abs);
      }
    }
  }
  return out;
}

interface FileSet {
  source?: string; // workspace-relative <name>.step.py
  step?: string; // workspace-relative <name>.step
  glb?: string; // workspace-relative <name>.glb
  snapshot?: string; // workspace-relative <name>.png
}

/** Classify an artifact: top-level = assembly, nested = part, `frame_<n>` = frame. */
function inferKind(files: FileSet, name: string): CadStepKind {
  if (FRAME_RE.test(name)) return 'frame';
  const rel = files.source ?? files.step;
  if (!rel) return 'part';
  return rel.split(path.sep).join('/').includes('/') ? 'part' : 'assembly';
}

/** SHA-1 of a file's bytes — the version fingerprint. */
function fingerprintFile(absPath: string): string {
  return createHash('sha1').update(readFileSync(absPath)).digest('hex');
}

/** The primary source-of-truth file for a group, falling back `.step` → `.glb`. */
function primaryFile(files: FileSet): string | undefined {
  return files.source ?? files.step ?? files.glb;
}

/** mtime (ms) of the primary source file, for "most recently updated" ordering. */
function primaryMtime(workspaceDir: string, files: FileSet): number | undefined {
  const rel = primaryFile(files);
  if (!rel) return undefined;
  try {
    return statSync(path.join(workspaceDir, rel)).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Enumerate archived version numbers (1-based) under `history/<base>/`. */
function listVersions(baseDir: string): number[] {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const versions: number[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const n = Number(entry.name);
    if (Number.isInteger(n) && n >= 1) versions.push(n);
  }
  return versions.sort((a, b) => a - b);
}

/**
 * Fingerprint the primary source archived in `history/<base>/<version>/`. The
 * archive flattens the source to its basename, so we fingerprint
 * `<versionDir>/<base>.<ext>` directly.
 */
function fingerprintArchived(baseDir: string, baseName: string, version: number): string | undefined {
  const versionDir = path.join(baseDir, String(version));
  for (const ext of ['.step.py', '.step', '.stp']) {
    const candidate = path.join(versionDir, `${baseName}${ext}`);
    if (existsSync(candidate)) {
      try {
        return fingerprintFile(candidate);
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** Archive only the artifact's primary source (flattened to basename) into a version dir. */
function archiveVersion(workspaceDir: string, archiveDirRel: string, files: FileSet): string | undefined {
  // Keep only the source (`.step.py`, falling back to an imported `.step`/`.glb`).
  // The compiled `.step`/`.glb` and snapshots are large and regenerable from the
  // source, so copying them into every version would blow up the workspace.
  const rel = files.source ?? files.step ?? files.glb;
  if (!rel) return undefined;
  const archiveAbs = path.join(workspaceDir, archiveDirRel);
  try {
    mkdirSync(archiveAbs, { recursive: true });
  } catch {
    // ignore — copy will fail gracefully below
  }
  try {
    const dstRel = path.basename(rel);
    copyFileSync(path.join(workspaceDir, rel), path.join(archiveAbs, dstRel));
    return path.posix.join(archiveDirRel, dstRel);
  } catch {
    return undefined;
  }
}

/**
 * Scan a workspace and reconcile its CAD steps. Each distinct generation becomes
 * a new immutable version (archived under `history/<base>/<version>/`); the live
 * workspace files are surfaced as a synthetic "latest" step.
 */
export function scanSteps(workspaceDir: string): CadStep[] {
  const relFiles = walkFiles(workspaceDir).map((abs) =>
    path.relative(workspaceDir, abs).split(path.sep).join('/'),
  );

  // Group sidecar files by base name: `bracket.step.py` + `bracket.step` +
  // `bracket.glb` + `bracket.png` all belong to the `bracket` artifact.
  const groups = new Map<string, FileSet>();
  for (const rel of relFiles) {
    const base = rel.split('/').pop()!;
    let name: string | null = null;
    if (base.endsWith('.step.py')) name = base.slice(0, -'.step.py'.length);
    else if (base.endsWith('.step')) name = base.slice(0, -'.step'.length);
    else if (base.endsWith('.stp')) name = base.slice(0, -'.stp'.length);
    else if (base.endsWith('.glb')) name = base.slice(0, -'.glb'.length);
    else if (base.endsWith('.png')) name = base.slice(0, -'.png'.length);
    if (!name) continue;

    const g = groups.get(name) ?? {};
    if (base.endsWith('.step.py')) g.source = rel;
    else if (base.endsWith('.step') || base.endsWith('.stp')) g.step = rel;
    else if (base.endsWith('.glb')) g.glb = rel;
    else if (base.endsWith('.png')) g.snapshot = rel;
    groups.set(name, g);
  }

  const steps: CadStep[] = [];
  for (const [name, files] of groups) {
    if (!files.source && !files.step) continue; // not a CAD artifact
    if (FRAME_RE.test(name)) continue; // animation frames are not selectable

    const kind = inferKind(files, name);
    const status: CadStepStatus = files.step ? 'generated' : 'generating';
    const liveFp = (() => {
      const rel = primaryFile(files);
      if (!rel) return undefined;
      try {
        return fingerprintFile(path.join(workspaceDir, rel));
      } catch {
        return undefined;
      }
    })();

    // Version detection: a new source hash mints a new version, but only after
    // the fingerprint has stayed stable for VERSION_DEBOUNCE_MS — so rapid-fire
    // edits during a generation collapse into one version instead of one per
    // keystroke-sized change.
    const baseDir = path.join(workspaceDir, ARCHIVE_DIR, safeBaseName(name));
    const existing = listVersions(baseDir);
    const now = Date.now();
    const pendingKey = `${workspaceDir}::${name}`;
    let version: number;
    let isNew: boolean;
    if (existing.length === 0) {
      // First time we see the part — mint version 1 immediately.
      version = 1;
      isNew = true;
    } else {
      const newest = existing[existing.length - 1]!;
      const archivedFp = fingerprintArchived(baseDir, name, newest);
      if (liveFp !== undefined && archivedFp === liveFp) {
        // Unchanged since the newest archive.
        version = newest;
        isNew = false;
        pendingFingerprints.delete(pendingKey);
      } else if (liveFp === undefined) {
        // Source unreadable — report the newest version, don't count or mint.
        version = newest;
        isNew = false;
        pendingFingerprints.delete(pendingKey);
      } else {
        // Fingerprint differs from the newest archive. Mint when it has been
        // stable for VERSION_DEBOUNCE_MS, or when the source has changed
        // VERSION_CHANGE_LIMIT times cumulatively — so continuous editing still
        // produces a version.
        const rec = pendingFingerprints.get(pendingKey);
        const isNewChange = rec === undefined || rec.fp !== liveFp;
        const changes = isNewChange ? (rec?.changes ?? 0) + 1 : rec.changes;
        const since = isNewChange ? now : rec.since;
        const settled = !isNewChange && now - since >= VERSION_DEBOUNCE_MS;
        pendingFingerprints.set(pendingKey, { fp: liveFp, since, changes });
        if (settled || changes >= VERSION_CHANGE_LIMIT) {
          version = newest + 1;
          isNew = true;
          pendingFingerprints.delete(pendingKey);
        } else {
          version = newest;
          isNew = false;
        }
      }
    }

    const archiveDirRel = `${ARCHIVE_DIR}/${safeBaseName(name)}/${version}`;
    if (isNew) archiveVersion(workspaceDir, archiveDirRel, files);

    const base = {
      baseName: name,
      version,
      kind,
      status,
    };

    // The live (latest) step points at the workspace files. `renderHash` reuses
    // the source fingerprint (already computed above for versioning): the
    // renderer reloads the viewer when it changes, so the 3D view tracks edits
    // without spurious refreshes on every poll.
    steps.push({
      ...base,
      id: `${name}-latest`,
      name: version === 1 ? name : `${name}-${version}`,
      isLatest: true,
      viewerFile: files.source ?? files.step ?? files.glb,
      renderHash: liveFp,
      sourceMtime: primaryMtime(workspaceDir, files),
      sourcePath: files.source,
      stepPath: files.step,
      glbPath: files.glb,
      snapshotPath: files.snapshot,
    });

    // Archived versions (including any freshly-minted one) are selectable too.
    // Only the primary source is archived (flattened to basename), so each
    // version's file lives at `history/<base>/<v>/<basename>`.
    const allVersions = isNew ? [...existing, version] : existing;
    const primary = files.source ?? files.step ?? files.glb;
    const primaryBase = primary ? path.basename(primary) : undefined;
    for (const v of allVersions) {
      const dir = `${ARCHIVE_DIR}/${safeBaseName(name)}/${v}`;
      steps.push({
        ...base,
        id: `${name}-${v}`,
        name: v === 1 ? name : `${name}-${v}`,
        version: v,
        isLatest: false,
        viewerFile: primaryBase ? `${dir}/${primaryBase}` : undefined,
        sourcePath: files.source && primary === files.source ? `${dir}/${primaryBase}` : undefined,
        // step/glb/snapshot are not archived — only the source is kept.
      });
    }
  }

  // Order: assemblies first, then parts; then by baseName.
  const kindOrder: Record<CadStepKind, number> = { assembly: 0, part: 1, frame: 2 };
  return steps.sort(
    (a, b) =>
      kindOrder[a.kind] - kindOrder[b.kind] ||
      a.baseName.localeCompare(b.baseName) ||
      a.version - b.version ||
      (a.isLatest === b.isLatest ? 0 : a.isLatest ? 1 : -1),
  );
}
