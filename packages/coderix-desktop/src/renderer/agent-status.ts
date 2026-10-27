import type { ChatMessage } from './store/types.js';
import type { StreamBlock } from './types.js';

/** Status shown in the bottom status bar. */
export type AgentStatus =
  | 'idle'
  | 'requesting'
  | 'thinking'
  | 'executing'
  | 'output'
  | 'background'
  | 'waiting'
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
  /** The last turn failed — show it instead of pretending the session is idle. */
  hasError?: boolean;
  /**
   * The engine handed a request to the model and no token has come back yet.
   * Set on the engine's request-start signal, cleared by the first block.
   */
  requesting?: boolean;
  /** Background tasks still running for this session. */
  runningTaskCount?: number;
  /** Which status was showing before this render (bridges gaps between model steps). */
  previous?: AgentStatus;
}

function isActiveTool(block: StreamBlock): boolean {
  return block.type === 'tool_use' && (block.state === 'pending' || block.state === 'executing');
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
 */
export function deriveAgentStatus({
  isStreaming,
  currentMessage,
  messages,
  awaitingUser = false,
  hasError = false,
  requesting = false,
  runningTaskCount = 0,
  previous = 'idle',
}: AgentStatusInput): AgentStatus {
  // A failure outranks everything: whatever the blocks say, the turn did not
  // produce a usable answer.
  if (hasError) return 'error';
  if (awaitingUser) return 'waiting';

  const blocks = currentMessage?.blocks ?? [];
  if (blocks.some(isActiveTool)) return 'executing';

  // Tools whose input finished streaming live in the transcript while they run.
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  if (lastAssistant?.blocks.some(isActiveTool)) return 'executing';

  if (isStreaming) {
    const last = blocks[blocks.length - 1];

    // A request is out and the model has produced nothing yet. Content always
    // wins, so a late request-start can never mask tokens that already arrived.
    if (!last && requesting) return 'requesting';

    if (last) return last.type === 'text' ? 'output' : 'thinking';

    // Between model steps with no explicit request signal (older engines, or a
    // few milliseconds before the signal arrives). Never regress to "idle".
    return previous === 'idle' || previous === 'waiting' || previous === 'background'
      ? 'requesting'
      : previous;
  }

  // The turn is over. A background task keeps the session busy even though the
  // answer already landed.
  return runningTaskCount > 0 ? 'background' : 'idle';
}
