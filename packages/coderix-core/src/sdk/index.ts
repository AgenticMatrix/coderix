/**
 * sdk/index.ts — Coderix SDK public types & helpers (shared schema).
 *
 * The in-process TypeScript SDK and the CLI `--sdk` stream-json mode
 * both consume this module so the wire schema has a single source of truth.
 */

export type {
  PermissionMode,
  SystemPromptConfig,
  McpServerConfig,
  PermissionRule,
  PermissionUpdate,
  PermissionResultAllow,
  PermissionResultDeny,
  PermissionResultAsk,
  PermissionResult,
  CanUseTool,
  HookEvent,
  HookCallback,
  SDKSystemMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKResultMessage,
  SDKResultUsage,
  SDKResultSubtype,
  SDKPartialAssistantMessage,
  SDKMessage,
  SDKInputMessage,
  Options,
  QueryArguments,
  Query,
} from './types.js';

export {
  mapEngineEventToSdkMessage,
  buildInitMessage,
  buildResultMessage,
} from './mapper.js';
export type {
  SdkMapperContext,
  SdkInitInput,
  SdkResultInput,
} from './mapper.js';

export { toCorePermissionMode, fromCorePermissionMode } from './permission-mode.js';
