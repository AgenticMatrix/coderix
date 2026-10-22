import type { ChatMessage } from './store/types.js';
import type { StreamBlock } from './types.js';

/** Status shown in the bottom status bar. */
export type AgentStatus = 'idle' | 'thinking' | 'executing' | 'output' | 'waiting';

export interface AgentStatusInput {
  /** Whole-turn lifecycle: true from the user message until the engine emits `done`. */
  isStreaming: boolean;
  /** Assistant message currently being streamed for the viewed session. */
  currentMessage: { blocks: StreamBlock[] } | null;
  /** Committed transcript of the viewed session. */
  messages: ChatMessage[];
  /** A permission or AskUserQuestion prompt is open — the agent is blocked on the user. */
  awaitingUser?: boolean;
  /** Which status was showing before this render (bridges gaps between model steps). */
  previous?: AgentStatus;
}

function isActiveTool(block: StreamBlock): boolean {
  return block.type === 'tool_use' && (block.state === 'pending' || block.state === 'executing');
}

/**
 * Derive the status-bar badge from the turn lifecycle and the blocks in flight.
 *
 * The in-flight message alone is not enough: `message_stop` commits a model step
 * and clears `currentMessage` *before* its tools execute (and before `done` ends
 * the turn). During that gap the streaming block list is empty, so trusting it
 * alone reported "thinking" while a tool was running, and briefly "thinking"
 * again after the final answer had already been rendered. The committed
 * transcript is therefore checked for still-running tools, and the previous
 * phase is kept while the turn is alive but between model steps.
 */
export function deriveAgentStatus({
  isStreaming,
  currentMessage,
  messages,
  awaitingUser = false,
  previous = 'idle',
}: AgentStatusInput): AgentStatus {
  if (awaitingUser) return 'waiting';

  const blocks = currentMessage?.blocks ?? [];
  if (blocks.some(isActiveTool)) return 'executing';

  // Tools whose input finished streaming live in the transcript while they run.
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  if (lastAssistant?.blocks.some(isActiveTool)) return 'executing';

  if (!isStreaming) return 'idle';

  const last = blocks[blocks.length - 1];
  if (!last) {
    // Between model steps (the previous step was just committed) or before the
    // first token. Never regress to "idle" here — only `done` ends the turn.
    return previous === 'idle' || previous === 'waiting' ? 'thinking' : previous;
  }
  if (last.type === 'text') return 'output';
  return 'thinking';
}
