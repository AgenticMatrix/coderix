import React from 'react';
import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { renderSync } from '@coderix/tui';
import { emulate } from '@coderix/tui/testing';
import { ActivityLine } from '../ThinkingBlockRenderer.js';
import type { AgentPhase } from '../../agent-phase.js';

/**
 * ACTIVITY LINE: the fine-grained phase.
 *
 * This is where `busy.streaming` becomes "Streaming…" and `wait.llm` becomes
 * "Waiting for LLM response…" — the status bar below only says `busy` / `wait`.
 * Rendered for real and read off the emulated screen so a label that only
 * exists in the prop plumbing cannot pass.
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

async function renderLine(props: {
  phase: AgentPhase;
  turnElapsed?: number;
  turnOutputTokens?: number;
  completed?: { elapsed: number; tokens: number } | null;
  interrupted?: boolean;
}): Promise<string> {
  const stdout = mkStdout();
  const app = renderSync(
    <ActivityLine
      phase={props.phase}
      turnElapsed={props.turnElapsed ?? 0}
      turnOutputTokens={props.turnOutputTokens ?? 0}
      completed={props.completed ?? null}
      interrupted={props.interrupted}
    />,
    { stdout: stdout as never, patchConsole: false },
  );
  await tick();
  const out = stdout.getBuf();
  app.unmount();
  const screen = emulate(out, COLS, ROWS);
  return [...screen.scrollback, ...screen.rows]
    .map((row) => row.trimEnd())
    .filter((row) => row.length > 0)
    .join('\n');
}

describe('activity line', () => {
  it('names what the model is producing', async () => {
    expect(await renderLine({ phase: 'busy.thinking' })).toContain('Thinking...');
    expect(await renderLine({ phase: 'busy.executing' })).toContain('Executing...');
    expect(await renderLine({ phase: 'busy.streaming' })).toContain('Streaming...');
    expect(await renderLine({ phase: 'busy.compacting' })).toContain('Compacting conversation...');
  });

  it('names what the agent is waiting on', async () => {
    expect(await renderLine({ phase: 'wait.llm' })).toContain('Waiting for LLM response...');
    expect(await renderLine({ phase: 'wait.tool' })).toContain('Waiting for tool...');
    expect(await renderLine({ phase: 'wait.background' })).toContain('Background task running...');
  });

  it('shows elapsed time but no token count while waiting', async () => {
    const row = await renderLine({ phase: 'wait.llm', turnElapsed: 12_000, turnOutputTokens: 0 });
    expect(row).toContain('(12s)');
    expect(row).not.toContain('tokens');
  });

  it('counts output tokens and time while producing', async () => {
    const row = await renderLine({ phase: 'busy.streaming', turnElapsed: 25_000, turnOutputTokens: 1200 });
    expect(row).toContain('(25s');
    expect(row).toContain('1.2k tokens');
  });

  it('stays silent when idle with no finished turn', async () => {
    expect(await renderLine({ phase: 'idle' })).toBe('');
  });

  it('reports a finished or interrupted turn', async () => {
    const completed = { elapsed: 130_000, tokens: 2200 };
    expect(await renderLine({ phase: 'idle', completed })).toContain('Done...');
    expect(await renderLine({ phase: 'idle', completed, interrupted: true })).toContain('Interrupted...');
  });
});
