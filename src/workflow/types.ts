/**
 * Workflow runtime types — pure data structures with no agent/tool dependencies.
 *
 * The workflow runtime executes a sandboxed JavaScript script that orchestrates
 * multiple sub-agents. These types define the contract between the runtime layer
 * and the tool-plugin layer (src/agents/workflow/).
 */

// ---------------------------------------------------------------------------
// Metadata (parsed from `export const meta = { ... }`)
// ---------------------------------------------------------------------------

/** Phase descriptor — shown in progress UI. */
export interface PhaseDescriptor {
  title: string;
  /** Optional detail explaining what this phase does. */
  detail?: string;
}

/** Parsed from the script's `export const meta = { ... }` block. */
export interface WorkflowMeta {
  name: string;
  description: string;
  /** Optional phase list — must match phase() calls in the script body. */
  phases?: PhaseDescriptor[];
}

// ---------------------------------------------------------------------------
// Agent invocation
// ---------------------------------------------------------------------------

/** JSON Schema subset supported by the built-in validator. */
export interface JsonSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  description?: string;
  additionalProperties?: boolean;
}

/** Options passed to the agent() primitive. */
export interface AgentOptions {
  /** JSON Schema for structured output — the sub-agent must call a
   *  `structured_output` tool with JSON matching this schema. */
  schema?: JsonSchema;
  /** Optional model override (e.g. "sonnet", "opus"). */
  model?: string;
  /** Reasoning effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Run the sub-agent in an isolated git worktree. */
  isolation?: 'worktree';
  /** Sub-agent type to use (default: 'general-purpose'). */
  agentType?: string;
  /** Display label for progress UI. */
  label?: string;
}

// ---------------------------------------------------------------------------
// Progress tracking
// ---------------------------------------------------------------------------

export interface PhaseProgress {
  title: string;
  agentCount: number;
  completedCount: number;
}

// ---------------------------------------------------------------------------
// Checkpoint (resume)
// ---------------------------------------------------------------------------

export interface CheckpointEntry {
  /** 0-based index of the agent() call in the execution sequence. */
  index: number;
  /** The prompt string for this agent call. */
  prompt: string;
  /** Hash of the prompt — used as cache key component. */
  promptHash: string;
  /** Cached result string. */
  result: string;
  /** Unix timestamp (ms) when this checkpoint was written. */
  timestamp: number;
}

export interface CheckpointData {
  /** Script hash (SHA-256 of script + serialized args). */
  scriptHash: string;
  /** Cached agent results indexed by call sequence. */
  entries: CheckpointEntry[];
}

// ---------------------------------------------------------------------------
// Runtime context (injected into the sandbox as globals)
// ---------------------------------------------------------------------------

/** Factory signature for the agent() primitive. */
export type AgentFactory = (
  prompt: string,
  opts?: AgentOptions,
) => Promise<string>;

/** Factory signature for the parallel() primitive. */
export type ParallelFactory = (
  thunks: Array<() => Promise<unknown>>,
) => Promise<(unknown | null)[]>;

/** Factory signature for the pipeline() primitive. */
export type PipelineFactory = (
  items: unknown[],
  ...stages: Array<(prev: unknown, index: number) => Promise<unknown>>
) => Promise<(unknown | null)[]>;

/** Context injected as globals into the sandboxed script. */
export interface SandboxGlobals {
  agent: AgentFactory;
  parallel: ParallelFactory;
  pipeline: PipelineFactory;
  phase: (title: string) => void;
  log: (message: string) => void;
  args: Record<string, unknown> | undefined;
  /** Token budget info — injected when the user sets a "+500k"-style target. */
  budget: {
    total: number | null;
    spent: () => number;
    remaining: () => number;
  };
}

// ---------------------------------------------------------------------------
// Execution result
// ---------------------------------------------------------------------------

export interface WorkflowExecutionResult {
  /** String outputs from the script (return value, log messages, errors). */
  results: string[];
  /** Phase progress snapshots. */
  phases: PhaseProgress[];
  /** Total agent calls made (for quota tracking). */
  totalAgentCount: number;
  /** Whether the script returned structured data. */
  structuredResult?: unknown;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class WorkflowScriptError extends Error {
  constructor(
    message: string,
    public readonly code: 'PARSE_ERROR' | 'RUNTIME_ERROR' | 'AGENT_LIMIT' | 'SANDBOX_VIOLATION',
    public override readonly cause?: Error,
  ) {
    super(message);
    this.name = 'WorkflowScriptError';
  }
}
