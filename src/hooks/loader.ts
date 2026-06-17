/**
 * loader.ts — HookLoader
 *
 * Discovers hook configurations from two layers:
 *   1. Global: ~/.coder/hooks.json
 *   2. Project: .coder/hooks.json (takes precedence — its hooks run first)
 *
 * Merged hooks are indexed by event type for O(1) lookup inside
 * HookManager's hot path (called on every tool use, message, etc.).
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HookConfig, HookDefinition, HookEvent } from './types.js';

// ═══════════════════════════════════════════════════════════════════
// Default paths
// ═══════════════════════════════════════════════════════════════════

const DEFAULT_GLOBAL_PATH = join(homedir(), '.coder', 'hooks.json');
const DEFAULT_PROJECT_PATH = join('.coder', 'hooks.json');

// ═══════════════════════════════════════════════════════════════════
// Loader config
// ═══════════════════════════════════════════════════════════════════

export interface HookLoaderConfig {
  globalConfigPath?: string;
  projectConfigPath?: string;
}

// ═══════════════════════════════════════════════════════════════════
// HookLoader
// ═══════════════════════════════════════════════════════════════════

export class HookLoader {
  /** Event → ordered list of hooks (project hooks first, then global) */
  private hooks: Map<HookEvent, HookDefinition[]> = new Map();

  private globalPath: string;
  private projectPath: string;

  constructor(config: HookLoaderConfig = {}) {
    this.globalPath = config.globalConfigPath ?? DEFAULT_GLOBAL_PATH;
    this.projectPath = config.projectConfigPath ?? DEFAULT_PROJECT_PATH;
  }

  // ── Initialization ─────────────────────────────────────────────

  /**
   * Load hooks from both layers. Call once at HookManager construction
   * or when hot-reloading configuration.
   */
  load(): void {
    this.hooks.clear();

    // Global first (pushed to back), then project (unshifted to front)
    // so that project hooks execute first when iterated.
    this.loadGlobal();
    this.loadProject();
  }

  /**
   * Reload all hooks (e.g. after user edits hooks.json).
   */
  reload(): void {
    this.load();
  }

  // ── Query ──────────────────────────────────────────────────────

  /**
   * Return all hooks registered for a given event.
   * Project-level hooks appear first, then global.
   * Returns an empty array when no hooks match — safe to iterate.
   */
  getForEvent(event: HookEvent): HookDefinition[] {
    return this.hooks.get(event) ?? [];
  }

  /**
   * Return the full hook map — useful for introspection / debug.
   */
  getAll(): ReadonlyMap<HookEvent, HookDefinition[]> {
    return this.hooks;
  }

  /**
   * Count of total registered hooks across all events.
   */
  totalCount(): number {
    let count = 0;
    for (const list of this.hooks.values()) count += list.length;
    return count;
  }

  // ── Internal ───────────────────────────────────────────────────

  /** Load global hooks (appended to end — lower priority). */
  private loadGlobal(): void {
    this.loadFile(this.globalPath, false);
  }

  /** Load project hooks (unshifted to front — higher priority). */
  private loadProject(): void {
    this.loadFile(this.projectPath, true);
  }

  /**
   * Read a single hooks.json file and merge its hooks into the index.
   *
   * @param prepend — if true, hooks are unshifted to the front
   *                  (project hooks execute first)
   */
  private loadFile(filepath: string, prepend: boolean): void {
    if (!existsSync(filepath)) return;

    let config: HookConfig;
    try {
      const raw = readFileSync(filepath, 'utf-8');
      config = JSON.parse(raw) as HookConfig;
    } catch {
      // Malformed JSON — skip silently (fail-open)
      return;
    }

    if (!config.hooks || !Array.isArray(config.hooks)) return;

    for (const hook of config.hooks) {
      if (!hook.event || !hook.command) continue; // Skip invalid entries

      const list = this.hooks.get(hook.event) ?? [];
      if (!this.hooks.has(hook.event)) {
        this.hooks.set(hook.event, list);
      }

      if (prepend) {
        list.unshift(hook); // Project hooks first
      } else {
        list.push(hook);    // Global hooks after
      }
    }
  }
}
