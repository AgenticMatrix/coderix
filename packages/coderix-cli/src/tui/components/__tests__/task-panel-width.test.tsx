import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { renderSync, textWidth } from '@coderix/tui';

/**
 * The Task panel is a bordered box pinned above the input. It used to size
 * itself to its content (`flexShrink={0}`, `alignSelf="flex-start"`, no width
 * cap, un-truncated rows), so a long task subject or dependency list pushed the
 * right border off-screen. This pins every rendered row — including the border —
 * to within the terminal width.
 */

const tasks = [
  {
    id: '1',
    status: 'in_progress',
    subject:
      'Build core framework with input, storage, audio and a very long description that would overflow a narrow terminal easily',
    activeForm:
      'Building core framework with input, storage, audio and a very long active form that would overflow a narrow terminal easily',
    owner: 'builder-agent-with-a-long-name',
    blocks: [],
    blockedBy: [],
    updatedAt: 2,
  },
  {
    id: '2',
    status: 'pending',
    subject: 'Build track system and five themed tracks with scenery and props',
    activeForm: '',
    owner: '',
    blocks: [],
    blockedBy: ['1'],
    updatedAt: 1,
  },
];

vi.mock('@coderix/core', () => ({
  listTasks: vi.fn(async () => tasks),
}));

const { TaskPanel } = await import('../TaskPanel.js');

const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));

async function renderAt(columns: number): Promise<string[]> {
  const stdout = new PassThrough() as unknown as {
    isTTY: boolean;
    columns: number;
    rows: number;
    on: (e: string, h: (c: Buffer) => void) => void;
  };
  stdout.isTTY = true;
  stdout.columns = columns;
  stdout.rows = 200;
  let buf = '';
  stdout.on('data', (c: Buffer) => {
    buf += c.toString();
  });

  const app = renderSync(<TaskPanel dismissed={false} />, {
    stdout: stdout as never,
    stdin: new PassThrough() as never,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  // Allow the initial async poll + re-render to settle.
  await tick();
  app.unmount();

  return buf
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .split('\n')
    .map((r) => r.replace(/\s+$/, ''))
    .filter((r) => r.trim() !== '');
}

describe('TaskPanel width', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const columns of [50, 60, 80]) {
    it(`keeps the bordered panel within ${columns} columns`, async () => {
      const rows = await renderAt(columns);
      expect(rows.length, 'panel should have rendered').toBeGreaterThan(0);
      for (const row of rows) {
        expect(
          textWidth(row),
          `panel row exceeded ${columns} columns: ${JSON.stringify(row)}`,
        ).toBeLessThanOrEqual(columns);
      }
    });

    it(`keeps every bordered row closed at ${columns} columns`, async () => {
      const rows = await renderAt(columns);
      // Rows that open the vertical border must also close it — a row missing
      // the right `│` means content pushed the border off-screen.
      const bordered = rows.filter((r) => r.trimStart().startsWith('│'));
      expect(bordered.length, 'expected bordered rows').toBeGreaterThan(0);
      for (const row of bordered) {
        expect(
          row.trimEnd().endsWith('│'),
          `row lost its right border: ${JSON.stringify(row)}`,
        ).toBe(true);
      }
    });
  }
});
