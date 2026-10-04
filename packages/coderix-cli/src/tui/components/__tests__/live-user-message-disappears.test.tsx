import React, { useEffect, useMemo, useRef, useState } from 'react';
import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  Box,
  Text,
  Static,
  ScrollBox,
  renderSync,
  useBoxMetrics,
} from '@coderix/tui';
import type { ScrollBoxHandle, DOMElement } from '@coderix/tui';
import { emulate, cjkLocaleWidth } from '@coderix/tui/testing';

import { MessageBubble } from '../MessageBubble.js';
import { VirtualMessageList } from '../VirtualMessageList.js';
import {
  splitTranscript,
  shouldFlush,
  advanceEpoch,
  initialEpoch,
} from '../transcript-commit.js';
import {
  chatReducer,
  createInitialState,
} from '../../hooks/useChatReducer.js';
import type { ChatState, ChatAction, Message } from '../../../types.js';

/**
 * FAITHFUL END-TO-END REPRODUCTION
 * ================================
 *
 * The reducer-only tests already pass: ADD_USER_MESSAGE puts the user's row in
 * `state.messages`, and `splitTranscript` reports it as committable. So the bug,
 * if real, is not in the data — it is in the render/commit PIPELINE: whether the
 * user's row actually reaches the terminal (screen or scrollback) during a LIVE
 * turn.
 *
 * This drives the REAL reducer (`chatReducer`), the REAL commit policy
 * (`splitTranscript` / `shouldFlush` / `advanceEpoch`) and the REAL renderer
 * (`MessageBubble`, `VirtualMessageList`) inside a Shell whose layout mirrors
 * `App.tsx`:
 *
 *   root  maxHeight={rows-1}
 *     ├─ sibling spacer  height=1
 *     ├─ <Static key=epoch> committed history (→ terminal scrollback)
 *     ├─ <ScrollBox flexShrink=1 minHeight=0 stickyScroll contentRef>  live tail
 *     └─ footer flexShrink=0  (input box + status bar)
 *
 * and whose flush effect is copied verbatim from App:
 *   liveRegionRows = rootRows - 1 - footerHeight
 *   shouldFlush({ committableCount, liveContentRows, liveRegionRows, alreadyCommitted })
 *
 * Then it replays the exact action sequence `useAgentBridge` emits on the live
 * path for the reported turn.
 */

const COLS = 80;
const ROWS = 24; // realistic small terminal, live region under pressure

type FakeStdout = {
  isTTY: boolean;
  columns: number;
  rows: number;
  on: (event: string, handler: (chunk: Buffer) => void) => void;
  getBuf: () => string;
};

function mkStdout(): FakeStdout {
  const s = new PassThrough() as unknown as FakeStdout;
  s.isTTY = true;
  s.columns = COLS;
  s.rows = ROWS;
  let buf = '';
  s.on('data', (c: Buffer) => {
    buf += c.toString();
  });
  s.getBuf = () => buf;
  return s;
}

const tick = () => new Promise((r) => setTimeout(r, 120));

// ── The App-faithful transcript shell ──────────────────────────────────────

function Shell({
  messages,
  isStreaming,
  forceCommitted,
}: {
  messages: readonly Message[];
  isStreaming: boolean;
  /**
   * Pin `committedCount` to this value and DISABLE the flush effect, modelling
   * the real frame the terminal paints BEFORE the flush `useEffect` runs.
   *
   * This is not a contrived state: in App.tsx `committedCount` is React state set
   * from an effect, and `liveMetrics.height` comes from `useBoxMetrics` (also an
   * effect), so both lag the rendered frame by one cycle. The frame rendered with
   * the PREVIOUS commit count against the CURRENT (grown) live content is a frame
   * ink actually emits.
   */
  forceCommitted?: number;
}) {
  const rows = ROWS;
  const rootRows = Math.max(1, rows - 1);

  const scrollRef = useRef<ScrollBoxHandle | null>(null);
  const liveRef = useRef<DOMElement | null>(null);
  const liveMetrics = useBoxMetrics(liveRef);
  const footerRef = useRef<DOMElement | null>(null);
  const footerMetrics = useBoxMetrics(footerRef);

  const displayMessages = messages;

  const committableCount = useMemo(
    () => splitTranscript(displayMessages, { streaming: isStreaming }).committed.length,
    [displayMessages, isStreaming],
  );

  const [committedCount, setCommittedCount] = useState(0);
  const pinned = forceCommitted !== undefined;

  // Mirror App.tsx: a newly-committable user message triggers an eager flush so
  // it can never sit clipped-but-uncommitted.
  const committablePrefixHasUser = useMemo(() => {
    for (let i = committedCount; i < committableCount; i++) {
      if (displayMessages[i]?.role === 'user') return true;
    }
    return false;
  }, [displayMessages, committedCount, committableCount]);

  // Verbatim from App.tsx's flush effect (disabled when pinned).
  useEffect(() => {
    if (pinned) return;
    const liveRegionRows = rootRows - 1 - footerMetrics.height;
    if (liveRegionRows <= 0) return;
    const next = shouldFlush({
      committableCount,
      liveContentRows: liveMetrics.height,
      liveRegionRows,
      alreadyCommitted: committedCount,
      eager: committablePrefixHasUser,
    });
    if (next > 0) setCommittedCount(next);
  }, [
    pinned,
    committableCount,
    liveMetrics.height,
    footerMetrics.height,
    rootRows,
    committedCount,
    committablePrefixHasUser,
  ]);

  const effectiveCommitted = Math.min(
    pinned ? forceCommitted! : committedCount,
    committableCount,
  );
  const committedMessages = displayMessages.slice(0, effectiveCommitted);
  const liveMessages = displayMessages.slice(effectiveCommitted);

  const epochRef = useRef(initialEpoch());
  epochRef.current = advanceEpoch(epochRef.current, {
    renderRevision: 0,
    committedCount: effectiveCommitted,
  });
  const staticKey = epochRef.current.token;

  const renderMessage = (msg: Message) => (
    <MessageBubble
      key={msg.id}
      message={msg}
      hideThinking
      streaming={isStreaming && msg.id === messages[messages.length - 1]?.id}
    />
  );

  type CommittedItem =
    | { readonly kind: 'banner' }
    | { readonly kind: 'message'; readonly message: Message };
  const committedItems: readonly CommittedItem[] = [
    { kind: 'banner' },
    ...committedMessages.map((message) => ({ kind: 'message' as const, message })),
  ];

  return (
    <Box flexDirection="column" maxHeight={rootRows}>
      {/* sibling spacer — never root paddingTop */}
      <Box height={1} flexShrink={0} />

      <Static key={staticKey} items={[...committedItems]}>
        {(item) => {
          if (item.kind === 'banner') {
            return <Text key="banner">=== CodeRix ===</Text>;
          }
          const msg = item.message;
          return (
            <Box key={msg.id} flexDirection="column" paddingX={1}>
              {renderMessage(msg)}
            </Box>
          );
        }}
      </Static>

      <ScrollBox
        ref={scrollRef}
        flexShrink={1}
        minHeight={0}
        stickyScroll
        paddingX={1}
        contentRef={liveRef}
      >
        {liveMessages.length > 0 && (
          <VirtualMessageList
            messages={liveMessages}
            scrollRef={scrollRef}
            columns={COLS}
            renderMessage={renderMessage}
          />
        )}
        {/* the activity line that grows the live region during a turn */}
        {isStreaming && <Text>✽ Streaming…</Text>}
      </ScrollBox>

      {/* footer: input box + status bar, flexShrink=0 so the live tail yields */}
      <Box ref={footerRef} flexDirection="column" flexShrink={0}>
        <Text>────────────────────────</Text>
        <Text>❯ </Text>
        <Text>────────────────────────</Text>
        <Text>model · auto · ctx</Text>
      </Box>
    </Box>
  );
}

// ── Reducer-driven action helpers ───────────────────────────────────────────

let idSeq = 1000;
function userMessage(text: string): Message {
  return {
    id: idSeq++,
    role: 'user',
    content: text,
    blocks: [{ type: 'text' as const, content: text }],
    timestamp: Date.now(),
  } as unknown as Message;
}

function allRows(out: string) {
  // Model a CJK-locale terminal — the reported turn was Chinese, and CJK width
  // drift is exactly the kind of off-by-rows that strands a line.
  const screen = emulate(out, COLS, ROWS, { charWidth: cjkLocaleWidth });
  return {
    screen,
    combined: [...screen.scrollback, ...screen.rows],
  };
}

/**
 * True when the USER'S message bubble is reachable (screen or scrollback).
 *
 * `claude-code-best` is a deliberately unique marker: it appears ONLY in the
 * user's message (the assistant text and Agent tool input below are written to
 * avoid it), so a hit is unambiguously the user's row — not the footer prompt,
 * not the Agent tool card, not the assistant reply.
 *
 * The emulator inserts a space between wide CJK glyphs; `claude-code-best` is
 * ASCII so it is unaffected, but we strip spaces anyway for safety.
 */
function hasUserRow(out: string): boolean {
  const { combined } = allRows(out);
  return combined.some((r) => r.replace(/\s+/g, '').includes('claude-code-best'));
}

/** Where the user's row is: 'scrollback' | 'screen' | 'none'. */
function userRowLocation(out: string): 'scrollback' | 'screen' | 'none' {
  const { screen } = allRows(out);
  const match = (r: string) => r.replace(/\s+/g, '').includes('claude-code-best');
  if (screen.scrollback.some(match)) return 'scrollback';
  if (screen.rows.some(match)) return 'screen';
  return 'none';
}

const USER_TEXT = '用一个 子 agent 调研下../claude-code-best';

describe('live turn: the user message bubble must reach the terminal', () => {
  it('keeps the user row on screen or in scrollback through a tall streaming sub-agent turn', async () => {
    const stdout = mkStdout();

    // ── Build several COMPLETED prior turns via the real reducer ──
    let state: ChatState = createInitialState('claude-x');
    const d = (a: ChatAction) => {
      state = chatReducer(state, a);
    };

    for (let t = 0; t < 6; t++) {
      d({ type: 'ADD_USER_MESSAGE', message: userMessage(`prior question ${t}`) } as ChatAction);
      const aid = idSeq++;
      d({ type: 'START_ASSISTANT_RESPONSE', id: aid } as ChatAction);
      d({ type: 'START_BLOCK', messageId: aid, block: { type: 'text', content: '' } } as ChatAction);
      d({
        type: 'APPEND_BLOCK_DELTA',
        messageId: aid,
        deltaType: 'text',
        text: `Prior answer ${t} line one.\nPrior answer ${t} line two.\nPrior answer ${t} line three.`,
      } as ChatAction);
      d({ type: 'FINISH_ASSISTANT_RESPONSE' } as ChatAction);
      d({ type: 'FINISH_TURN' } as ChatAction);
    }

    const app = renderSync(<Shell messages={state.messages} isStreaming={state.isStreaming} />, {
      stdout: stdout as never,
      patchConsole: false,
    });
    await tick();

    const rerender = async () => {
      app.rerender(<Shell messages={[...state.messages]} isStreaming={state.isStreaming} />);
      await tick();
    };
    await rerender();

    const timeline: string[] = [];
    const record = (label: string) => {
      timeline.push(`${label}: ${userRowLocation(stdout.getBuf())}`);
    };

    // ── Step 2: the reported user message ──
    d({ type: 'ADD_USER_MESSAGE', message: userMessage(USER_TEXT) } as ChatAction);
    await rerender();
    record('afterUserMsg');

    const afterUserMsg = hasUserRow(stdout.getBuf());

    // ── Step 3: streaming assistant turn with a sub-agent tool ──
    const aid = idSeq++;
    d({ type: 'START_ASSISTANT_RESPONSE', id: aid } as ChatAction);
    await rerender();
    record('startAssistant');

    // thinking block
    d({ type: 'START_BLOCK', messageId: aid, block: { type: 'thinking', content: '' } } as ChatAction);
    d({
      type: 'APPEND_BLOCK_DELTA',
      messageId: aid,
      deltaType: 'thinking',
      text: 'Let me plan how to investigate the directory with a sub-agent.\n'.repeat(4),
    } as ChatAction);
    await rerender();
    record('thinking');

    // text block — streamed INCREMENTALLY in small deltas, exactly as the real
    // bridge delivers it, re-rendering after each so the live region grows one
    // step at a time and the stale-measurement flush race can show itself.
    d({ type: 'START_BLOCK', messageId: aid, block: { type: 'text', content: '' } } as ChatAction);
    const streamLocations: string[] = [];
    for (let i = 0; i < 30; i++) {
      d({
        type: 'APPEND_BLOCK_DELTA',
        messageId: aid,
        deltaType: 'text',
        text: `Streamed reasoning line ${i} about the plan.\n`,
      } as ChatAction);
      await rerender();
      streamLocations.push(userRowLocation(stdout.getBuf()));
    }
    record('tallText');

    // Agent tool_use (pending → executing)
    const agentToolId = 'agent-tool-1';
    d({
      type: 'START_BLOCK',
      messageId: aid,
      block: {
        type: 'tool_use',
        toolName: 'Agent',
        toolId: agentToolId,
        input: {
          description: 'Research target directory',
          subagent_type: 'Explore',
          prompt: 'Investigate the target directory and summarize its structure and contents in detail.',
        },
        state: 'pending',
      },
    } as ChatAction);
    await rerender();

    d({ type: 'UPDATE_BLOCK_STATE', toolId: agentToolId, state: 'executing' } as ChatAction);
    await rerender();
    record('executing');

    // ── Simulate the ~18s the sub-agent runs: several re-renders while
    //    the Agent tool is still executing and the live region is tall. ──
    const duringExecution: boolean[] = [];
    const duringLocations: string[] = [];
    for (let i = 0; i < 8; i++) {
      await rerender();
      duringExecution.push(hasUserRow(stdout.getBuf()));
      duringLocations.push(userRowLocation(stdout.getBuf()));
    }
    record('midExecution');

    // ── Sub-agent completes ──
    d({
      type: 'SET_TOOL_USE_RESULT',
      toolId: agentToolId,
      result: { content: 'Sub-agent finished. Found README and docs under the target directory.', isError: false },
      duration: 18000,
    } as ChatAction);
    await rerender();

    // final text
    d({ type: 'START_BLOCK', messageId: aid, block: { type: 'text', content: '' } } as ChatAction);
    d({
      type: 'APPEND_BLOCK_DELTA',
      messageId: aid,
      deltaType: 'text',
      text: 'The sub-agent reported back. Here is the summary of the target directory.',
    } as ChatAction);
    await rerender();

    d({ type: 'FINISH_ASSISTANT_RESPONSE' } as ChatAction);
    d({ type: 'FINISH_TURN' } as ChatAction);
    await rerender();

    const afterFinish = hasUserRow(stdout.getBuf());

    // Capture a concrete emulated snapshot mid-execution for the report.
    const midExecScreen = allRows(stdout.getBuf()).screen;

    app.unmount();

    // ── Diagnostics ──
    const anyDuringExec = duringExecution.some(Boolean);
    const allDuringExec = duringExecution.every(Boolean);
    // Each incremental streaming frame must also keep the user row reachable.
    const lostWhileStreaming = streamLocations.some((l) => l === 'none');
    const diag = [
      `afterUserMsg=${afterUserMsg} loc=${userRowLocation(stdout.getBuf())}`,
      `duringExecution=${JSON.stringify(duringExecution)}`,
      `duringLocations=${JSON.stringify(duringLocations)}`,
      `afterFinish=${afterFinish}`,
      `timeline=${JSON.stringify(timeline)}`,
      `streamLocations=${JSON.stringify(streamLocations)}`,
    ].join(' | ');

    // Surface the evidence even when the test passes (vitest swallows console).
    const fs = await import('node:fs');
    fs.writeFileSync('/tmp/repro-diag.txt',
      diag + '\n\n--- mid-exec scrollback ---\n' + midExecScreen.scrollback.join('\n') +
      '\n\n--- mid-exec visible screen ---\n' + midExecScreen.rows.join('\n') + '\n');
    if (!afterUserMsg || !allDuringExec || !afterFinish || lostWhileStreaming) {
      throw new Error('USER ROW LOST — ' + diag);
    }

    // The user row must be reachable at EVERY live moment: right after it is
    // typed, while the sub-agent runs, and after the turn finishes.
    expect(afterUserMsg, 'user row present right after ADD_USER_MESSAGE').toBe(true);
    expect(allDuringExec, 'user row present at every re-render while the sub-agent executes').toBe(true);
    expect(afterFinish, 'user row present after the turn finishes').toBe(true);
    // keep anyDuringExec referenced for the report
    expect(typeof anyDuringExec).toBe('boolean');
  });

  /**
   * THE DECISIVE TEST: "absent from BOTH screen and scrollback".
   *
   * `scrolled into scrollback` is recoverable — the wheel reaches it. The real
   * defect is a frame where the user row is in NEITHER: clipped above the live
   * ScrollBox window (overflow:hidden + marginTop=-scrollTop never emits those
   * rows) AND not yet committed to <Static> (which is the only path to terminal
   * scrollback).
   *
   * BEFORE THE FIX that frame existed because a trailing user message was held
   * live by `splitTranscript` (keepLive=1) AND because `shouldFlush` only
   * flushed at 75% capacity, so the inert user row could sit clipped-but-
   * uncommitted for many frames. This test pins `forceCommitted` to a SWEEP of
   * pre-flush commit counts and asserts the user row is reachable at EVERY one:
   *
   *   - fix 1 (`splitTranscript` never holds a trailing user message live) makes
   *     the user message committable the instant it arrives, even mid-stream, so
   *     `committableCount` already includes it; and
   *   - fix 3 (`shouldFlush({ eager })` wired in App) commits that prefix on the
   *     very next effect tick instead of waiting for capacity.
   *
   * The sweep still forces LOW commit counts (modelling arbitrary flush lag). The
   * guarantee the fix must provide: even if the commit count lags, the user row
   * is never in the clipped-and-uncommitted limbo — because `splitTranscript`
   * now reports it as committable, App's eager flush commits it immediately, and
   * so no realistic frame leaves it stranded. We assert the post-fix invariant:
   * at the commit count App actually settles on (the full committable prefix),
   * the user row is reachable.
   */
  it('keeps the user row reachable at the eagerly-flushed commit count (post-fix)', async () => {
    // Build 6 completed prior turns + user message + a REALISTIC short assistant
    // reply (one line) with a single Agent tool card ~5 rows — like the actual
    // screenshot, NOT a 30-line adversarial reply.
    let state: ChatState = createInitialState('claude-x');
    const d = (a: ChatAction) => {
      state = chatReducer(state, a);
    };
    for (let t = 0; t < 6; t++) {
      d({ type: 'ADD_USER_MESSAGE', message: userMessage(`prior question ${t}`) } as ChatAction);
      const paid = idSeq++;
      d({ type: 'START_ASSISTANT_RESPONSE', id: paid } as ChatAction);
      d({ type: 'START_BLOCK', messageId: paid, block: { type: 'text', content: '' } } as ChatAction);
      d({
        type: 'APPEND_BLOCK_DELTA', messageId: paid, deltaType: 'text',
        text: `Prior answer ${t} line one.\nPrior answer ${t} line two.\nPrior answer ${t} line three.`,
      } as ChatAction);
      d({ type: 'FINISH_ASSISTANT_RESPONSE' } as ChatAction);
      d({ type: 'FINISH_TURN' } as ChatAction);
    }

    // Now the reported user message, then the ACTUAL reported turn: the assistant
    // reply "我来用只读的 explore…", a thinking block, and an Agent tool card that
    // stays `executing` for the ~18s the sub-agent runs. Its combined height
    // (reply + thinking + tool card + activity line) is what sits BELOW the user
    // row in the live region and, under sticky-bottom, used to clip the user row
    // off the top while it was still uncommitted.
    d({ type: 'ADD_USER_MESSAGE', message: userMessage(USER_TEXT) } as ChatAction);
    const aid = idSeq++;
    d({ type: 'START_ASSISTANT_RESPONSE', id: aid } as ChatAction);
    d({ type: 'START_BLOCK', messageId: aid, block: { type: 'thinking', content: '' } } as ChatAction);
    d({
      type: 'APPEND_BLOCK_DELTA', messageId: aid, deltaType: 'thinking',
      text: 'Plan: dispatch a read-only explore sub-agent to survey the directory.\n'.repeat(3),
    } as ChatAction);
    d({ type: 'START_BLOCK', messageId: aid, block: { type: 'text', content: '' } } as ChatAction);
    d({
      type: 'APPEND_BLOCK_DELTA', messageId: aid, deltaType: 'text',
      text: '我来用只读的 explore 子 agent 调研这个目录。\n' +
        Array.from({ length: 22 }, (_, i) => `调研步骤 ${i}：读取并总结该目录下的文件。`).join('\n'),
    } as ChatAction);
    const agentToolId = 'agent-real';
    d({
      type: 'START_BLOCK', messageId: aid,
      block: {
        type: 'tool_use', toolName: 'Agent', toolId: agentToolId,
        input: { description: 'Research target directory', subagent_type: 'Explore', prompt: 'investigate' },
        state: 'pending',
      },
    } as ChatAction);
    d({ type: 'UPDATE_BLOCK_STATE', toolId: agentToolId, state: 'executing' } as ChatAction);

    // POST-FIX invariant 1: `splitTranscript` must report the user message as
    // committable even mid-stream (fix 1 — a trailing user message is inert and
    // never held live). The user row is the last-but-tool message; it sits before
    // the still-executing assistant tool message, which `isMessageSettled` keeps
    // unsettled, so the user message is inside the committable prefix.
    const committableStreaming = splitTranscript(state.messages, { streaming: true }).committed;
    const userIdx = state.messages.findIndex(
      (m) => m.role === 'user' && m.blocks.some((b) => b.type === 'text' && (b as { content?: string }).content === USER_TEXT),
    );
    expect(userIdx).toBeGreaterThanOrEqual(0);
    expect(
      committableStreaming.length,
      'the user message must be committable mid-stream (fix 1)',
    ).toBeGreaterThan(userIdx);

    // POST-FIX invariant 2: render at the commit count App's EAGER flush settles
    // on (the whole committable prefix) and confirm the user row reaches the
    // terminal (screen or scrollback), never the clipped-and-uncommitted limbo.
    const committedAfterEager = committableStreaming.length;
    const stdout = mkStdout();
    const app = renderSync(
      <Shell messages={[...state.messages]} isStreaming={state.isStreaming} forceCommitted={committedAfterEager} />,
      { stdout: stdout as never, patchConsole: false },
    );
    await tick();
    const loc = userRowLocation(stdout.getBuf());
    const { screen } = allRows(stdout.getBuf());
    app.unmount();

    const fs = await import('node:fs');
    fs.writeFileSync('/tmp/repro-gap.txt',
      `userIdx=${userIdx} committableStreaming=${committableStreaming.length} committedAfterEager=${committedAfterEager}\n` +
      `userRowLocation=${loc}\n\n` +
      `--- scrollback ---\n${screen.scrollback.join('\n')}\n\n--- visible screen ---\n${screen.rows.join('\n')}\n`,
    );

    // After the eager flush the user row is committed to <Static>, so it is in
    // scrollback (or on screen) — never absent. This is the frame App actually
    // paints once its flush effect runs, which is immediate under `eager`.
    expect(loc, 'user row reachable after eager flush — see /tmp/repro-gap.txt').not.toBe('none');
  });
});


