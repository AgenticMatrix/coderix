import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, Box, Text } from 'ink';
import { PassThrough } from 'node:stream';
import { useTerminalSize } from '../use-viewport-size.js';

/**
 * ink's own `useWindowSize` (which `useTerminalSize` used to delegate to)
 * registers one `resize` listener per *component instance*. A message list
 * mounts one consumer per message, so >10 simultaneous consumers trip Node's
 * `MaxListenersExceededWarning: 11 resize listeners added to [WriteStream]`.
 *
 * The hook now multiplexes all consumers onto a single listener per stdout.
 * These tests pin that: the listener count must not grow with the number of
 * mounted consumers, it must be cleaned up on unmount, and resize events
 * must still reach every consumer.
 */

const COLS = 80;
const ROWS = 24;
const tick = () => new Promise((r) => setTimeout(r, 90));

const observed: number[] = [];

function Consumer(): React.ReactElement {
  const { columns } = useTerminalSize();
  observed.push(columns);
  return <Text>w={columns}</Text>;
}

function Tree({ count }: { count: number }): React.ReactElement {
  return (
    <Box flexDirection="column">
      {Array.from({ length: count }, (_, i) => (
        <Consumer key={i} />
      ))}
    </Box>
  );
}

function mkStdout(): NodeJS.WriteStream {
  const s = new PassThrough() as unknown as NodeJS.WriteStream;
  s.isTTY = true;
  s.columns = COLS;
  s.rows = ROWS;
  return s;
}

describe('useTerminalSize listener multiplexing', () => {
  it('does not add a resize listener per consumer instance', async () => {
    const stdout = mkStdout();
    const app = render(<Tree count={12} />, {
      stdout: stdout as never,
      patchConsole: false,
    });
    await tick();

    // ink's own Renderer keeps one listener; our hook keeps one shared
    // listener. 12 mounted consumers must not push this past 2.
    const base = stdout.listenerCount('resize');
    expect(base).toBeGreaterThanOrEqual(1);
    expect(base).toBeLessThanOrEqual(2);

    app.rerender(<Tree count={40} />);
    await tick();
    expect(stdout.listenerCount('resize')).toBe(base);

    app.unmount();
    await tick();
    expect(stdout.listenerCount('resize')).toBe(0);
  });

  it('still updates every consumer when the terminal resizes', async () => {
    const stdout = mkStdout();
    observed.length = 0;
    const app = render(<Tree count={12} />, {
      stdout: stdout as never,
      patchConsole: false,
    });
    await tick();
    expect(observed[observed.length - 1]).toBe(COLS);

    stdout.columns = 100;
    stdout.emit('resize');
    await tick();
    expect(observed[observed.length - 1]).toBe(100);

    app.unmount();
  });

  it('falls back to a default size on non-TTY streams without registering a listener', async () => {
    const stdout = mkStdout();
    stdout.isTTY = false; // piped / CI output — columns stay undefined
    (stdout as { columns?: number }).columns = undefined;
    const app = render(<Tree count={3} />, {
      stdout: stdout as never,
      patchConsole: false,
    });
    await tick();
    expect(observed[observed.length - 1]).toBe(80);
    expect(stdout.listenerCount('resize')).toBe(0);
    app.unmount();
  });
});
