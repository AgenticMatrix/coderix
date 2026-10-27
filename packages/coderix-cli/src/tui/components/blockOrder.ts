import type { ContentBlock, ToolUseBlock } from '../../types.js';

/**
 * Stable-partition a message's blocks so finished tool calls render above
 * in-flight ones.
 *
 * Parallel tool calls finish out of call order: with three sub-agents running,
 * the second can settle while the first and third are still streaming. In call
 * order that leaves a finished block wedged between two animating ones, so the
 * only settled rows on screen are the ones the eye keeps being pulled back to.
 * Hoisting finished calls gives the transcript a stable top and keeps the
 * moving edge at the bottom, where new output arrives anyway.
 *
 * Only `tool_use` slots are permuted: the blocks keep their identity (and so
 * their React keys and component state), and text, thinking and boundary
 * blocks stay exactly where they are. Nothing is reordered for a message that
 * has already reached scrollback — `splitTranscript` only commits messages
 * whose blocks have all settled, so a committed row can never disagree with a
 * later render.
 *
 * The hoist is a property of the RUN, not of the message: the moment the last
 * call settles the display returns to call order, which is the order the
 * transcript is stored in and the one the next turn is read against.
 */
export function settledToolsFirst(blocks: ContentBlock[]): ContentBlock[] {
  // Deliberately not `isBlockSettled` from transcript-commit: that one defines
  // what may leave the repainted frame, while this only decides what is worth
  // reading first. A block type added there should not silently reorder here.
  const isTool = (block: ContentBlock): block is ToolUseBlock => block.type === 'tool_use';

  const settled: ToolUseBlock[] = [];
  const running: ToolUseBlock[] = [];
  for (const block of blocks) {
    if (!isTool(block)) continue;
    if (block.state === 'done' || block.state === 'error') settled.push(block);
    else running.push(block);
  }

  // Nothing is in flight: call order is the transcript's own order.
  if (running.length === 0) return blocks;

  // Two cursors into `[settled…, running…]`, one per tool slot encountered.
  const queue = [...settled, ...running];
  let next = 0;
  return blocks.map((block) => (isTool(block) ? queue[next++]! : block));
}
