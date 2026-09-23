import type { Message, ContentBlock } from '../../types.js';

/**
 * Splits the transcript into the part that can be committed to the terminal's
 * scrollback and the part that must stay in the repainted frame.
 *
 * WHY A COMMIT BOUNDARY IS NEEDED AT ALL
 * ---------------------------------------
 * "Scrolling the window" is the terminal's job, not ours. The wheel, trackpad,
 * scrollbar, Cmd+F and copy-paste all act on the terminal's own scrollback
 * buffer. So the transcript is only scrollable if both of these hold:
 *
 *   1. lines actually REACH scrollback, and
 *   2. scrollback is never ERASED.
 *
 * A viewport that clips every frame to the terminal height satisfies (2) and
 * breaks (1): no line ever leaves the viewport, so the wheel has nothing to
 * scroll. Letting the frame grow past the viewport instead satisfies (1) and
 * breaks (2), because ink falls back to a full repaint — `ESC[3J`, erase
 * scrollback — for any frame taller than the viewport.
 *
 * Both conditions can hold at once only by splitting the transcript: finished
 * messages are handed to ink's `<Static>`, which writes them out once and never
 * repaints them (they land in real scrollback), while the live tail plus the
 * chrome stays inside a frame that is always shorter than the viewport (so the
 * erase path is never reached).
 *
 * The cost of that split is the rule this module exists to enforce: **a
 * committed message can never be redrawn.** Committing a message that later
 * changes would strand a stale copy in scrollback, with the corrected copy
 * printed below it. So the boundary has to be conservative — the question is
 * not "is this message old?" but "can anything still change how it renders?".
 */

/**
 * Blocks whose rendering is still tied to work in flight.
 *
 * `SET_TOOL_USE_RESULT` and `UPDATE_BLOCK_STATE` in the chat reducer find their
 * target by scanning *every* message for a matching `toolId`, not just the most
 * recent one. A tool that outlives its turn — a long bash command, a sub-agent,
 * a queued approval — therefore mutates a message that already looks settled.
 * Such a message must stay live no matter how far up the transcript it sits.
 */
function isBlockSettled(block: ContentBlock): boolean {
  switch (block.type) {
    case 'tool_use':
      // 'pending' and 'executing' still await a result; 'done'/'error' are final.
      return block.state === 'done' || block.state === 'error';
    case 'subagent':
      return block.state === 'done' || block.state === 'error';
    case 'speculation':
      // 'predicting' has not yet been accepted or thrown away.
      return block.state === 'used' || block.state === 'discarded';
    default:
      // Text, thinking, tool_result and the various boundary markers are inert
      // once present: nothing mutates them in place.
      return true;
  }
}

/**
 * True when nothing can still alter how `message` renders.
 *
 * Note this deliberately ignores `thinkingExpanded` / `toolsExpanded`. Those DO
 * change the rendering, but they are user-driven and global rather than tied to
 * message age, so no per-message test can account for them. They are handled by
 * remounting the whole static region instead — see `advanceEpoch`.
 */
export function isMessageSettled(message: Message): boolean {
  return message.blocks.every(isBlockSettled);
}

export type TranscriptSplit = {
  /** Finished messages, safe to commit to scrollback permanently. */
  readonly committed: readonly Message[];
  /** Messages still subject to change; these stay in the repainted frame. */
  readonly live: readonly Message[];
};

/**
 * Split `messages` at the last point where everything before it is settled.
 *
 * The boundary is a single index rather than a per-message filter, because the
 * transcript is written to scrollback in order. If message 5 is still streaming,
 * message 6 cannot be committed ahead of it without printing the two out of
 * order — so the scan stops at the first unsettled message even if later ones
 * happen to be complete.
 *
 * `keepLive` holds back that many trailing settled messages as well. Committed
 * rows cannot be redrawn, so the newest message is left live for one extra beat:
 * it is the one the user is watching, the one an arriving tool result is most
 * likely to touch, and the one whose height the sticky-scroll logic is tracking.
 */
export function splitTranscript(
  messages: readonly Message[],
  keepLive = 1,
): TranscriptSplit {
  let boundary = 0;
  while (boundary < messages.length && isMessageSettled(messages[boundary]!)) {
    boundary += 1;
  }

  // Hold back the trailing settled messages, without ever reaching past the
  // first unsettled one (which `boundary` already caps).
  const commitCount = Math.max(0, Math.min(boundary, messages.length - keepLive));

  return {
    committed: messages.slice(0, commitCount),
    live: messages.slice(commitCount),
  };
}

/**
 * How full the live half must get before a flush is worth its cost.
 *
 * Each flush is visible: ink clears the interactive region, writes the static
 * rows, then repaints. Doing that per message makes the chrome flicker and —
 * because `log.clear()` is sized from the PREVIOUS frame's line count — can
 * strand a stale row of it on screen. So a flush has to buy something, and the
 * only thing it buys is room: rows leave the repainted frame for scrollback.
 *
 * Hence flushing only when the live half is actually running out of room. Below
 * that the frame is comfortable and there is nothing to gain.
 *
 * A fraction of the live region rather than a row count, so it holds on a 10-row
 * terminal and a 60-row one alike.
 */
const FLUSH_AT_FRACTION_OF_LIVE_REGION = 0.75;

/**
 * Decide whether to move committable messages into scrollback on this frame.
 *
 * `splitTranscript` answers "what COULD be committed"; this answers "should it
 * be, right now". Keeping them apart separates the safety rule — never commit
 * something that can still change — from the cost policy, which exists only
 * because committing is visible.
 *
 * Returns how many messages to commit; 0 leaves the transcript as it is.
 */
export function shouldFlush({
  committableCount,
  liveContentRows,
  liveRegionRows,
  alreadyCommitted,
}: {
  /** Leading settled messages, from `splitTranscript`. */
  readonly committableCount: number;
  /** Measured height of the live half, in rows. */
  readonly liveContentRows: number;
  /** Rows the live half is allowed to occupy. */
  readonly liveRegionRows: number;
  /** Messages already written to scrollback. */
  readonly alreadyCommitted: number;
}): number {
  // Nothing new to hand over.
  if (committableCount <= alreadyCommitted) return 0;

  // The first flush is unconditional. The banner is the first static item, and
  // holding it back keeps it in the repainted frame — spending ~20 rows of the
  // live region on output that redraws identically every time.
  if (alreadyCommitted === 0) return committableCount;

  const threshold = Math.max(
    1,
    Math.floor(liveRegionRows * FLUSH_AT_FRACTION_OF_LIVE_REGION),
  );
  return liveContentRows >= threshold ? committableCount : 0;
}

/**
 * Inputs that change how *already-committed* messages would render.
 *
 * Committed rows are immutable, so the only way to honour a retroactive change
 * is to mount a fresh `<Static>` and let it reprint the transcript in its new
 * form. Ink supports precisely this: when `<Static>`'s key changes, its
 * reconciler fires `onStaticChange`, which clears the accumulated static output
 * so the new instance emits everything again instead of appending a diff.
 */
export type TranscriptEpochInput = {
  /**
   * Monotonic counter bumped by the reducer whenever an action rewrites how
   * existing messages look (the expand/collapse toggles).
   *
   * A counter rather than the `contentExpanded` boolean, because that boolean is
   * an incomplete signal: `TOGGLE_ALL_CONTENT` leaves it unchanged when it only
   * has to expand the still-collapsed thinking blocks, `TOGGLE_ALL_EXPAND` never
   * touches it, and the per-message toggles address a message by id that may
   * already be committed. Any of those would silently skip the reprint.
   */
  readonly renderRevision: number;
  readonly committedCount: number;
  /** Set while viewing a sub-agent: its transcript replaces the main one. */
  readonly subAgentId?: string | undefined;
};

/** Opaque epoch state. Treat as immutable; create with `initialEpoch`. */
export type TranscriptEpoch = {
  /** Use as `<Static>`'s `key`. */
  readonly token: string;
  /**
   * The inputs the current token was minted for. Kept as a field rather than
   * parsed back out of the token, so an agent id containing the separator
   * cannot be misread as a scope change.
   */
  readonly scope: string;
  /** Highest committed count seen under the current token, to detect shrinkage. */
  readonly highWaterMark: number;
  /** Bumped on every forced reprint, to keep successive tokens distinct. */
  readonly generation: number;
};

function scopeOf(input: TranscriptEpochInput): string {
  return `${input.subAgentId ?? 'main'}#${input.renderRevision}`;
}

export function initialEpoch(): TranscriptEpoch {
  return {
    token: 'transcript-0',
    scope: scopeOf({ renderRevision: 0, committedCount: 0 }),
    highWaterMark: 0,
    generation: 0,
  };
}

/**
 * Advance the epoch, returning a token to use as `<Static>`'s key.
 *
 * The token must change when committed history has to be reprinted, and must
 * NOT change when history merely grows — growth is what `<Static>`'s own append
 * path is for. Remounting on every append would reprint the entire transcript
 * on every message, turning linear output into quadratic.
 *
 * So growth is detected by comparing against a high-water mark rather than by
 * putting the count in the token. Three things force a reprint:
 *
 *   - `renderRevision` advances — the expand/collapse toggles rewrote the
 *     per-message flags, so every message renders differently.
 *   - the sub-agent view changes — a different transcript entirely
 *     (`OPEN_SUBAGENT_VIEW` / `CLOSE_SUBAGENT_VIEW`).
 *   - the committed count SHRINKS — history was cleared, undone, replaced or
 *     pruned (`CLEAR_CHAT`, `INTERRUPT_AND_UNDO`, `LOAD_CHAT`, `trimMessages`).
 *     An append-only region cannot express removal, so the only faithful
 *     response is to start over.
 *
 * Note that a reprint leaves the previous rendering behind in scrollback — it
 * was committed, and committed output is permanent. The user sees history
 * restated below the old copy rather than edited in place. That is inherent to
 * a terminal's append-only scrollback, and is the price of having real,
 * scrollable history at all.
 */
export function advanceEpoch(
  previous: TranscriptEpoch,
  input: TranscriptEpochInput,
): TranscriptEpoch {
  const { committedCount } = input;

  const scope = scopeOf(input);
  const scopeChanged = scope !== previous.scope;
  const shrank = committedCount < previous.highWaterMark;

  if (!scopeChanged && !shrank) {
    // Steady state, including growth: keep the same key so <Static> appends.
    return committedCount > previous.highWaterMark
      ? { ...previous, highWaterMark: committedCount }
      : previous;
  }

  const generation = previous.generation + 1;
  return {
    token: `transcript-${generation}`,
    scope,
    highWaterMark: committedCount,
    generation,
  };
}

