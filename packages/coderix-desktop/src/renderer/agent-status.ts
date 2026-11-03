import type { ChatMessage } from './store/types.js';
import type { StreamBlock } from './types.js';

/** Status shown in the bottom status bar. */
export type AgentStatus =
  | 'idle'
  | 'requesting'
  | 'thinking'
  | 'executing'
  | 'output'
  | 'compacting'
  | 'background'
  | 'waiting'
  | 'interrupted'
  | 'error';

export interface AgentStatusInput {
  /** Whole-turn lifecycle: true from the user message until the engine emits `done`. */
  isStreaming: boolean;
  /** Assistant message currently being streamed for the viewed session. */
  currentMessage: { blocks: StreamBlock[] } | null;
  /** Committed transcript of the viewed session. */
  messages: ChatMessage[];
  /** A permission or AskUserQuestion prompt is open — the agent is blocked on the user. */
  awaitingUser?: boolean;
  /**
   * Context compaction is running. It blocks the turn and can last minutes, so
   * it outranks every in-flight signal.
   */
  compacting?: boolean;
  /** The user stopped the previous turn and nothing has started since. */
  interrupted?: boolean;
  /** The last turn failed — show it instead of pretending the session is idle. */
  hasError?: boolean;
  /**
   * The engine handed a request to the model and no token has come back yet.
   * Set on the engine's request-start signal, cleared by the first block.
   */
  requesting?: boolean;
  /** Background tasks still running for this session. */
  runningTaskCount?: number;
  /** Background sub-agents still running (they outlive the turn too). */
  runningAgentCount?: number;
  /** Which status was showing before this render (bridges gaps between model steps). */
  previous?: AgentStatus;
}

function isActiveTool(block: StreamBlock): boolean {
  return block.type === 'tool_use' && (block.state === 'pending' || block.state === 'executing');
}

/**
 * True when a tool is still in flight for this conversation — in the message
 * being streamed, or in the last committed assistant turn (a tool whose step
 * already committed runs on while the turn is between model steps).
 *
 * Exposed because the sidebar row must read the same signal for a *backgrounded*
 * session: it has no status bar, and its cached blocks are the only evidence a
 * tool is executing. Without this a conversation flips from 忙碌 to 等待 the
 * moment the user clicks away, even though the bar still reads 工具执行中.
 */
export function hasActiveToolInConversation(
  currentMessage: { blocks: StreamBlock[] } | null | undefined,
  messages: readonly ChatMessage[],
): boolean {
  if ((currentMessage?.blocks ?? []).some(isActiveTool)) return true;
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  return (lastAssistant?.blocks ?? []).some(isActiveTool);
}

/**
 * Count the running sub-agents that belong to one conversation.
 *
 * The sub-agent store is process-wide — the side pane lists agents from every
 * conversation — so counting all of them would paint a finished conversation as
 * "background" while an unrelated conversation's agent drains. A sub-agent is
 * correlated to its conversation by the spawning `Agent`/`Task` tool call: the
 * store is keyed by that tool_use id (the canonical agent id), and the tool call
 * itself lives in the conversation's transcript. Agents whose spawn call is not
 * in this transcript belong to another conversation and must not leak in.
 */
export function countSessionRunningAgents(
  agents: Record<string, { status?: string; toolUseId?: string } | undefined>,
  sessionToolIds: ReadonlySet<string>,
): number {
  let count = 0;
  for (const [agentId, agent] of Object.entries(agents)) {
    if (agent?.status !== 'running') continue;
    // The key is already the canonical id; `toolUseId` is the same id carried
    // on the record and covers stores seeded before the key was canonicalized.
    if (sessionToolIds.has(agentId) || (agent.toolUseId && sessionToolIds.has(agent.toolUseId))) {
      count += 1;
    }
  }
  return count;
}

/**
 * Keep an active phase across the gap between two model steps. Anything else
 * (idle, a finished turn, a failure) means a request is out and nothing has
 * come back yet.
 */
function holdPrevious(previous: AgentStatus): AgentStatus {
  switch (previous) {
    case 'thinking':
    case 'executing':
    case 'output':
      return previous;
    default:
      return 'requesting';
  }
}

/**
 * Derive the status-bar badge from the turn lifecycle and the blocks in flight.
 *
 * Two signals matter and they are not interchangeable: `isStreaming` is the
 * *turn* (it spans every model step and every tool call), while `requesting` /
 * the in-flight blocks describe the *current model step*. Only the turn can end
 * a turn — a gap between steps is never "idle", which is why `idle` is reached
 * exclusively through `!isStreaming` with no background task left.
 *
 * The in-flight message alone is also not enough: `message_stop` commits a
 * model step and clears `currentMessage` *before* its tools execute. During that
 * gap the block list is empty, so the committed transcript is checked for
 * still-running tools, and the previous phase is kept while a step is between
 * requests.
 *
 * Three states are not derivable from the blocks at all and arrive as inputs:
 * `compacting` (a turn can spend minutes summarising itself, emitting no
 * blocks), `interrupted` (the turn is over but the user stopped it rather than
 * letting it finish), and `runningAgentCount` (background sub-agents outlive
 * the turn the same way background tasks do).
 */
export function deriveAgentStatus({
  isStreaming,
  currentMessage,
  messages,
  awaitingUser = false,
  compacting = false,
  interrupted = false,
  hasError = false,
  requesting = false,
  runningTaskCount = 0,
  runningAgentCount = 0,
  previous = 'idle',
}: AgentStatusInput): AgentStatus {
  // A failure outranks everything: whatever the blocks say, the turn did not
  // produce a usable answer.
  if (hasError) return 'error';
  if (compacting) return 'compacting';
  if (awaitingUser) return 'waiting';

  const blocks = currentMessage?.blocks ?? [];

  // An in-flight tool outranks the turn flag: tools whose input finished
  // streaming live in the transcript while they execute, and the row mirrors
  // this same check for backgrounded sessions (see hasActiveToolInConversation).
  if (hasActiveToolInConversation(currentMessage, messages)) return 'executing';

  if (isStreaming) {
    const last = blocks[blocks.length - 1];

    // A request is out and the model has produced nothing yet. Content always
    // wins, so a late request-start can never mask tokens that already arrived.
    if (!last && requesting) return 'requesting';

    if (last) {
      if (last.type === 'text') return 'output';
      if (last.type === 'thinking') return 'thinking';
      // tool_use / tool_result / system are step boundaries, not a thought —
      // they used to be reported as "thinking".
      return holdPrevious(previous);
    }

    // Between model steps with no explicit request signal (older engines, or a
    // few milliseconds before the signal arrives). Never regress to "idle".
    return holdPrevious(previous);
  }

  // The turn is over. An interrupt is the most recent thing that happened, so
  // it answers "why did this stop?" better than the work still running behind.
  if (interrupted) return 'interrupted';

  // A background task or sub-agent keeps the session busy even though the
  // answer already landed.
  return runningTaskCount + runningAgentCount > 0 ? 'background' : 'idle';
}
