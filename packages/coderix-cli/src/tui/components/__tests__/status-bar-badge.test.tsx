import React from 'react';
import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { renderSync } from '@coderix/tui';
import { emulate } from '@coderix/tui/testing';
import { StatusBar } from '../StatusBar.js';
import type { AgentPhase } from '../../agent-phase.js';

/**
 * STATUS BAR BADGE: the coarse phase plus why.
 *
 * `idle` / `busy` / `wait` alone are not actionable — "wait" hides whether the
 * model is thinking about the request or a background command is still
 * running. These render the real bar and read the badge off the emulated
 * screen, so a label that only exists in the prop plumbing cannot pass.
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

  it('spells out what the model is producing', async () => {
    expect(await renderBadge('busy.streaming')).toContain('busy streaming');
    expect(await renderBadge('busy.thinking')).toContain('busy thinking');
    expect(await renderBadge('busy.compacting')).toContain('busy compacting');
  });

  it('treats a running tool as busy', async () => {
    expect(await renderBadge('busy.executing')).toContain('busy executing');
  });

  it('spells out what the agent is waiting on', async () => {
    expect(await renderBadge('wait.llm')).toContain('wait llm');
    expect(await renderBadge('wait.tool')).toContain('wait tool');
    expect(await renderBadge('wait.background')).toContain('wait background');
  });

  it('keeps the badge single-line', async () => {
    const row = await renderBadge('wait.background');
    expect(row.trimEnd()).not.toContain('\n');
  });
});
