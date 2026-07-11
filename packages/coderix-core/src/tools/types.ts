import type Anthropic from '@anthropic-ai/sdk';

/**
 * Tool Plugin Contract
 *
 * Every tool implements this interface.  The tool registry auto-discovers
 * plugins and builds lookup tables for schema, execution, and rendering.
 *
 * To add a new tool:
 *   1. cp -r tools/_template tools/my-tool
 *   2. Edit schema.ts, executor.ts, renderer.tsx
 *   3. Import and register in registry.ts
 */

// ── Schema ────────────────────────────────────────────────────────

export interface ToolMeta {
  riskLevel: 'safe' | 'mutation' | 'destructive';
  /** When true, this tool can execute concurrently with other safe tools. */
  isConcurrencySafe?: boolean;
  /** Whether this tool can be safely cancelled mid-execution.
   *  'cancel' = safe to abort and re-submit.
   *  'block'  = must complete before new messages are processed.
   *  Default: 'cancel' for safe tools, 'block' for mutation/destructive. */
  interruptBehavior?: 'cancel' | 'block';
}

/** Anthropic tool definition + our metadata. */
export type ToolSchema = Anthropic.Tool & { _meta: ToolMeta };

// ── Executor ──────────────────────────────────────────────────────

export interface ToolResult {
  content: string;
  isError: boolean;
  /** Execution duration in milliseconds. */
  duration?: number;
  /** Tool-specific structured metadata (e.g. stderr, exitCode, filePath). */
  metadata?: Record<string, unknown>;
}

export interface ExecutorOptions {
  cwd?: string;
  allowMutation?: boolean;
  maxOutput?: number;
  bashTimeout?: number;
  agentSpawn?: import('../core/types.js').AgentSpawnContext | undefined;
  /** Session ID for resolving the task list directory. */
  sessionId?: string;
  /** Switch permission mode (for enter/exit-plan-mode tools). */
  setPermissionMode?: (mode: string) => void;
  /** Get the current permission mode. */
  getPermissionMode?: () => import('../core/types.js').PermissionMode;
  /** Plan mode state (available during plan mode). */
  planModeState?: import('../core/types.js').PlanModeState;
  /** Override the generated agentId (used by swarm teammate spawn). */
  agentId?: string;
  /** Read CoreState snapshot (engine-level fields). */
  getCoreState?: () => import('../state/core-state.js').CoreState;
  /** Emit a tool request to the frontend (background tasks, agent registration). */
  emitToolRequest?: (req: import('../state/observable.js').ToolRequestEvent) => void;
  /** Track recently read files for post-compact restoration. */
  readFileTracker?: import('../core/read-file-tracker.js').ReadFileTracker;
}

/** Executor options with all core fields resolved (non-optional) but
 *  agentSpawn, sessionId, setPermissionMode kept optional. */
export type ResolvedExecutorOptions = Required<Omit<ExecutorOptions, 'agentSpawn' | 'sessionId' | 'setPermissionMode' | 'agentId' | 'getCoreState' | 'emitToolRequest' | 'getPermissionMode' | 'planModeState' | 'readFileTracker'>> &
  Pick<ExecutorOptions, 'agentSpawn' | 'sessionId' | 'setPermissionMode' | 'agentId' | 'getCoreState' | 'emitToolRequest' | 'getPermissionMode' | 'planModeState' | 'readFileTracker'>;

export type ToolExecutor = (
  input: Record<string, unknown>,
  options: ResolvedExecutorOptions,
) => Promise<ToolResult>;

// ── Plugin ────────────────────────────────────────────────────────

export interface ToolPlugin {
  /** Unique tool name matching the Anthropic schema name. */
  name: string;
  /** Anthropic tool definition + _meta. */
  schema: ToolSchema;
  /** Execution function. */
  executor: ToolExecutor;
  /** Extract a human-readable param summary from tool input, e.g. "src/App.tsx". */
  paramSummary?: (input: Record<string, unknown>) => string | undefined;
  /** When false, this tool is excluded from LLM tool definitions and execution. Default: true. */
  isEnabled?: () => boolean;
}
