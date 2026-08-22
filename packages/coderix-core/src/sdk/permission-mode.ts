/**
 * sdk/permission-mode.ts — map claude-code-sdk permission modes to
 * Coderix's internal PermissionMode enum and back.
 *
 * claude-code-sdk semantics → Coderix semantics:
 *   default            → ask    (prompt before mutating/destructive tools)
 *   acceptEdits        → auto   (auto-approve edits & safe tools, still guard destructive)
 *   plan               → plan   (plan only, no side effects)
 *   bypassPermissions  → low    (auto-approve everything incl. destructive)
 */

import { PermissionMode as CorePermissionMode } from '../core/types.js';
import type { PermissionMode } from './types.js';

const TO_CORE: Record<PermissionMode, CorePermissionMode> = {
  default: CorePermissionMode.ASK,
  acceptEdits: CorePermissionMode.AUTO,
  plan: CorePermissionMode.PLAN,
  bypassPermissions: CorePermissionMode.LOW,
};

const FROM_CORE: Record<CorePermissionMode, PermissionMode> = {
  [CorePermissionMode.ASK]: 'default',
  [CorePermissionMode.AUTO]: 'acceptEdits',
  [CorePermissionMode.PLAN]: 'plan',
  [CorePermissionMode.LOW]: 'bypassPermissions',
};

/** claude-code-sdk mode → Coderix PermissionMode. Unknown strings default to 'ask'. */
export function toCorePermissionMode(mode: PermissionMode | undefined): CorePermissionMode {
  if (!mode) return CorePermissionMode.ASK;
  return TO_CORE[mode] ?? CorePermissionMode.ASK;
}

/** Coderix PermissionMode → claude-code-sdk mode string. */
export function fromCorePermissionMode(mode: CorePermissionMode): PermissionMode {
  return FROM_CORE[mode] ?? 'default';
}
