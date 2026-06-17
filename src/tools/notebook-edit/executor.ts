import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { ToolExecutor } from '../types.js';

interface NotebookCell {
  cell_type: 'code' | 'markdown';
  source: string[];
  outputs?: unknown[];
  execution_count?: number | null;
  metadata?: Record<string, unknown>;
}

interface Notebook {
  cells: NotebookCell[];
  metadata: Record<string, unknown>;
  nbformat: number;
  nbformat_minor: number;
}

function readNotebook(path: string): Notebook {
  if (!existsSync(path)) throw new Error(`File not found: ${path}`);
  let raw: string;
  try { raw = readFileSync(path, 'utf-8'); }
  catch { throw new Error(`Cannot read file: ${path}`); }
  try { return JSON.parse(raw) as Notebook; }
  catch { throw new Error(`Invalid notebook JSON: ${path}`); }
}

function writeNotebook(path: string, nb: Notebook): void {
  writeFileSync(path, JSON.stringify(nb, null, 1) + '\n', 'utf-8');
}

function sourceToString(source: string[]): string {
  return source.join('');
}

function stringToSource(text: string): string[] {
  return text.split('\n').map((l, i, arr) => i < arr.length - 1 ? l + '\n' : l);
}

export const execute: ToolExecutor = async (input, _opts) => {
  const path = input.notebook_path as string;
  const action = input.action as string;
  if (!path) return { content: 'Missing notebook_path.', isError: true };
  if (!path.endsWith('.ipynb')) return { content: 'File must be a .ipynb notebook.', isError: true };

  try {
    const nb = readNotebook(path);

    switch (action) {
      case 'list': {
        const lines = nb.cells.map((c, i) => {
          const src = sourceToString(c.source).replace(/\n/g, ' ').slice(0, 80);
          return `[${i}] ${c.cell_type.padEnd(8)} ${src}`;
        });
        return {
          content: `Notebook: ${path}\n${nb.cells.length} cells\n\n${lines.join('\n')}`,
          isError: false,
          metadata: { cellCount: nb.cells.length, path },
        };
      }

      case 'read': {
        const idx = input.cell_index as number;
        if (idx === undefined) return { content: 'Missing cell_index.', isError: true };
        if (idx < 0 || idx >= nb.cells.length) {
          return { content: `Cell index ${idx} out of range (0-${nb.cells.length - 1}).`, isError: true };
        }
        const cell = nb.cells[idx]!;
        return {
          content: sourceToString(cell.source),
          isError: false,
          metadata: {
            cellIndex: idx,
            cellType: cell.cell_type,
            executionCount: cell.execution_count,
            hasOutputs: (cell.outputs?.length ?? 0) > 0,
            path,
          },
        };
      }

      case 'replace': {
        const idx = input.cell_index as number;
        const source = input.source as string;
        if (idx === undefined) return { content: 'Missing cell_index.', isError: true };
        if (source === undefined) return { content: 'Missing source.', isError: true };
        if (idx < 0 || idx >= nb.cells.length) {
          return { content: `Cell index ${idx} out of range (0-${nb.cells.length - 1}).`, isError: true };
        }
        nb.cells[idx]!.source = stringToSource(source);
        writeNotebook(path, nb);
        return {
          content: `Cell [${idx}] updated.`,
          isError: false,
          metadata: { cellIndex: idx, path },
        };
      }

      case 'insert': {
        const idx = input.cell_index as number | undefined;
        const cellType = (input.cell_type as string) || 'code';
        const source = input.source as string | undefined;
        const insertIdx = idx !== undefined ? idx : nb.cells.length;
        if (insertIdx < 0 || insertIdx > nb.cells.length) {
          return { content: `Insert index ${insertIdx} out of range (0-${nb.cells.length}).`, isError: true };
        }
        const newCell: NotebookCell = {
          cell_type: cellType as 'code' | 'markdown',
          source: source ? stringToSource(source) : [],
          metadata: {},
        };
        if (cellType === 'code') {
          newCell.outputs = [];
          newCell.execution_count = null;
        }
        nb.cells.splice(insertIdx, 0, newCell);
        writeNotebook(path, nb);
        return {
          content: `${cellType} cell inserted at [${insertIdx}].`,
          isError: false,
          metadata: { cellIndex: insertIdx, cellType, path },
        };
      }

      case 'delete': {
        const idx = input.cell_index as number;
        if (idx === undefined) return { content: 'Missing cell_index.', isError: true };
        if (idx < 0 || idx >= nb.cells.length) {
          return { content: `Cell index ${idx} out of range (0-${nb.cells.length - 1}).`, isError: true };
        }
        const cellType = nb.cells[idx]!.cell_type;
        nb.cells.splice(idx, 1);
        writeNotebook(path, nb);
        return {
          content: `${cellType} cell [${idx}] deleted.`,
          isError: false,
          metadata: { cellIndex: idx, cellType, path },
        };
      }

      default:
        return {
          content: `Unknown action: ${action}. Valid: list, read, replace, insert, delete.`,
          isError: true,
        };
    }
  } catch (err) {
    return {
      content: `Notebook edit error: ${(err as Error).message}`,
      isError: true,
    };
  }
};
