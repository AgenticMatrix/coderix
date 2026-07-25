/**
 * Core shared types — aggregated from Coderix's @coder/shared.
 *
 * Only the types actually imported by query-engine.ts and query.ts are included.
 */

// ── Message types ─────────────────────────────────────────────────────

export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'image' | 'thinking';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | ContentBlock[];
  is_error?: boolean;
  source?: ImageSource;
  thinking?: string;
  signature?: string;
}

export interface ImageSource {
  type: 'base64';
  media_type: string;
  data: string;
}

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string | ContentBlock[];
}

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface TextDelta {
  type: 'text_delta';
  text: string;
}

export interface InputJsonDelta {
  type: 'input_json_delta';
  partial_json: string;
}

export interface ThinkingDelta {
  type: 'thinking_delta';
  thinking: string;
}

// ── Completion / Stream types ─────────────────────────────────────────

export type StopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'refusal';

export interface CompletionUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  totalCost?: number;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | TextBlock[];
  is_error?: boolean;
  /** Execution duration in milliseconds. */
  duration?: number;
  /** Tool-specific structured metadata. */
  metadata?: Record<string, unknown>;
}

export interface AssistantMessage extends Message {
  role: 'assistant';
  stopReason: StopReason;
  usage: CompletionUsage;
  model: string;
  readonly toolUseBlocks: ToolUseBlock[];
}

export interface UserMessage extends Message {
  role: 'user';
  content: string | ContentBlock[];
}

// ── Stream events ─────────────────────────────────────────────────────

export interface ContentBlockStartEvent {
  type: 'content_block_start';
  index: number;
  content_block: ContentBlock;
}

export interface ContentBlockDeltaEvent {
  type: 'content_block_delta';
  index: number;
  delta: TextDelta | InputJsonDelta | ThinkingDelta;
}

export interface ContentBlockStopEvent {
  type: 'content_block_stop';
  index: number;
}

export interface MessageStartEvent {
  type: 'message_start';
  message: { model: string; usage?: CompletionUsage };
}

export interface MessageDeltaEvent {
  type: 'message_delta';
  delta: { stop_reason: StopReason | null; usage?: CompletionUsage };
}

export interface MessageStopEvent {
  type: 'message_stop';
  message: AssistantMessage;
}

export interface PingEvent {
  type: 'ping';
}

export interface CostUpdateEvent {
  type: 'cost_update';
  totalCost: number;
}

export type StreamEvent =
  | ContentBlockStartEvent
  | ContentBlockDeltaEvent
  | ContentBlockStopEvent
  | MessageStartEvent
  | MessageDeltaEvent
  | MessageStopEvent
  | PingEvent
  | CostUpdateEvent;

// ── Query message (yielded by agent loop) ─────────────────────────────

export interface DeferredPermission {
  toolName: string;
  command: string;
  description: string;
  toolUseId: string;
  resolve: (allowed: boolean) => void;
  promise: Promise<boolean>;
}

export interface UserQuestion {
  header: string;
  question: string;
  options?: Array<{ label: string; description: string }>;
  multiSelect?: boolean;
}

export interface DeferredQuestion {
  toolName: string;
  toolUseId: string;
  questions: UserQuestion[];
  resolve: (answers: Record<string, string | string[]>) => void;
  promise: Promise<Record<string, string | string[]>>;
}

export interface ToolProgress {
  toolName?: string;
  toolUseId?: string;
  status?: 'started' | 'running' | 'completed';
  message?: string;
  percent?: number;
  is_error?: boolean;
  /** Cumulative session token usage (yielded every turn for real-time cost tracking). */
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
    totalTokens?: number;
  };
}

export interface CompactMetadata {
  beforeTokens: number;
  afterTokens: number;
  strategy: 'none' | 'snip' | 'auto' | 'summarize' | 'time_based' | 'cache_edit' | 'token_snip';
}

export class AgentError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean = false,
    public override readonly cause?: Error,
  ) {
    super(message);
    this.name = 'AgentError';
  }
}

export type QueryMessage =
  | { type: 'stream_event'; event: StreamEvent }
  | { type: 'assistant'; message: AssistantMessage }
  | { type: 'user'; message: UserMessage }
  | { type: 'system'; subtype: 'compact_boundary'; compactMetadata: CompactMetadata }
  | { type: 'system'; subtype: 'error'; error: AgentError }
  | { type: 'system'; subtype: 'progress'; data: ToolProgress }
  | { type: 'system'; subtype: 'tool_completed'; data: { toolUseId: string; duration?: number; content: string | TextBlock[]; isError?: boolean; metadata?: Record<string, unknown> } }
  | { type: 'system'; subtype: 'permission_required'; deferred: DeferredPermission }
  | { type: 'system'; subtype: 'question_required'; deferred: DeferredQuestion };

// ── Permission ────────────────────────────────────────────────────────

export enum PermissionMode {
  PLAN = 'plan',
  ASK = 'ask',
  AUTO = 'auto',
  LOW = 'low',
}

/** State tracking for plan mode across turns. */
export interface PlanModeState {
  /** The mode before entering plan mode — restored on exit. */
  prePlanMode: PermissionMode;
  /** Absolute path to the current plan file. */
  planFilePath: string;
  /** Word-slug filename stem (e.g. "brave-tiger"). */
  planFileSlug: string;
  /** Turns executed while in plan mode (for attachment throttling). */
  turnCount: number;
  /** Whether plan mode has been exited at least once in this session. */
  hasExitedPlanMode: boolean;
  /** One-shot flag: inject exit attachment on the next turn. */
  needsExitAttachment: boolean;
}

export enum RiskLevel {
  SAFE = 'safe',
  MUTATION = 'mutation',
  DESTRUCTIVE = 'destructive',
}

// ── Agent Definitions ─────────────────────────────────────────────────

/** Where an agent definition originates in the priority chain. */
export type SettingSource = 'built-in' | 'plugin' | 'userSettings' | 'projectSettings';

/** Describes which tools an agent type is allowed to use. */
export type AgentToolFilter = string[] | '*';

/** Priority order for source-based override. Higher index = higher priority. */
export const SETTING_SOURCE_PRIORITY: Record<SettingSource, number> = {
  'built-in': 0,
  plugin: 1,
  userSettings: 2,
  projectSettings: 3,
};

/** Fields shared by all agent definition types. */
export interface BaseAgentDefinition {
  agentType: string;
  /** Description for the LLM — when to use this agent type. */
  whenToUse: string;
  /** Allowed tools. '*' means all tools (minus disallowedTools). */
  tools?: AgentToolFilter;
  /** Tools explicitly forbidden for this agent type. */
  disallowedTools?: string[];
  /** Optional model override. */
  model?: string;
  /** Permission mode override for the sub-agent. */
  permissionMode?: string;
  /** Maximum agentic turns before forced stop. */
  maxTurns?: number;
  /** Context budget in tokens (default: 120k). */
  contextBudget?: number;
  /** Skill names to preload for this agent. */
  skills?: string[];
  /** Prepend to the first user turn when spawned. */
  initialPrompt?: string;
  /** Always run as a background task. */
  background?: boolean;
  /** Run in an isolated git worktree. */
  isolation?: 'worktree';
  /** Display color for this agent in the TUI. */
  color?: string;
  /** Memory scope for per-agent persistent memory injection. */
  memory?: 'user' | 'project' | 'local';
  /** Critical system reminder injected into every turn for this agent type. */
  criticalSystemReminder?: string;
}

/** A built-in agent definition shipped with the application. */
export interface BuiltInAgentDefinition extends BaseAgentDefinition {
  source: 'built-in';
  baseDir: 'built-in';
  getSystemPrompt: () => string;
}

/** A user- or project-defined agent loaded from a .md / .json file. */
export interface CustomAgentDefinition extends BaseAgentDefinition {
  source: 'userSettings' | 'projectSettings';
  /** Original filename (without extension). */
  filename?: string;
  /** Source directory where the definition was found. */
  baseDir?: string;
  getSystemPrompt: () => string;
}

/** An agent provided by a plugin (future). */
export interface PluginAgentDefinition extends BaseAgentDefinition {
  source: 'plugin';
  /** Plugin name that registered this agent. */
  plugin: string;
  getSystemPrompt: () => string;
}

/**
 * Union of all agent definition types.
 * Discriminated on `source` for type narrowing via the guards below.
 */
export type AgentDefinition =
  | BuiltInAgentDefinition
  | CustomAgentDefinition
  | PluginAgentDefinition;

/** Type guard: returns true for built-in agent definitions. */
export function isBuiltInAgent(agent: AgentDefinition): agent is BuiltInAgentDefinition {
  return agent.source === 'built-in';
}

/** Type guard: returns true for custom (user/project) agent definitions. */
export function isCustomAgent(agent: AgentDefinition): agent is CustomAgentDefinition {
  return agent.source === 'userSettings' || agent.source === 'projectSettings';
}

/** Type guard: returns true for plugin-provided agent definitions. */
export function isPluginAgent(agent: AgentDefinition): agent is PluginAgentDefinition {
  return agent.source === 'plugin';
}

/** The result returned by the agent definition loader. */
export interface AgentDefinitionsResult {
  activeAgents: AgentDefinition[];
  allAgents: AgentDefinition[];
  failedFiles?: Array<{ path: string; error: string }>;
}

// ── Tool ──────────────────────────────────────────────────────────────

export interface AgentSpawnContext {
  callModel: (params: import('./query.js').CallModelParams) => AsyncGenerator<StreamEvent | AssistantMessage>;
  toolRegistry: import('./tool-registry.js').ToolRegistry;
  sessionManager: import('./session.js').SessionManager;
  subAgentRegistry: import('./subagent-registry.js').SubAgentRegistry;
  hookManager?: import('../hooks/index.js').HookManager;
  systemPromptAssembler: import('./system-prompt.js').SystemPromptAssembler;
  agentRegistry: import('./agent-registry.js').AgentRegistry;
  /** The fully rendered system prompt from the parent agent.
   *  Threaded through for fork sub-agents to share prompt cache with parent. */
  renderedSystemPrompt?: import('./system-prompt.js').SystemPrompt;
}

export interface ToolContext {
  sessionId: string;
  cwd: string;
  signal?: AbortSignal;
  env?: Record<string, string>;
  timeoutMs?: number;
  agentSpawn?: AgentSpawnContext;
  /** Anthropic tool_use_id — used to match renderer to registry entry. */
  toolUseId?: string;
  /** Switch permission mode (for enter/exit-plan-mode tools). */
  setPermissionMode?: (mode: string) => void;
  /** Plan mode state — populated when plan mode is active. */
  planModeState?: PlanModeState;
  /** Get the current permission mode. */
  getPermissionMode?: () => PermissionMode;
  /** Read CoreState snapshot (engine-level fields). */
  getCoreState?: () => import('../state/core-state.js').CoreState;
  /** Emit a tool request to the frontend (background tasks, agents). */
  emitToolRequest?: (req: import('../state/observable.js').ToolRequestEvent) => void;
  /** Track recently read files for post-compact restoration. */
  readFileTracker?: import('./read-file-tracker.js').ReadFileTracker;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  riskLevel?: RiskLevel;
  isConcurrencySafe?: boolean;
  /** Maximum tool result size in characters before persistence (default: 50_000).
   *  Infinity disables persistence for this tool. */
  maxResultSizeChars?: number;
  /** Whether this tool can be safely cancelled mid-execution.
   *  'cancel' = safe to abort and re-submit.
   *  'block'  = must complete before new messages are processed.
   *  Default: derived from riskLevel. */
  interruptBehavior?: 'cancel' | 'block';
}

export interface ToolExecutionResult {
  content: string;
  isError: boolean;
  truncated?: boolean;
  /** Execution duration in milliseconds. */
  duration?: number;
  /** Tool-specific structured metadata carried through to the result renderer. */
  metadata?: Record<string, unknown>;
}

// ── Session ───────────────────────────────────────────────────────────

export type SessionStatus = 'active' | 'paused' | 'completed' | 'error' | 'archived';

export interface TokenUsageSummary {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  totalCost?: number;
  totalTokens?: number;
}

export interface SessionMetadata {
  tags?: string[];
  notes?: string;
  filesModified?: string[];
  toolsUsed?: string[];
  /** Sub-agent IDs spawned during this session. Used to restore on resume. */
  subAgentIds?: string[];
}

// ── Session filter / summary ──────────────────────────────────────────

export interface SessionFilter {
  status?: SessionStatus;
  model?: string;
  provider?: string;
  since?: Date;
  limit?: number;
  offset?: number;
}

export interface SessionSummary {
  id: string;
  title: string;
  status: SessionStatus;
  turnCount: number;
  totalCost: number;
  createdAt: Date;
  updatedAt: Date;
  model: string;
  /** First 60 chars of the latest user message for preview. */
  lastUserPreview?: string;
  /** Generated display title from first user message. */
  displayTitle?: string;
  /** Full text of the first user message (for LLM title summarization). */
  firstUserText?: string;
}

export interface Session {
  id: string;
  title: string;
  status: SessionStatus;
  messages: Message[];
  turnCount: number;
  totalCost: number;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  cwd: string;
  baseCommit?: string;
  parentSessionId?: string;
  model: string;
  provider: string;
  tokenUsage: TokenUsageSummary;
  metadata: SessionMetadata;
}

// ── JSONL Entry types (append-only session storage) ────────────────────

export type JsonlEntryType =
  | 'user'
  | 'assistant'
  | 'system'
  | 'title'
  | 'agent-metadata'
  | 'summary';

export interface JsonlEntryBase {
  type: JsonlEntryType;
  uuid: string;
  parentUuid: string | null;
  timestamp: number;
}

export interface UserEntry extends JsonlEntryBase {
  type: 'user';
  message: Message;
}

export interface AssistantEntry extends JsonlEntryBase {
  type: 'assistant';
  message: Message;
}

export interface SystemEntry extends JsonlEntryBase {
  type: 'system';
  message: Message;
}

export interface TitleEntry {
  type: 'title';
  title: string;
}

export interface AgentMetadataEntry {
  type: 'agent-metadata';
  agentId: string;
  agentType: string;
  prompt: string;
  timestamp: number;
  description?: string;
  toolUseId?: string;
  model?: string;
}

export interface SummaryEntry {
  type: 'summary';
  content: string;
}

export interface ParentSessionEntry {
  type: 'parent-session';
  parentSessionId: string;
}

export type SessionEntry =
  | UserEntry
  | AssistantEntry
  | SystemEntry
  | TitleEntry
  | AgentMetadataEntry
  | SummaryEntry
  | ParentSessionEntry;

/** Transcript message entries only — those that form the parentUuid chain. */
export type TranscriptEntry = UserEntry | AssistantEntry | SystemEntry;

export function isTranscriptEntry(entry: SessionEntry): entry is TranscriptEntry {
  return entry.type === 'user' || entry.type === 'assistant' || entry.type === 'system';
}
