/**
 * hooks/index.ts — Public API for the pluggable hook system.
 *
 * Re-exports HookManager from the new modular implementation.
 * All callers that previously imported from '../core/hooks.js'
 * should now import from '../hooks/index.js'.
 */

export { HookManager } from './manager.js';
export { HookLoader } from './loader.js';
export { ScriptProvider } from './providers/script.js';
export type { HookProvider } from './providers/base.js';

// Re-export all types for consumers that need them
export type {
  HookEvent,
  HookDefinition,
  HookConfig,
  HookMatch,
  HookContext,
  HookResult,
  HookProvider as IHookProvider,
  HookManagerConfig,
  BaseHookContext,
  PreToolUseContext,
  PostToolUseContext,
  PermissionRequestContext,
  PermissionRequestResult,
  PreToolUseResult,
  StopResult,
  PreCompactResult,
} from './types.js';
