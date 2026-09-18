/**
 * CLI Installer — ships the Bun-compiled `coderix` binary inside the app bundle
 * and symlinks it onto the user's PATH on first launch.
 *
 * The compiled CLI is bundled into the .app as two Mach-O executables
 * (`Contents/Resources/cli/coderix-arm64` + `coderix-x64`, one per CPU arch).
 * On first launch we pick the slice matching `process.arch`, choose a writable
 * directory that is already on PATH, and create a `coderix` symlink to it.
 *
 * Install directories, in priority order:
 *   1. /opt/homebrew/bin  (Apple Silicon Homebrew — on PATH via /etc/paths.d)
 *   2. /usr/local/bin     (Intel Homebrew + the default macOS PATH entry)
 *   3. ~/.coderix/bin     (always writable; we then append it to the shell rc)
 *
 * The install is idempotent: if `coderix` already points at our binary we no-op;
 * if a stale/foreign symlink occupies the slot we re-point it; a real (non-link)
 * file is never overwritten.
 */

import {
  accessSync,
  appendFileSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CliStatus {
  /** The bundled binary exists in this app bundle. */
  bundled: boolean;
  /** A `coderix` link currently points at this bundle's binary. */
  installed: boolean;
  /** Absolute path of the on-PATH symlink (when installed). */
  targetPath: string | null;
  /** Absolute path of the bundled binary (when bundled). */
  sourcePath: string | null;
}

export interface CliResult {
  ok: boolean;
  message: string;
  targetPath?: string;
  sourcePath?: string;
}

// ---------------------------------------------------------------------------
// Source resolution
// ---------------------------------------------------------------------------

const ARCH_SLICE: Record<string, string> = {
  arm64: 'coderix-arm64',
  x64: 'coderix-x64',
};

/**
 * Locate the bundled CLI binary for the running CPU architecture.
 * Returns null in dev (no binary is shipped) or when the slice is missing.
 */
export function resolveSourceBin(): string | null {
  const slice = ARCH_SLICE[process.arch];
  const candidates = [
    // Packaged app (electron-builder extraResources → Contents/Resources/cli/)
    slice ? join(process.resourcesPath, 'cli', slice) : '',
    // Loose fallbacks (universal layout / manual builds)
    join(process.resourcesPath, 'cli', 'coderix'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Install directory selection
// ---------------------------------------------------------------------------

function isDirWritable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pick the first directory that is (or can be made) writable, in PATH priority
 * order. Returns null if none can be used.
 */
export function chooseInstallDir(): string | null {
  const home = homedir();
  const dirs = ['/opt/homebrew/bin', '/usr/local/bin', join(home, '.coderix', 'bin')];

  for (const dir of dirs) {
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      if (isDirWritable(dir)) return dir;
    } catch {
      // Not writable / can't create (e.g. root-owned /opt) — try the next.
    }
  }
  return null;
}

/** The directory that requires a shell-PATH edit (our last-resort location). */
function isUserBin(dir: string): boolean {
  return dir === join(homedir(), '.coderix', 'bin');
}

// ---------------------------------------------------------------------------
// Shell PATH persistence (only for the ~/.coderix/bin fallback)
// ---------------------------------------------------------------------------

const EXPORT_LINE = (dir: string) => `export PATH="${dir}:$PATH"  # coderix`;

/**
 * Append `dir` to the user's shell startup files (zsh + bash), idempotently.
 * Skipped silently if a profile can't be read/written — the user can still add
 * it manually; the symlink itself is already created.
 */
function persistPathInShell(dir: string): void {
  const home = homedir();
  const targets = ['.zshrc', '.zprofile', '.bash_profile', '.bashrc'].map((f) =>
    join(home, f),
  );
  const line = EXPORT_LINE(dir);

  for (const file of targets) {
    try {
      let content = '';
      try {
        content = readFileSync(file, 'utf-8');
      } catch {
        content = '';
      }
      if (content.includes(dir)) continue; // already present (any form)
      appendFileSync(file, (content && !content.endsWith('\n') ? '\n' : '') + line + '\n');
    } catch {
      // Non-fatal — the symlink still works once the user adjusts PATH manually.
    }
  }
}

// ---------------------------------------------------------------------------
// Install / uninstall
// ---------------------------------------------------------------------------

/** True when `path` is a symlink (follows nothing; works for dangling links). */
function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export function installCli(): CliResult {
  const source = resolveSourceBin();
  if (!source) {
    return {
      ok: false,
      message:
        'CLI binary not found in this build (dev mode or incomplete bundle).',
    };
  }

  // The source must be executable for the symlink to work.
  try {
    chmodSync(source, 0o755);
  } catch {
    /* best-effort */
  }

  const dir = chooseInstallDir();
  if (!dir) {
    return {
      ok: false,
      message:
        'No writable install directory found (/opt/homebrew/bin, /usr/local/bin, or ~/.coderix/bin).',
      sourcePath: source,
    };
  }

  const target = join(dir, 'coderix');

  // Already installed pointing at this exact binary — nothing to do.
  if (isSymlink(target)) {
    try {
      if (readlinkSync(target) === source) {
        return {
          ok: true,
          message: `Already installed: ${target}`,
          targetPath: target,
          sourcePath: source,
        };
      }
    } catch {
      /* fall through and re-point */
    }
  } else if (existsSync(target)) {
    // A real file/dir (not our symlink) occupies the name — never overwrite.
    return {
      ok: false,
      message: `A different "coderix" already exists at ${target}; not overwriting.`,
      targetPath: target,
      sourcePath: source,
    };
  }

  // Re-point a stale/foreign symlink, then create (or recreate) the link.
  try {
    if (existsSync(target) || isSymlink(target)) unlinkSync(target);
    symlinkSync(source, target);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `Failed to create symlink ${target}: ${message}`,
      targetPath: target,
      sourcePath: source,
    };
  }

  if (isUserBin(dir)) persistPathInShell(dir);

  return {
    ok: true,
    message: isUserBin(dir)
      ? `Installed ${target} (added ${dir} to your shell PATH — restart your terminal).`
      : `Installed: ${target} -> ${source}`,
    targetPath: target,
    sourcePath: source,
  };
}

export function uninstallCli(): CliResult {
  const source = resolveSourceBin();
  const dirs = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.coderix', 'bin')];

  for (const dir of dirs) {
    const target = join(dir, 'coderix');
    if (!isSymlink(target)) continue;

    let link: string;
    try {
      link = readlinkSync(target);
    } catch {
      continue;
    }

    // Only remove links that point into a Coderix.app bundle (ours), leaving
    // any user-installed `coderix` symlink untouched.
    const isOurs =
      (source !== null && link === source) || link.includes('Coderix.app');

    if (!isOurs) continue;

    try {
      unlinkSync(target);
      return {
        ok: true,
        message: `Uninstalled: ${target}`,
        targetPath: target,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `Failed to remove ${target}: ${message}`, targetPath: target };
    }
  }

  return { ok: true, message: 'No coderix CLI symlink found.' };
}

export function getCliStatus(): CliStatus {
  const source = resolveSourceBin();
  const target = findInstalledLink(source);
  return {
    bundled: source !== null,
    installed: target !== null,
    targetPath: target,
    sourcePath: source,
  };
}

/** Locate the on-PATH symlink that points at our bundled binary (if any). */
function findInstalledLink(source: string | null): string | null {
  const dirs = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.coderix', 'bin')];
  for (const dir of dirs) {
    const target = join(dir, 'coderix');
    if (!isSymlink(target)) continue;
    try {
      const link = readlinkSync(target);
      if ((source !== null && link === source) || link.includes('Coderix.app')) {
        return target;
      }
    } catch {
      /* skip */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Config bootstrap (mirrors install.sh)
// ---------------------------------------------------------------------------

/**
 * Replicate the `~/.coderix` setup that `./install.sh` performs, so installing
 * the DMG + launching the app once is equivalent to running the installer:
 *   - create ~/.coderix/{sessions,skills,scratchpad}
 *   - copy config/default_settings.json → ~/.coderix/settings.json (if missing)
 *   - copy bundled skills (Contents/Resources/skills/) → ~/.coderix/skills/
 *
 * The core's own `loadSettings()`/`installBundledSkills()` read these resources
 * relative to `import.meta.url`, which points into the asar (or a virtual
 * $bunfs path for the compiled CLI) where those files don't exist — so this
 * explicit bootstrap is what makes a fresh install work. Idempotent: existing
 * settings.json and user-customized SKILL.md files are never overwritten.
 */
/** First candidate path that exists on disk, else null. */
function firstExisting(candidates: string[]): string | null {
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

export function bootstrapConfig(): CliResult {
  const home = homedir();
  const coderixDir = join(home, '.coderix');

  // 1. Base directory + runtime subdirectories.
  for (const sub of ['sessions', 'skills', 'scratchpad']) {
    try {
      mkdirSync(join(coderixDir, sub), { recursive: true });
    } catch {
      /* best-effort */
    }
  }

  // 2. Default settings.json (only when the user has none yet).
  const settingsPath = join(coderixDir, 'settings.json');
  const defaultSettings = firstExisting([
    join(process.resourcesPath, 'config', 'default_settings.json'),
    join(app.getAppPath(), 'config', 'default_settings.json'),
  ]);
  if (!existsSync(settingsPath) && defaultSettings) {
    try {
      mkdirSync(coderixDir, { recursive: true });
      copyFileSync(defaultSettings, settingsPath);
    } catch {
      /* best-effort */
    }
  }

  // 3. Bundled skills → ~/.coderix/skills/ (skip existing SKILL.md).
  const bundleSkillsDir = firstExisting([
    join(process.resourcesPath, 'skills'),
    join(app.getAppPath(), 'skills'),
  ]);
  const skillsDir = join(coderixDir, 'skills');
  if (bundleSkillsDir) {
    try {
      const entries = readdirSync(bundleSkillsDir);
      for (const entry of entries) {
        if (entry === '.DS_Store') continue;
        const bundlePath = join(bundleSkillsDir, entry);
        try {
          if (!statSync(bundlePath).isDirectory()) continue;
        } catch {
          continue;
        }
        const skillFile = join(bundlePath, 'SKILL.md');
        if (!existsSync(skillFile)) continue;

        const destDir = join(skillsDir, entry);
        mkdirSync(destDir, { recursive: true });

        for (const fileName of readdirSync(bundlePath)) {
          if (fileName === '.DS_Store') continue;
          const srcPath = join(bundlePath, fileName);
          const destPath = join(destDir, fileName);
          try {
            if (!statSync(srcPath).isFile()) continue;
          } catch {
            continue;
          }
          if (fileName === 'SKILL.md' && existsSync(destPath)) continue;
          copyFileSync(srcPath, destPath);
        }
      }
    } catch {
      /* best-effort */
    }
  }

  return { ok: true, message: `Config ready at ${coderixDir}`, targetPath: coderixDir };
}
