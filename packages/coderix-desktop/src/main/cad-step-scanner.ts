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

/** Copy the current artifact files into a version archive (flattened to basename). */
function archiveVersion(workspaceDir: string, archiveDirRel: string, files: FileSet): FileSet {
  const archiveAbs = path.join(workspaceDir, archiveDirRel);
  try {
    mkdirSync(archiveAbs, { recursive: true });
  } catch {
    // ignore — copy will fail gracefully below
  }

  const archived: FileSet = {};
  const copy = (rel: string | undefined): string | undefined => {
    if (!rel) return undefined;
    try {
      const dstRel = path.basename(rel);
      copyFileSync(path.join(workspaceDir, rel), path.join(archiveAbs, dstRel));
      return path.posix.join(archiveDirRel, dstRel);
    } catch {
      return undefined;
    }
  };

  archived.source = copy(files.source);
  archived.step = copy(files.step);
  archived.glb = copy(files.glb);
  archived.snapshot = copy(files.snapshot);
  return archived;
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

    // Version detection: a new source hash (or the first time we see the part)
    // mints a new version; otherwise the live files are the newest version.
    const baseDir = path.join(workspaceDir, ARCHIVE_DIR, safeBaseName(name));
    const existing = listVersions(baseDir);
    let version: number;
    let isNew: boolean;
    if (existing.length === 0) {
      version = 1;
      isNew = true;
    } else {
      const newest = existing[existing.length - 1]!;
      const archivedFp = fingerprintArchived(baseDir, name, newest);
      if (liveFp !== undefined && archivedFp === liveFp) {
        version = newest;
        isNew = false;
      } else {
        version = newest + 1;
        isNew = true;
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

    // The live (latest) step points at the workspace files.
    steps.push({
      ...base,
      id: `${name}-latest`,
      name: version === 1 ? name : `${name}-${version}`,
      isLatest: true,
      viewerFile: files.source ?? files.step ?? files.glb,
      sourcePath: files.source,
      stepPath: files.step,
      glbPath: files.glb,
      snapshotPath: files.snapshot,
    });

    // Archived versions (including any freshly-minted one) are selectable too.
    // Archives are flattened to basename, so each version's files live at
    // `history/<base>/<v>/<basename>`.
    const allVersions = isNew ? [...existing, version] : existing;
    const srcBase = files.source ? path.basename(files.source) : undefined;
    const stepBase = files.step ? path.basename(files.step) : undefined;
    const glbBase = files.glb ? path.basename(files.glb) : undefined;
    const snapBase = files.snapshot ? path.basename(files.snapshot) : undefined;
    for (const v of allVersions) {
      const dir = `${ARCHIVE_DIR}/${safeBaseName(name)}/${v}`;
      steps.push({
        ...base,
        id: `${name}-${v}`,
        name: v === 1 ? name : `${name}-${v}`,
        version: v,
        isLatest: false,
        viewerFile: srcBase ? `${dir}/${srcBase}` : stepBase ? `${dir}/${stepBase}` : glbBase ? `${dir}/${glbBase}` : undefined,
        sourcePath: srcBase ? `${dir}/${srcBase}` : undefined,
        stepPath: stepBase ? `${dir}/${stepBase}` : undefined,
        glbPath: glbBase ? `${dir}/${glbBase}` : undefined,
        snapshotPath: snapBase ? `${dir}/${snapBase}` : undefined,
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
