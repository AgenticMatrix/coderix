import { describe, it, expect } from 'vitest';
import { useEffect, useState } from 'react';
import { render, Box, Text } from 'ink';
import { EventEmitter } from 'node:events';

import { Static } from '../static-region.js';

/**
 * The two invariants that make transcript history scrollable. Both are about
 * bytes on the wire, so they are asserted against a fake TTY rather than against
 * a snapshot of the component tree.
 *
 *   1. Committed rows must actually REACH the terminal's scrollback — otherwise
 *      the wheel, the scrollbar and Cmd+F have nothing to act on.
 *   2. The scrollback must never be ERASED. Ink repaints the whole screen with
 *      `ESC[3J` (erase scrollback) for any frame that fills the viewport, so the
 *      repainted region has to stay strictly shorter than the terminal however
 *      long history grows.
 *
 * A layout can satisfy either alone; the point of splitting the transcript is to
 * satisfy both at once. These tests fail if a future change reintroduces either
 * failure mode.
 */

const ERASE_SCROLLBACK = '[3J';

/** A writable that looks enough like a TTY for ink to take its TTY paths. */
function fakeTty(columns: number, rows: number) {
  const chunks: string[] = [];
  const stream = new EventEmitter() as unknown as NodeJS.WriteStream & {
    written: () => string;
  };
  Object.assign(stream, {
    isTTY: true,
    columns,
    rows,
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    written: () => chunks.join(''),
  });
  return stream;
}

function fakeStdin() {
  const stream = new EventEmitter() as unknown as NodeJS.ReadStream;
  Object.assign(stream, {
    isTTY: true,
    setRawMode: () => stream,
    setEncoding: () => stream,
    resume: () => stream,
    pause: () => stream,
    ref: () => {},
    unref: () => {},
    read: () => null,
  });
  return stream;
}

const nextTick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

/**
 * Counts emissions of a whole line. Ink trims trailing whitespace from every
 * row, so the marker has to be anchored on the newline rather than on a trailing
 * space — and it has to be a whole line, or `row 1` would also match `row 10`.
 */
function countLines(output: string, line: string): number {
  return output.split(`${line}\n`).length - 1;
}

/**
 * Drives a transcript that grows well past one screen, laid out the way the app
 * lays it out: finished rows committed to a `Static`, the rest inside a
 * fixed-height frame that is one row shorter than the terminal.
 */
function Transcript({
  total,
  rows,
  onFrame,
}: {
  total: number;
  rows: number;
  onFrame: (height: number) => void;
}) {
  const [count, setCount] = useState(1);

  useEffect(() => {
    if (count >= total) return;
    const timer = setTimeout(() => setCount((n) => n + 1), 0);
    return () => clearTimeout(timer);
  }, [count, total]);

  // Everything but the newest line is finished, mirroring `splitTranscript`.
  const committed = Array.from({ length: Math.max(0, count - 1) }, (_, i) => i);
  const liveRows = Math.max(1, rows - 1 - 2); // 2 rows of footer chrome
  onFrame(liveRows + 2);

  return (
    <Box flexDirection="column" height={rows - 1}>
      <Static items={committed}>
        {(index) => <Text key={index}>committed line {index}</Text>}
      </Static>
      <Box flexDirection="column" height={liveRows} overflow="hidden">
        <Text>live line {count - 1}</Text>
      </Box>
      <Box flexDirection="column" height={2} flexShrink={0}>
        <Text>input</Text>
        <Text>status</Text>
      </Box>
    </Box>
  );
}

async function run(total: number, columns: number, rows: number) {
  const stdout = fakeTty(columns, rows);
  const heights: number[] = [];
  const instance = render(
    <Transcript total={total} rows={rows} onFrame={(h) => heights.push(h)} />,
    { stdout, stdin: fakeStdin(), patchConsole: false, exitOnCtrlC: false },
  );

  // Each appended line costs one macrotask to schedule and one to render, and
  // ink throttles its writes on top of that. Pump until the last line has
  // actually been emitted rather than guessing an iteration count.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await nextTick();
    if (stdout.written().includes(`live line ${total - 1}`)) break;
  }
  // One more round so the final append is committed as well.
  for (let i = 0; i < 5; i += 1) await nextTick();

  instance.unmount();
  await nextTick();

  const output = stdout.written();
  return {
    output,
    erases: output.split(ERASE_SCROLLBACK).length - 1,
    maxFrameHeight: Math.max(0, ...heights),
  };
}

describe('committed transcript region', () => {
  it('writes history to the terminal without ever erasing scrollback', async () => {
    // 60 lines of history in a 16-row terminal: without the split this would
    // overflow on nearly every frame.
    const { output, erases } = await run(60, 80, 16);

    expect(countLines(output, 'committed line 0')).toBeGreaterThan(0);
    expect(countLines(output, 'committed line 50')).toBeGreaterThan(0);
    // The invariant. One erase is one destroyed scroll history.
    expect(erases).toBe(0);
  });

  it('keeps the repainted frame strictly shorter than the terminal', async () => {
    // Ink's clearing branches are all gated on `height >= terminalRows`, so
    // staying below that makes them unreachable regardless of content.
    for (const rows of [10, 16, 24, 40]) {
      const { maxFrameHeight, erases } = await run(40, 80, rows);
      expect(maxFrameHeight).toBeLessThan(rows);
      expect(erases).toBe(0);
    }
  });

  it('emits each committed row exactly once', async () => {
    // Re-emitting would stack duplicate copies of history in scrollback — the
    // "status bar rendered three times" failure mode, applied to the transcript.
    const { output } = await run(30, 80, 16);
    for (const index of [0, 7, 15, 25]) {
      expect(countLines(output, `committed line ${index}`), `line ${index}`).toBe(1);
    }
  });

  it('replays history in its new form when the key changes', async () => {
    // Committed rows cannot be edited, so a retroactive change (expand/collapse)
    // is honoured by mounting a fresh region that emits everything again.
    const stdout = fakeTty(80, 16);
    const items = [0, 1, 2];

    function Replayed({ generation }: { generation: number }) {
      return (
        <Box flexDirection="column" height={15}>
          <Static key={`gen-${generation}`} items={items}>
            {(index) => <Text key={index}>gen{generation} row {index}</Text>}
          </Static>
          <Text>footer</Text>
        </Box>
      );
    }

    const instance = render(<Replayed generation={0} />, {
      stdout,
      stdin: fakeStdin(),
      patchConsole: false,
      exitOnCtrlC: false,
    });
    await nextTick();
    instance.rerender(<Replayed generation={1} />);
    await nextTick();
    await nextTick();
    instance.unmount();
    await nextTick();

    const output = stdout.written();
    // Every row restated under the new generation, each exactly once.
    for (const index of items) {
      expect(countLines(output, `gen1 row ${index}`), `row ${index}`).toBe(1);
    }
    // And the reprint did not cost the scrollback.
    expect(output.split(ERASE_SCROLLBACK).length - 1).toBe(0);
  });
});
