import React from 'react';
import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { renderSync, textWidth, Box } from '@coderix/tui';
import { WriteRenderer } from '../renderer.js';

/**
 * Diff lines from Write must never run past the terminal's right edge.
 *
 * The renderer draws each diff line in a fixed-width colored Box and previously
 * sized that Box at `0.9 * termWidth` while ignoring the ScrollBox/paddingLeft
 * indentation it sits inside — so a long source line padded its background band
 * past the edge and soft-wrapped onto a second row. This pins each rendered row
 * to within the terminal width (measured in COLUMNS, not `.length`, so CJK and
 * the `…` truncation marker are counted correctly).
 */

const tick = () => new Promise((r) => setTimeout(r, 120));

// Mirrors the real layout: App wraps committed messages / the live ScrollBox in
// paddingX={1}. The renderer itself adds its own paddingLeft={2} internally, so
// the only *outer* indent to simulate here is that single padding column.
const OUTER_INDENT = 1;

async function renderAt(columns: number, diffLines: string[]): Promise<string[]> {
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

  const app = renderSync(
    <Box paddingLeft={OUTER_INDENT}>
      <WriteRenderer
        toolName="Write"
        toolId="t1"
        input={{ file_path: '/tmp/app.js' }}
        state="done"
        termWidth={columns}
        result={{
          content: '',
          isError: false,
          metadata: { addedLines: diffLines.length, diffLines },
        }}
      />
    </Box>,
    {
      stdout: stdout as never,
      stdin: new PassThrough() as never,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );
  await tick();
  app.unmount();

  return buf
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .split('\n')
    .map((r) => r.replace(/\s+$/, ''))
    .filter((r) => r.trim() !== '');
}

// A single very long source line, formatted as the core executor does:
// 4-col line number + " +" marker + code.
const longCode = 'const wheelMeshes = [' + 'x'.repeat(400) + '];';
const diffLines = [`${String(1).padStart(4)} +${longCode}`];

describe('Write diff rendering width', () => {
  for (const columns of [60, 80, 120]) {
    it(`keeps every diff row within ${columns} columns`, async () => {
      const rows = await renderAt(columns, diffLines);
      for (const row of rows) {
        expect(
          textWidth(row) + OUTER_INDENT,
          `row exceeded ${columns} columns: ${JSON.stringify(row)}`,
        ).toBeLessThanOrEqual(columns);
      }
    });

    it(`renders the long line as a single unwrapped row at ${columns} columns`, async () => {
      const rows = await renderAt(columns, diffLines);
      // The code content row is the one carrying the opening identifier.
      const codeRows = rows.filter((r) => r.includes('const wheelMeshes'));
      expect(
        codeRows.length,
        'a wrapped diff line would appear as more than one row',
      ).toBe(1);
      // Overlong content is marked truncated rather than wrapped.
      expect(codeRows[0]).toContain('…');
    });
  }
});
