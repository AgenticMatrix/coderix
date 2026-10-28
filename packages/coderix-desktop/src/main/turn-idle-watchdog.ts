/**
 * turn-idle-watchdog.ts — abort a Claude Code turn only when the model itself
 * has gone silent.
 *
 * The spawned `claude` CLI streams events continuously while it works, so a
 * silent stream is usually a wedged subprocess. But silence is also normal
 * while a tool runs (a long build, a sub-agent Task) or while a background
 * task is pending, and those can legitimately outlast any fixed deadline. So
 * the timer runs only while the model owes a response, and is suspended the
 * moment ownership of the turn moves to a tool or a background task.
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/** Deadline for a model request that produces no output at all. */
export const TURN_IDLE_TIMEOUT_MS = 1_800_000;

export interface TurnIdleWatchdog {
  /** Feed every SDK message; may arm, suspend, or restart the deadline. */
  observe(msg: SDKMessage): void;
  /** Push the deadline out without changing state (a host-side wait is pending). */
  keepAlive(): void;
  /** Whether the deadline fired and aborted the turn. */
  readonly fired: boolean;
  /** Stop the timer for good — the turn has settled. */
  dispose(): void;
}

export function createTurnIdleWatchdog(
  onTimeout: () => void,
  timeoutMs: number = TURN_IDLE_TIMEOUT_MS,
): TurnIdleWatchdog {
  // The prompt has not been answered yet, so the model owes the first response
  // from the moment the turn starts.
  let awaitingModel = true;
  let fired = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const backgroundTasks = new Set<string>();

  const restart = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (disposed || fired || !awaitingModel || backgroundTasks.size > 0) return;
    timer = setTimeout(() => {
      timer = null;
      fired = true;
      onTimeout();
    }, timeoutMs);
  };

  const updateState = (msg: SDKMessage): void => {
    // Sub-agent traffic belongs to the Task tool that spawned it: from the
    // parent's point of view a tool — not the model — owns the turn.
    const parentToolUseId = (msg as unknown as { parent_tool_use_id?: string | null })
      .parent_tool_use_id;
    if (parentToolUseId != null) return;

    if (msg.type === 'system') {
      if (msg.subtype === 'status') {
        // "Request is out, no tokens yet"; compaction is a model call too.
        if (msg.status === 'requesting' || msg.status === 'compacting') {
          awaitingModel = true;
        }
      } else if (msg.subtype === 'task_started') {
        backgroundTasks.add(msg.task_id);
      } else if (msg.subtype === 'task_notification') {
        backgroundTasks.delete(msg.task_id);
      } else if (msg.subtype === 'task_updated') {
        // A settled task may only ever report through an update, not a
        // notification, so treat both as the end.
        const status = msg.patch?.status;
        if (status && status !== 'running' && status !== 'pending') {
          backgroundTasks.delete(msg.task_id);
        }
      }
      return;
    }

    switch (msg.type) {
      case 'assistant':
        // A response that calls tools hands the turn to them, so their silence
        // is not the model's. A text-only response is still expected to be
        // followed by the turn's terminal event.
        if (hasToolUse(msg)) awaitingModel = false;
        break;
      case 'user':
        // Tool results are fed back to the model, which now owes the next turn.
        if (hasToolResult(msg)) awaitingModel = true;
        break;
      case 'tool_progress':
        awaitingModel = false;
        break;
      case 'result':
        awaitingModel = false;
        break;
    }
  };

  // A CLI that never emits anything at all (wedged at startup, before the
  // first request) still has to be caught, so arm the deadline immediately.
  restart();

  return {
    observe(msg: SDKMessage): void {
      updateState(msg);
      restart();
    },
    keepAlive(): void {
      restart();
    },
    get fired(): boolean {
      return fired;
    },
    dispose(): void {
      disposed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

function hasToolResult(msg: SDKMessage): boolean {
  if (msg.type !== 'user') return false;
  const content = msg.message?.content;
  return (
    Array.isArray(content) && content.some((block) => block.type === 'tool_result')
  );
}

function hasToolUse(msg: SDKMessage): boolean {
  if (msg.type !== 'assistant') return false;
  const content = msg.message?.content;
  return Array.isArray(content) && content.some((block) => block.type === 'tool_use');
}
