/**
 * hook types.ts — Canonical type definitions for the pluggable hook system.
 *
 * Design rules:
 *  1. Add a new event: extend HookEvent union → add Context/Result interfaces
 *     → add the pair to HookContext/HookResult unions
 *  2. Add a new provider: implement HookProvider interface → register in providers/index
 *  3. Callers (query.ts) only depend on HookManager's public methods — never on
 *     HookContext/HookResult directly
 */

// ═══════════════════════════════════════════════════════════════════
// HookEvent — every lifecycle hook event the system supports
// ═══════════════════════════════════════════════════════════════════

export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'PostToolBatch'
  | 'onUserPromptSubmit'
  | 'onUserPromptExpansion'
  | 'onPermissionRequest'
  | 'onPermissionDenied'
  | 'onPreMessage'
  | 'onPostMessage'
  | 'onStop'
  | 'onStopFailure'
  | 'onPreCompact'
  | 'onPostCompact'
  | 'onNotification'
  | 'onSetup'
  | 'onConfigChange'
  | 'WorktreeCreate'
  | 'WorktreeRemove';

// ═══════════════════════════════════════════════════════════════════
// HookDefinition — one hook entry in a config file
// ═══════════════════════════════════════════════════════════════════

export interface HookMatch {
  /** Only trigger for a specific tool (e.g. "Bash") */
  toolName?: string;
  /** Only trigger under a specific permission mode */
  permissionMode?: string;
}

export interface HookDefinition {
  /** The lifecycle event this hook listens to */
  event: HookEvent;
  /** Shell command or script path to execute */
  command: string;
  /** Timeout in milliseconds (default: 60000) */
  timeout?: number;
  /** Extra environment variables passed to the child process */
  env?: Record<string, string>;
  /** Optional filter — skip execution when it doesn't match */
  match?: HookMatch;
}

// ═══════════════════════════════════════════════════════════════════
// HookConfig — top-level config file shape
// ═══════════════════════════════════════════════════════════════════

export interface HookConfig {
  hooks: HookDefinition[];
}

// ═══════════════════════════════════════════════════════════════════
// HookContext — union of event-specific context payloads.
// Each event gets its own interface with only the data it needs.
// ═══════════════════════════════════════════════════════════════════

export interface BaseHookContext {
  event: HookEvent;
  sessionId: string;
  cwd: string;
  timestamp: number;
}

export interface PreToolUseContext extends BaseHookContext {
  event: 'PreToolUse';
  toolName: string;
  toolInput: Record<string, unknown>;
}

export interface PostToolUseContext extends BaseHookContext {
  event: 'PostToolUse';
  toolName: string;
  toolInput: Record<string, unknown>;
  /** The tool result (or error content) */
  result: string;
  /** Whether the tool returned an error */
  isError: boolean;
}

export interface PostToolUseFailureContext extends BaseHookContext {
  event: 'PostToolUseFailure';
  toolName: string;
  toolInput: Record<string, unknown>;
  error: string;
}

export interface PostToolBatchContext extends BaseHookContext {
  event: 'PostToolBatch';
  /** Array of { toolName, isError, summary } */
  results: Array<{ toolName: string; isError: boolean; summary: string }>;
}

export interface UserPromptSubmitContext extends BaseHookContext {
  event: 'onUserPromptSubmit';
  prompt: string;
}

export interface UserPromptExpansionContext extends BaseHookContext {
  event: 'onUserPromptExpansion';
  prompt: string;
}

export interface PermissionRequestContext extends BaseHookContext {
  event: 'onPermissionRequest';
  toolName: string;
  toolInput: Record<string, unknown>;
  riskLevel: string;
  /** What the permission engine would do without hook intervention */
  defaultBehavior: string;
}

export interface PermissionDeniedContext extends BaseHookContext {
  event: 'onPermissionDenied';
  toolName: string;
  toolInput: Record<string, unknown>;
  reason: string;
}

export interface PreMessageContext extends BaseHookContext {
  event: 'onPreMessage';
  messageCount: number;
  systemPromptLength: number;
}

export interface PostMessageContext extends BaseHookContext {
  event: 'onPostMessage';
  messageCount: number;
  turnCount: number;
  /** Whether text output was produced this turn */
  hasOutput: boolean;
}

export interface StopContext extends BaseHookContext {
  event: 'onStop';
  turnCount: number;
}

export interface StopFailureContext extends BaseHookContext {
  event: 'onStopFailure';
  errorMessage: string;
  errorCode?: string;
  turnCount: number;
}

export interface PreCompactContext extends BaseHookContext {
  event: 'onPreCompact';
  messageCount: number;
  currentTokens: number;
  maxTokens: number;
  /** Compaction trigger: 'auto' (threshold exceeded) or 'manual' (/compact command). */
  strategy: 'auto' | 'manual';
}

export interface PostCompactContext extends BaseHookContext {
  event: 'onPostCompact';
  messageCountBefore: number;
  messageCountAfter: number;
  tokensSaved: number;
  /** The compaction strategy that was applied. */
  strategy: string;
  /** Token count before compaction. */
  preCompactTokens: number;
  /** Token count after compaction. */
  postCompactTokens: number;
}

export interface NotificationContext extends BaseHookContext {
  event: 'onNotification';
  message: string;
  /** Optional notification severity / category */
  severity?: 'info' | 'warn' | 'error';
}

export interface SetupContext extends BaseHookContext {
  event: 'onSetup';
}

export interface ConfigChangeContext extends BaseHookContext {
  event: 'onConfigChange';
  /** Key of the config that changed */
  key: string;
  /** New value (serialized as JSON string for large objects) */
  newValue: string;
}

export interface WorktreeCreateContext extends BaseHookContext {
  event: 'WorktreeCreate';
  /** The worktree slug/name being created */
  name: string;
}

export interface WorktreeRemoveContext extends BaseHookContext {
  event: 'WorktreeRemove';
  /** Absolute path to the worktree being removed */
  worktreePath: string;
}

export type HookContext =
  | PreToolUseContext
  | PostToolUseContext
  | PostToolUseFailureContext
  | PostToolBatchContext
  | UserPromptSubmitContext
  | UserPromptExpansionContext
  | PermissionRequestContext
  | PermissionDeniedContext
  | PreMessageContext
  | PostMessageContext
  | StopContext
  | StopFailureContext
  | PreCompactContext
  | PostCompactContext
  | NotificationContext
  | SetupContext
  | ConfigChangeContext
  | WorktreeCreateContext
  | WorktreeRemoveContext;

// ═══════════════════════════════════════════════════════════════════
// HookResult — union of event-specific return payloads
// ═══════════════════════════════════════════════════════════════════

export interface PreToolUseResult {
  blocked: boolean;
  reason?: string;
}

export interface PostToolUseResult {
  /** Optional summary override to display to user */
  summary?: string;
}

export interface PostToolUseFailureResult {
  /** Optional recovery suggestion */
  suggestion?: string;
}

export interface PostToolBatchResult {
  /** Optional batch summary */
  summary?: string;
}

export interface UserPromptSubmitResult {
  blocked: boolean;
  blockReason?: string;
  augmentedPrompt?: string;
}

export interface UserPromptExpansionResult {
  blocked: boolean;
  blockReason?: string;
  expandedPromptOverride?: string;
}

export interface PermissionRequestResult {
  permissionOverride?: 'auto-approve' | 'auto-deny';
}

export interface PermissionDeniedResult {
  /** Optional custom message to show the user */
  message?: string;
}

export interface PreMessageResult {
  blocked: boolean;
  blockReason?: string;
  modifiedSystemPrompt?: string;
  injectContext?: string;
}

export interface PostMessageResult {
  saveToMemory?: boolean;
}

export interface StopResult {
  shouldStop: boolean;
}

export interface StopFailureResult {
  /** Optional action: 'retry' to attempt one more turn */
  action?: 'retry' | 'abort';
}

export interface PreCompactResult {
  injectContext: string;
  /** Optional: override the compaction strategy */
  overrideStrategy?: string;
}

export interface PostCompactResult {
  /** Optional: extracted key info to preserve after compaction */
  preserveContext?: string;
}

export interface NotificationResult {
  /** Whether the notification was handled externally (suppress default) */
  handled?: boolean;
}

export interface SetupResult {
  /** Optional: additional system prompt fragment */
  systemPromptFragment?: string;
}

export interface ConfigChangeResult {
  /** Whether to trigger a restart / reload */
  restartRequired?: boolean;
}

export interface WorktreeCreateHookResult {
  /** The absolute path to the created worktree */
  worktreePath: string;
}

export interface WorktreeRemoveHookResult {
  /** Whether the worktree was successfully removed */
  removed: boolean;
}

export type HookResult =
  | PreToolUseResult
  | PostToolUseResult
  | PostToolUseFailureResult
  | PostToolBatchResult
  | UserPromptSubmitResult
  | UserPromptExpansionResult
  | PermissionRequestResult
  | PermissionDeniedResult
  | PreMessageResult
  | PostMessageResult
  | StopResult
  | StopFailureResult
  | PreCompactResult
  | PostCompactResult
  | NotificationResult
  | SetupResult
  | ConfigChangeResult
  | WorktreeCreateHookResult
  | WorktreeRemoveHookResult;

// ═══════════════════════════════════════════════════════════════════
// HookProvider — pluggable execution backend
// ═══════════════════════════════════════════════════════════════════

export interface HookProvider {
  /** Unique provider name for logging / debug */
  readonly name: string;

  /**
   * Execute a single hook with the given context.
   *
   * @returns The hook's structured result. On error or timeout,
   *          the provider should return an empty object (fail-open)
   *          and let the caller handle logging.
   */
  execute(
    hook: HookDefinition,
    context: HookContext,
  ): Promise<Partial<HookResult>>;
}

// ═══════════════════════════════════════════════════════════════════
// HookManagerConfig — constructor options
// ═══════════════════════════════════════════════════════════════════

export interface HookManagerConfig {
  /** Execution providers (default: [ScriptProvider]) */
  providers?: HookProvider[];
  /** Path to global hooks config (default: ~/.coderix/hooks.json) */
  globalConfigPath?: string;
  /** Path to project hooks config (default: ./.coder/hooks.json) */
  projectConfigPath?: string;
  /** Whether to auto-load config on construction */
  autoLoad?: boolean;
}
