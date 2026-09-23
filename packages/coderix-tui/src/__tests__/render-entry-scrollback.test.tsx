import { describe, it, expect } from 'vitest';
import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { EventEmitter } from 'node:events';

import { renderSync } from '../render-entry.js';
import { Static } from '../static-region.js';

/**
 * The app does not mount through ink's bare `render` — it goes through
 * `renderSync`, which turns on `incrementalRendering`. That switches ink to a
 * different writer, so every scrollback guarantee has to be re-established on
 * the path the user actually runs. A test that proves the invariant under the
 * default writer proves nothing about the shipped binary.
 */

const ERASE_SCROLLBACK = '[3J';

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

const nextTick = () => new Promise<void>((resolve) => setTimeout(resolve, 2));

function Transcript({ total, rows }: { total: number; rows: number }) {
  const [count, setCount] = useState(1);

  useEffect(() => {
    if (count >= total) return;
    const timer = setTimeout(() => setCount((n) => n + 1), 0);
    return () => clearTimeout(timer);
  }, [count, total]);

  const committed = Array.from({ length: Math.max(0, count - 1) }, (_, i) => i);
  const liveRows = Math.max(1, rows - 1 - 2);

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

async function run(total: number, rows: number) {
  const stdout = fakeTty(80, rows);
  // The production entry point, with whatever options it sets.
  const instance = renderSync(<Transcript total={total} rows={rows} />, {
    stdout,
    stdin: fakeStdin(),
    patchConsole: false,
    exitOnCtrlC: false,
  });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await nextTick();
    if (stdout.written().includes(`live line ${total - 1}`)) break;
  }
  for (let i = 0; i < 5; i += 1) await nextTick();

  instance.unmount();
  await nextTick();

  const output = stdout.written();
  return { output, erases: output.split(ERASE_SCROLLBACK).length - 1 };
}

describe('scrollback under the production render entry', () => {
  it('commits history without erasing scrollback', async () => {
    const { output, erases } = await run(60, 16);

    expect(output).toContain('committed line 0');
    expect(output).toContain('committed line 50');
    expect(erases).toBe(0);
  });
});
