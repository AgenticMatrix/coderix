import type { Message } from '../types.js';

/**
 * What the agent is doing right now, at the granularity the status bar shows.
 *
 * Three coarse phases, with the reason spelled out:
 *
 *   idle
 *   busy.<streaming|thinking|executing|compacting>   — we are producing
 *   wait.<llm|tool|background>                        — we are waiting on something
 *
 * `wait.llm`      the request is out and no token has come back yet
 * `wait.tool`     a tool call is registered but has not started producing
 *                 (approval pending, or queued behind the concurrency limit)
 * `wait.background` a background task outlived the turn and is still running
 */
export type AgentPhase =
  | 'idle'
  | 'busy.streaming'
  | 'busy.thinking'
  | 'busy.executing'
  | 'busy.compacting'
  | 'wait.llm'
  | 'wait.tool'
  | 'wait.background';

export type StatusPhase = 'busy' | 'wait' | 'idle';

export interface AgentPhaseInput {
  /** A failed turn shows its error instead of a phase. */
  error: string | null;
  /** Context compaction is running. */
  isCompacting: boolean;
  /** The LLM is outputting (message_start → message_stop). */
  isStreaming: boolean;
  /** The block currently receiving deltas is a thinking block. */
  thinkingInProgress: boolean;
  /** Whole-turn lifecycle: 'running' until the engine emits `done`. */
  turnStatus: 'idle' | 'running';
  /**
   * Something can still arrive for this turn. A dead turn (aborted without an
   * INTERRUPT, or a viewed sub-agent that stopped running) must not hold the
   * status at `wait` forever.
   */
  turnAlive: boolean;
  /** Last message of the MAIN agent (not the sub-agent in view). */
  lastMessage: Message | undefined;
  /** Sub-agents still running in the foreground — their tool call is executing. */
  runningForegroundAgents: number;
  /** Background agents (run_in_background) still running. */
  runningBackgroundAgents: number;
  /** `run_in_background` bash tasks still running. */
  runningBackgroundTasks: number;
}

function hasToolInState(message: Message | undefined, states: readonly string[]): boolean {
  return (
    message?.blocks.some(
      (block) => block.type === 'tool_use' && states.includes(block.state),
    ) ?? false
  );
}

/**
 * Derive the status-bar phase.
 *
 * Order matters:
 *   - a tool that is *executing* outranks text, because a step cannot stream
 *     while its tools run;
 *   - `wait.llm` is checked before `wait.background`: while the turn is live the
 *     main agent's wait is the interesting one, and background work only
 *     surfaces once the turn is over;
 *   - `idle` is the last resort — anything that can still produce output keeps
 *     the status out of it.
 */
export function deriveAgentPhase(input: AgentPhaseInput): AgentPhase {
  const {
    error,
    isCompacting,
    isStreaming,
    thinkingInProgress,
    turnStatus,
    turnAlive,
    lastMessage,
    runningForegroundAgents,
    runningBackgroundAgents,
    runningBackgroundTasks,
  } = input;

  if (error) return 'idle';
  if (isCompacting) return 'busy.compacting';

  if (isStreaming) {
    return thinkingInProgress ? 'busy.thinking' : 'busy.streaming';
  }

  if (hasToolInState(lastMessage, ['executing'])) return 'busy.executing';
  if (runningForegroundAgents > 0) return 'busy.executing';

  if (hasToolInState(lastMessage, ['pending'])) return 'wait.tool';

  if (turnStatus === 'running' && turnAlive) return 'wait.llm';

  if (runningBackgroundTasks > 0 || runningBackgroundAgents > 0) return 'wait.background';

  return 'idle';
}

/** Collapse a phase to the coarse state the status bar colors by. */
export function statusPhaseOf(phase: AgentPhase): StatusPhase {
  if (phase === 'idle') return 'idle';
  return phase.startsWith('busy.') ? 'busy' : 'wait';
}

/**
 * The activity label for the detail line above the prompt.
 *
 * The status bar only ever renders the coarse phase (`busy` / `wait` / `idle`);
 * the reason lives here, so both halves of the screen draw their wording from
 * this one table instead of keeping a vocabulary each.
 */
const AGENT_PHASE_LABELS: Record<AgentPhase, string | null> = {
  idle: null,
  'busy.thinking': 'Thinking',
  'busy.executing': 'Executing',
  'busy.streaming': 'Streaming',
  'busy.compacting': 'Compacting conversation',
  'wait.llm': 'Waiting for LLM response',
  'wait.tool': 'Waiting for tool',
  'wait.background': 'Background task running',
};

/** Label for the activity line, or null when there is nothing to show. */
export function agentPhaseLabel(phase: AgentPhase): string | null {
  return AGENT_PHASE_LABELS[phase];
}
