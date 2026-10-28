import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createTurnIdleWatchdog, TURN_IDLE_TIMEOUT_MS } from '../turn-idle-watchdog.js';

const at = (msg: unknown): SDKMessage => msg as SDKMessage;

const assistant = (parentToolUseId: string | null, content: unknown[]): SDKMessage =>
  at({ type: 'assistant', message: { content }, parent_tool_use_id: parentToolUseId });

const toolResult = (parentToolUseId: string | null): SDKMessage =>
  at({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] },
    parent_tool_use_id: parentToolUseId,
  });

describe('createTurnIdleWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits 30 minutes before giving up on the model', () => {
    expect(TURN_IDLE_TIMEOUT_MS).toBe(1_800_000);
  });

  it('fires when the model request produces nothing', () => {
    const onTimeout = vi.fn();
    createTurnIdleWatchdog(onTimeout);

    vi.advanceTimersByTime(TURN_IDLE_TIMEOUT_MS - 1);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('keeps a slow but progressing request alive', () => {
    const onTimeout = vi.fn();
    const watchdog = createTurnIdleWatchdog(onTimeout);

    vi.advanceTimersByTime(TURN_IDLE_TIMEOUT_MS - 60_000);
    watchdog.observe(at({ type: 'stream_event', event: { type: 'content_block_delta' } }));

    vi.advanceTimersByTime(TURN_IDLE_TIMEOUT_MS - 1);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('stops counting while a tool runs', () => {
    const onTimeout = vi.fn();
    const watchdog = createTurnIdleWatchdog(onTimeout);

    watchdog.observe(assistant(null, [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} }]));
    vi.advanceTimersByTime(TURN_IDLE_TIMEOUT_MS * 10);

    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('starts counting again once a tool result goes back to the model', () => {
    const onTimeout = vi.fn();
    const watchdog = createTurnIdleWatchdog(onTimeout);

    watchdog.observe(assistant(null, [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} }]));
    watchdog.observe(toolResult(null));

    vi.advanceTimersByTime(TURN_IDLE_TIMEOUT_MS - 1);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('stops counting while a background task is pending', () => {
    const onTimeout = vi.fn();
    const watchdog = createTurnIdleWatchdog(onTimeout);

    watchdog.observe(at({ type: 'system', subtype: 'task_started', task_id: 'bg-1' }));
    vi.advanceTimersByTime(TURN_IDLE_TIMEOUT_MS * 5);
    expect(onTimeout).not.toHaveBeenCalled();

    watchdog.observe(
      at({ type: 'system', subtype: 'task_notification', task_id: 'bg-1', status: 'completed' }),
    );
    vi.advanceTimersByTime(TURN_IDLE_TIMEOUT_MS - 1);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('treats a settled task update as the end of the background task', () => {
    const onTimeout = vi.fn();
    const watchdog = createTurnIdleWatchdog(onTimeout);

    watchdog.observe(at({ type: 'system', subtype: 'task_started', task_id: 'bg-1' }));
    watchdog.observe(at({ type: 'system', subtype: 'task_updated', task_id: 'bg-1', patch: { status: 'completed' } }));

    vi.advanceTimersByTime(TURN_IDLE_TIMEOUT_MS);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('ignores sub-agent traffic so a long Task is never timed', () => {
    const onTimeout = vi.fn();
    const watchdog = createTurnIdleWatchdog(onTimeout);

    // The parent's Task tool is running; everything below belongs to the
    // sub-agent and must not arm the parent's deadline.
    watchdog.observe(assistant(null, [{ type: 'tool_use', id: 'task-1', name: 'Task', input: {} }]));
    watchdog.observe(assistant('task-1', [{ type: 'text', text: 'working' }]));
    watchdog.observe(toolResult('task-1'));

    vi.advanceTimersByTime(TURN_IDLE_TIMEOUT_MS * 10);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('keeps counting after a text-only response until the turn settles', () => {
    const onTimeout = vi.fn();
    const watchdog = createTurnIdleWatchdog(onTimeout);

    watchdog.observe(assistant(null, [{ type: 'text', text: 'done' }]));
    vi.advanceTimersByTime(TURN_IDLE_TIMEOUT_MS);

    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('disarms on result', () => {
    const onTimeout = vi.fn();
    const watchdog = createTurnIdleWatchdog(onTimeout);

    watchdog.observe(at({ type: 'result', subtype: 'success' }));
    vi.advanceTimersByTime(TURN_IDLE_TIMEOUT_MS * 10);

    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('extends the deadline while the host waits on the user', () => {
    const onTimeout = vi.fn();
    const watchdog = createTurnIdleWatchdog(onTimeout);

    vi.advanceTimersByTime(TURN_IDLE_TIMEOUT_MS - 60_000);
    watchdog.keepAlive();
    vi.advanceTimersByTime(TURN_IDLE_TIMEOUT_MS - 1);

    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('stops for good after dispose', () => {
    const onTimeout = vi.fn();
    const watchdog = createTurnIdleWatchdog(onTimeout);

    watchdog.dispose();
    watchdog.observe(toolResult(null));
    vi.advanceTimersByTime(TURN_IDLE_TIMEOUT_MS * 10);

    expect(onTimeout).not.toHaveBeenCalled();
    expect(watchdog.fired).toBe(false);
  });

  it('reports that it fired', () => {
    const watchdog = createTurnIdleWatchdog(() => {});

    expect(watchdog.fired).toBe(false);
    vi.advanceTimersByTime(TURN_IDLE_TIMEOUT_MS);
    expect(watchdog.fired).toBe(true);
  });
});
