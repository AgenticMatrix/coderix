/**
 * Windows ↔ POSIX path conversion for Git Bash / MSYS2 compatibility.
 *
 * When Coderix runs on Windows with Git Bash as the shell, file paths in
 * commands must be converted from Windows form (C:\Users\foo) to POSIX
 * form (/c/Users/foo) so that bash can resolve them.
 *
 * Pure JS implementation — no native dependencies, no filesystem access.
 * Results are cached with a simple LRU map (max 500 entries).
 */

// ── LRU Cache ────────────────────────────────────────────────────────────

const MAX_CACHE = 500;
const cache = new Map<string, string>();

function cached(key: string, compute: () => string): string {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  if (cache.size >= MAX_CACHE) {
    // Evict oldest (first inserted) entry
    cache.delete(cache.keys().next().value!);
  }
  const value = compute();
  cache.set(key, value);
  return value;
}

// ── Converters ───────────────────────────────────────────────────────────

/**
 * Convert a Windows path to POSIX form suitable for Git Bash / MSYS2.
 *
 *   C:\Users\foo  →  /c/Users/foo
 *   \\server\share → //server/share
 *   relative\path  →  relative/path
 */
export function toPosixPath(windowsPath: string): string {
  return cached(windowsPath, () => {
    // UNC: \\server\share → //server/share
    if (windowsPath.startsWith('\\\\')) {
      return windowsPath.replace(/\\/g, '/');
    }
    // Drive letter: C:\foo → /c/foo
    const driveMatch = windowsPath.match(/^([A-Za-z]):[/\\]/);
    if (driveMatch) {
      return '/' + driveMatch[1]!.toLowerCase() + windowsPath.slice(2).replace(/\\/g, '/');
    }
    // Already POSIX-ish or relative — just flip slashes
    return windowsPath.replace(/\\/g, '/');
  });
}

/**
 * Convert a POSIX path back to Windows native form.
 *
 *   /c/Users/foo       →  C:\Users\foo
 *   /cygdrive/c/Users  →  C:\Users
 *   //server/share     →  \\server\share
 *   relative/path      →  relative\path
 */
export function toWindowsPath(posixPath: string): string {
  return cached(posixPath, () => {
    // UNC: //server/share → \\server\share
    if (posixPath.startsWith('//')) {
      return posixPath.replace(/\//g, '\\');
    }
    // Cygwin/MSYS2: /cygdrive/c/... → C:\...
    const cygdrive = posixPath.match(/^\/cygdrive\/([A-Za-z])(\/|$)/);
    if (cygdrive) {
      const drive = cygdrive[1]!.toUpperCase();
      const rest = posixPath.slice(('/cygdrive/' + cygdrive[1]).length).replace(/\//g, '\\');
      return drive + ':' + (rest || '\\');
    }
    // Git Bash: /c/... → C:\...
    const driveMatch = posixPath.match(/^\/([A-Za-z])(\/|$)/);
    if (driveMatch) {
      const drive = driveMatch[1]!.toUpperCase();
      const rest = posixPath.slice(2).replace(/\//g, '\\');
      return drive + ':' + (rest || '\\');
    }
    // Already Windows-ish or relative — flip slashes
    return posixPath.replace(/\//g, '\\');
  });
}
