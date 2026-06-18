/**
 * Memory staleness calculation and warning generation.
 *
 * Memories are point-in-time observations — claims about code behavior
 * or file:line citations may become outdated. This module computes age
 * and generates appropriate staleness warnings for surfacing to the model.
 */

import type { MemoryEntry } from './types.js';

// ---------------------------------------------------------------------------
// Age calculation
// ---------------------------------------------------------------------------

/**
 * Days elapsed since mtime. Floor-rounded — 0 for today, 1 for
 * yesterday, 2+ for older. Negative inputs (future mtime, clock skew)
 * clamp to 0.
 */
export function memoryAgeDays(mtimeMs: number): number {
  return Math.max(0, Math.floor((Date.now() - mtimeMs) / 86_400_000));
}

/**
 * Human-readable age string. Models are poor at date arithmetic —
 * a raw ISO timestamp doesn't trigger staleness reasoning the way
 * "47 days ago" does.
 */
export function memoryAge(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs);
  if (d === 0) return 'today';
  if (d === 1) return 'yesterday';
  return `${d} days ago`;
}

// ---------------------------------------------------------------------------
// Staleness warnings
// ---------------------------------------------------------------------------

/**
 * Plain-text staleness caveat for memories older than the threshold.
 * Returns '' for fresh memories — warning there is noise.
 *
 * Motivated by user reports of stale code-state memories (file:line
 * citations to code that has since changed) being asserted as fact —
 * the citation makes the stale claim sound more authoritative, not less.
 */
export function memoryFreshnessText(
  mtimeMs: number,
  thresholdDays: number = 1,
): string {
  const d = memoryAgeDays(mtimeMs);
  if (d <= thresholdDays) return '';

  return (
    `This memory is ${d} days old. ` +
    `Memories are point-in-time observations, not live state — ` +
    `claims about code behavior or file:line citations may be outdated. ` +
    `Verify against current code before asserting as fact.`
  );
}

/**
 * Per-memory staleness note wrapped in <system-reminder> tags.
 * Use this for callers that inject memory content inline.
 */
export function memoryFreshnessNote(
  mtimeMs: number,
  thresholdDays: number = 1,
): string {
  const text = memoryFreshnessText(mtimeMs, thresholdDays);
  if (!text) return '';
  return `<system-reminder>${text}</system-reminder>\n`;
}

// ---------------------------------------------------------------------------
// Batch staleness injection
// ---------------------------------------------------------------------------

/**
 * Generate a staleness summary for a set of recalled memories.
 * Only includes warnings for memories older than the threshold.
 */
export function injectStalenessWarnings(
  memories: Array<{ path: string; mtime: number; frontmatter?: { name: string } }>,
  thresholdDays: number = 1,
): string {
  const stale = memories.filter(m => memoryAgeDays(m.mtime) > thresholdDays);

  if (stale.length === 0) return '';

  if (stale.length === 1) {
    const m = stale[0];
    const name = m.frontmatter?.name ?? m.path.split('/').pop() ?? 'memory';
    return `\n<system-reminder>Memory "${name}" was last updated ${memoryAge(m.mtime)}. Verify its claims against current state before acting on them.</system-reminder>`;
  }

  const names = stale.map(m =>
    m.frontmatter?.name ?? m.path.split('/').pop() ?? 'memory',
  );
  return `\n<system-reminder>${stale.length} recalled memories are older than ${thresholdDays} day(s) (${names.join(', ')}). Verify their claims against current state before acting on them.</system-reminder>`;
}
