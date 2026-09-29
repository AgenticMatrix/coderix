import type { StreamBlock } from '../../../types';
import type { ChatMessage } from '../../../store/types';

/**
 * Trajectory rendering model — mirrors ZCode's live-chat turn layout.
 *
 * A conversation is grouped into "calls" (one user turn → one assistant
 * response). Each call is split into:
 *   - `userBlocks`   — the user's message (always visible)
 *   - `workRows`     — the agent's "work" (thinking + tool calls), collapsed
 *                      behind an "已工作 X 分 Y 秒" header by default
 *   - `answerBlocks` — the final assistant text (always visible)
 */

export type TrajectoryWorkKind = 'reasoning' | 'tool' | 'text';

export interface TrajectoryWorkRow {
  /** Stable key used by search, e.g. `${callKey}:work:reasoning:0`. */
  key: string;
  kind: TrajectoryWorkKind;
  /** For `tool`, the first block is the tool_use (result attached when matched). */
  blocks: StreamBlock[];
  /** True only while this specific row is still streaming (the active thinking
   *  block mid-turn). Finished rows render their completed state — a done LLM
   *  call must not still show the "思考中" spinner. */
  isStreaming?: boolean;
  /** Wall-clock thinking duration for a reasoning row, computed from the
   *  block's `startedAt`/`endedAt`. Per-turn — each LLM call counts its own
   *  time independently rather than sharing the whole call's duration. */
  durationMs?: number;
}

export interface TrajectoryCall {
  key: string;
  userBlocks: StreamBlock[];
  workRows: TrajectoryWorkRow[];
  answerBlocks: StreamBlock[];
  durationMs?: number;
  isStreaming?: boolean;
}

interface FlatEntry {
  id: string;
  role: 'user' | 'assistant' | 'system';
  blocks: StreamBlock[];
  timestamp?: number;
  streaming: boolean;
}

interface RawCall {
  key: string;
  userBlocks: StreamBlock[];
  outputBlocks: StreamBlock[];
  startTime?: number;
  endTime?: number;
  isStreaming: boolean;
}

function isBackgroundNotification(entry: FlatEntry): boolean {
  return (
    entry.role === 'user' &&
    entry.blocks.some(
      (b) =>
        b.type === 'text' &&
        typeof b.content === 'string' &&
        b.content.startsWith('<background-agent-notifications>'),
    )
  );
}

/**
 * Group the flat message list (plus the in-flight streaming message) into
 * ZCode-style calls.
 *
 * - A real user turn (a user message carrying at least one non-tool_result
 *   block) starts a new call.
 * - Tool results ride on user-role messages; they belong to the current call's
 *   work (they are the results of the assistant's tools).
 * - The streaming message is a synthetic assistant entry appended last, keyed
 *   by the same call as the committed assistant message, so the call key stays
 *   stable across the delta → commit transition.
 */
export function buildTrajectoryCalls(
  messages: ChatMessage[],
  streamCurrentMessage: { id: string; blocks: StreamBlock[] } | null,
): TrajectoryCall[] {
  const entries: FlatEntry[] = messages.map((m) => ({
    id: m.id,
    role: m.role,
    blocks: m.blocks,
    timestamp: m.timestamp,
    streaming: false,
  }));
  if (streamCurrentMessage) {
    entries.push({
      id: streamCurrentMessage.id,
      role: 'assistant',
      blocks: streamCurrentMessage.blocks,
      timestamp: Date.now(),
      streaming: true,
    });
  }

  const rawCalls: RawCall[] = [];
  let current: RawCall | null = null;

  const newCall = (entry: FlatEntry): RawCall => {
    const call: RawCall = {
      key: entry.id,
      userBlocks: [],
      outputBlocks: [],
      startTime: entry.timestamp,
      endTime: entry.timestamp,
      isStreaming: entry.streaming,
    };
    rawCalls.push(call);
    current = call;
    return call;
  };

  for (const entry of entries) {
    if (isBackgroundNotification(entry)) continue;

    const isUserTurn =
      entry.role === 'user' && entry.blocks.some((b) => b.type !== 'tool_result');
    const isToolResultHolder =
      entry.role === 'user' && entry.blocks.every((b) => b.type === 'tool_result');

    if (isUserTurn) {
      const call = newCall(entry);
      call.userBlocks.push(...entry.blocks.filter((b) => b.type !== 'tool_result'));
      continue;
    }

    const call = current ?? newCall(entry);
    if (entry.streaming) call.isStreaming = true;
    if (entry.timestamp !== undefined) call.endTime = entry.timestamp;

    if (isToolResultHolder || entry.role === 'assistant') {
      call.outputBlocks.push(...entry.blocks);
    } else if (entry.role === 'system') {
      call.userBlocks.push(...entry.blocks);
    }
  }

  return rawCalls.map(finalizeCall);
}

function finalizeCall(raw: RawCall): TrajectoryCall {
  // The final answer = the last text block (index into outputBlocks).
  let lastTextIndex = -1;
  for (let i = 0; i < raw.outputBlocks.length; i++) {
    if (raw.outputBlocks[i]!.type === 'text') lastTextIndex = i;
  }
  const answerBlocks = lastTextIndex >= 0 ? [raw.outputBlocks[lastTextIndex]!] : [];

  const durationMs =
    raw.startTime !== undefined && raw.endTime !== undefined
      ? Math.max(0, raw.endTime - raw.startTime)
      : undefined;

  return {
    key: raw.key,
    userBlocks: raw.userBlocks,
    workRows: buildWorkRows(raw, lastTextIndex),
    answerBlocks,
    durationMs: raw.isStreaming ? undefined : durationMs,
    isStreaming: raw.isStreaming,
  };
}

function buildWorkRows(raw: RawCall, lastTextIndex: number): TrajectoryWorkRow[] {
  const rows: TrajectoryWorkRow[] = [];
  const resultByToolId = new Map<string, StreamBlock>();
  for (const b of raw.outputBlocks) {
    if (b.type === 'tool_result' && b.toolId) resultByToolId.set(b.toolId, b);
  }

  // Preserve chronological order: each "LLM call" is thinking → text → tool,
  // and a tool must follow the thinking/text it belongs to (not be regrouped).
  for (let i = 0; i < raw.outputBlocks.length; i++) {
    const b = raw.outputBlocks[i]!;
    if (b.type === 'thinking') {
      if (typeof b.content !== 'string' || b.content.trim() === '') {
        if (!raw.isStreaming) continue;
      }
      // A thinking block is only "still thinking" when it is the very last
      // block of a live turn — once the model moves on to text or a tool call,
      // this thinking block is finished and must render as completed.
      const isActiveThinking = raw.isStreaming && i === raw.outputBlocks.length - 1;
      const thinkingDuration =
        typeof b.startedAt === 'number' && typeof b.endedAt === 'number'
          ? Math.max(0, b.endedAt - b.startedAt)
          : undefined;
      rows.push({
        key: `${raw.key}:work:reasoning:${rows.length}`,
        kind: 'reasoning',
        blocks: [b],
        isStreaming: isActiveThinking,
        durationMs: thinkingDuration,
      });
    } else if (b.type === 'text') {
      if (i === lastTextIndex) continue; // final answer, rendered separately
      rows.push({
        key: `${raw.key}:work:text:${rows.length}`,
        kind: 'text',
        blocks: [b],
      });
    } else if (b.type === 'tool_use') {
      const result = b.toolId ? resultByToolId.get(b.toolId) : undefined;
      rows.push({
        key: `${raw.key}:work:tool:${b.toolId ?? rows.length}`,
        kind: 'tool',
        blocks: result ? [b, result] : [b],
      });
    }
    // tool_result blocks are attached to their tool_use above (skipped here).
  }
  return rows;
}

/** "X 分 Y 秒" / "X 秒" — mirrors ZCode `formatConversationWorkDuration`. */
export function formatWorkDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) return '';
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
}

/** "已思考 {N}s" — thinking block collapsed summary. */
export function formatThinkingDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) return '已思考';
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  return `已思考 ${seconds}s`;
}

const TOOL_LABELS: Record<string, string> = {
  bash: '终端',
  read: '查阅',
  glob: '查阅',
  grep: '查阅',
  webfetch: '查阅',
  websearch: '搜索',
  write: '编辑',
  update: '编辑',
  notebookedit: '编辑',
  todowrite: '计划',
  taskcreate: '任务',
  taskupdate: '任务',
  tasklist: '任务',
  taskget: '任务',
  taskoutput: '任务',
  taskstop: '任务',
  skill: '技能',
  askuserquestion: '提问',
  enterplanmode: '计划',
  exitplanmode: '计划',
  enterworktree: '工作树',
  exitworktree: '工作树',
  workflow: '工作流',
};

export function toolLabel(toolName: string): string {
  return TOOL_LABELS[toolName.toLowerCase()] ?? toolName;
}
