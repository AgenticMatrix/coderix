import { describe, it, expect } from 'vitest';
import { Box, Text } from 'ink';
import { EventEmitter } from 'node:events';

import { renderSync } from '../render-entry.js';
import { Static } from '../static-region.js';
import { emulate } from '../testing/term-emulator.js';

/**
 * Why a write ink did not make corrupts the whole transcript.
 *
 * Ink repaints in place: to redraw, it rewinds the cursor up over the frame it
 * believes it drew, then writes the new one on top. That rewind is computed
 * from ink's own record of what it emitted. A write from anywhere else —
 * `process.stderr.write`, an inherited subprocess stderr — advances the cursor
 * without ink knowing, so the rewind stops short and lands mid-frame. The
 * previous frame is never erased; the new one is drawn below it.
 *
 * The damage compounds. Each foreign write strands one more copy, and because
 * the app redraws a little further along each time, the stranded copies form a
 * LADDER: the same tool block repeated down the screen, each rung more complete
 * than the one above it, with the status bar duplicated at every rung showing a
 * different value. That is the reported symptom exactly, and this test pins the
 * mechanism so a reintroduced debug write is caught as a behaviour change and
 * not merely as a lint finding.
 *
 * `patchConsole` cannot defend against this: `patch-console` swaps the
 * `console.*` methods only, and never touches `process.stdout/stderr.write`.
 * So routing diagnostics through `console.error` is safe, and writing to the
 * stream directly is not.
 */

const COLS = 80;
const ROWS = 24;

function fakeTty() {
  const chunks: string[] = [];
  const stream = new EventEmitter() as unknown as NodeJS.WriteStream & {
    written: () => string;
  };
  Object.assign(stream, {
    isTTY: true,
    columns: COLS,
    rows: ROWS,
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

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 25));

/**
 * A tool block that renders more completely at each step — the shape the report
 * shows, from a pending indicator to a settled one with command and output.
 */
const STAGES = [
  '○ Bash(List CLI commands,',
  '● Bash(List CLI commands,',
  '● Bash(List CLI commands,\n    cd ~/repo && echo "=== CLI comma…)',
  '● Bash(List CLI commands,\n    cd ~/repo && echo "=== CLI comma…)\n    === CLI commands ===',
];

function Shell({ step }: { step: number }) {
  const body = STAGES[Math.min(step, STAGES.length - 1)]!;
  return (
    <Box flexDirection="column" height={ROWS - 1}>
      <Box height={1} flexShrink={0} />
      <Static items={[]}>{() => null}</Static>
      <Box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden">
        {body.split('\n').map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
      </Box>
      <Box flexShrink={0}>
        <Text>STATUS step={step}</Text>
      </Box>
    </Box>
  );
}

/** Drive the shell through a turn, optionally interleaving foreign writes. */
async function runTurn(foreignWrites: boolean) {
  const stdout = fakeTty();
  const app = renderSync(<Shell step={0} />, {
    stdout,
    stdin: fakeStdin(),
    patchConsole: false,
    exitOnCtrlC: false,
  });
  await settle();

  for (let step = 1; step <= 8; step += 1) {
    if (foreignWrites) {
      // Stands in for any direct stream write during a turn: a debug line in a
      // reducer, or an MCP subprocess spawned with `stderr: 'inherit'`.
      stdout.write('[pricing] inputT=12 outT=34 turnCost=0.0021\n');
    }
    app.rerender(<Shell step={step} />);
    await settle();
  }
  app.unmount();
  await settle();

  const screen = emulate(stdout.written(), COLS, ROWS);
  const everywhere = [...screen.scrollback, ...screen.rows];
  return {
    toolBlocks: everywhere.filter((r) => r.includes('Bash(List CLI commands')).length,
    statusBars: everywhere.filter((r) => r.includes('STATUS step=')).length,
  };
}

describe('a repaint interleaved with writes ink did not make', () => {
  it('leaves exactly one tool block and one status bar when ink owns the stream', async () => {
    const { toolBlocks, statusBars } = await runTurn(false);
    expect(toolBlocks, 'the tool block is repainted in place').toBe(1);
    expect(statusBars, 'the status bar is repainted in place').toBe(1);
  });

  it('strands a ladder of stale copies once anything else writes', async () => {
    const clean = await runTurn(false);
    const fouled = await runTurn(true);

    // Stated as a comparison so the test says what the defect IS — duplication
    // relative to the same run without the writes — rather than pinning an
    // incidental count that would drift with ink's diffing heuristics.
    expect(
      fouled.statusBars,
      'each foreign write should strand another status bar',
    ).toBeGreaterThan(clean.statusBars);
    expect(
      fouled.toolBlocks,
      'each foreign write should strand another copy of the tool block',
    ).toBeGreaterThan(clean.toolBlocks);
  });
});
