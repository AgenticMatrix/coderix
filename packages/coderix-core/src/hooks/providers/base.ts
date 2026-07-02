/**
 * providers/base.ts — HookProvider interface re-export.
 *
 * The canonical interface is defined in ../types.ts alongside all other
 * hook types to keep the type system co-located.  This file is a
 * lightweight re-export for consumers who prefer importing from
 * `providers/`.
 */

export type { HookProvider } from '../types.js';
