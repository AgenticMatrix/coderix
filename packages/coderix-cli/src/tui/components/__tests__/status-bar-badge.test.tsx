import React from 'react';
import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { renderSync } from '@coderix/tui';
import { emulate } from '@coderix/tui/testing';
import { StatusBar } from '../StatusBar.js';
import type { AgentPhase } from '../../agent-phase.js';

/**
 * STATUS BAR BADGE: the coarse phase only.
 *
 * `busy` / `wait` / `idle` is all this row is allowed to say about the phase.
 * The reason — streaming, thinking, waiting for the LLM, a background task —
 * belongs to the ActivityLine above the prompt, so that the two lines never
 * spell out the same thing twice. These render the real bar and read the badge
 * off the emulated screen.
 */

const COLS = 160;
const ROWS = 6;
const tick = () => new Promise((r) => setTimeout(r, 250));

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

async function renderBadge(phase: AgentPhase): Promise<string> {
  const stdout = mkStdout();
  const app = renderSync(
    <StatusBar
      model="test-model"
      agentPhase={phase}
      error={null}
      totalChars={0}
      inputTokens={0}
      outputTokens={0}
      realUsage={{
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      }}
      accumulatedCost={0}
      processMemory={0}
      processCount={1}
    />,
    { stdout: stdout as never, patchConsole: false },
  );
  await tick();
  const out = stdout.getBuf();
  app.unmount();
  const screen = emulate(out, COLS, ROWS);
  return [...screen.scrollback, ...screen.rows][0] ?? '';
}

describe('status bar badge', () => {
  it('shows idle with nothing active', async () => {
    expect(await renderBadge('idle')).toContain('idle');
  });

  it('collapses every producing phase to plain busy', async () => {
    for (const phase of ['busy.streaming', 'busy.thinking', 'busy.executing', 'busy.compacting'] as const) {
      const row = await renderBadge(phase);
      expect(row).toContain('busy');
      expect(row).not.toContain(phase.slice('busy.'.length));
    }
  });

  it('collapses every waiting phase to plain wait', async () => {
    for (const phase of ['wait.llm', 'wait.tool', 'wait.background'] as const) {
      const row = await renderBadge(phase);
      expect(row).toContain('wait');
      expect(row).not.toContain(phase.slice('wait.'.length));
    }
  });

  it('keeps the badge single-line', async () => {
    const row = await renderBadge('wait.background');
    expect(row.trimEnd()).not.toContain('\n');
  });
});
