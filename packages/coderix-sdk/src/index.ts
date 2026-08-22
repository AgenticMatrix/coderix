/**
 * @coderix/sdk — Coderix SDK public API.
 *
 * Faithful mirror of claude-code-sdk: a `query()` async generator and a
 * `CoderixSDKClient` class, both yielding claude-code-sdk-shaped messages.
 */

export { query } from './query.js';
export type { QueryArgs } from './query.js';
export { CoderixSDKClient } from './client.js';
export type { ClientQueryArgs } from './client.js';

// Re-export the shared SDK schema (single source of truth lives in @coderix/core).
// Names that collide with @coderix/core's own exports are aliased there and
// re-exposed under their faithful claude-code-sdk names here.
export type {
  SdkPermissionMode as PermissionMode,
  SdkPermissionRule as PermissionRule,
  SdkHookEvent as HookEvent,
  SdkHookCallback as HookCallback,
  SdkOptions as Options,
  SystemPromptConfig,
  McpServerConfig,
  PermissionUpdate,
  PermissionResult,
  CanUseTool,
  SDKSystemMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKResultMessage,
  SDKResultUsage,
  SDKPartialAssistantMessage,
  SDKMessage,
  SDKInputMessage,
  QueryArguments,
  Query,
} from '@coderix/core';
