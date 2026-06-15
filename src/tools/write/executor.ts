import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import type { ToolExecutor } from '../types.js';

interface DiffLine {
  type: 'add' | 'remove' | 'context';
  oldNum?: number;
  newNum?: number;
  text: string;
}

function computeDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  const m = oldLines.length;
  const n = newLines.length;

  // Build LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to produce raw diff (reversed, will flip)
  const raw: DiffLine[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      raw.push({ type: 'context', oldNum: i, newNum: j, text: oldLines[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      raw.push({ type: 'add', newNum: j, text: newLines[j - 1] });
      j--;
    } else {
      raw.push({ type: 'remove', oldNum: i, text: oldLines[i - 1] });
      i--;
    }
  }
  raw.reverse();

  // Git-style: group into hunks with 3 lines of context
  const CONTEXT = 3;
  const result: DiffLine[] = [];
  const changeIndices: number[] = [];
  for (let k = 0; k < raw.length; k++) {
    if (raw[k].type !== 'context') changeIndices.push(k);
  }

  if (changeIndices.length === 0) return raw; // no changes at all

  // Expand each change index to include CONTEXT lines around it
  const included = new Set<number>();
  for (const ci of changeIndices) {
    for (let k = Math.max(0, ci - CONTEXT); k <= Math.min(raw.length - 1, ci + CONTEXT); k++) {
      included.add(k);
    }
  }

  // Build result, collapsing long context gaps into a single "... N unchanged lines" marker
  let lastIncluded = -2;
  for (let k = 0; k < raw.length; k++) {
    if (included.has(k)) {
      if (lastIncluded < k - 1 && lastIncluded >= 0) {
        result.push({ type: 'context', text: `...` });
      }
      result.push(raw[k]);
      lastIncluded = k;
    }
  }

  return result;
}

function formatDiff(diff: DiffLine[]): string[] {
  const lines: string[] = [];
  for (const d of diff) {
    if (d.type === 'add') {
      lines.push(`${String(d.newNum).padStart(4)} +${d.text}`);
    } else if (d.type === 'remove') {
      lines.push(`${String(d.oldNum).padStart(4)} -${d.text}`);
    } else if (d.text === '...') {
      lines.push(`     ...`);
    } else {
      lines.push(`${String(d.newNum).padStart(4)}  ${d.text}`);
    }
  }
  return lines;
}

export const execute: ToolExecutor = async (input, opts) => {
  if (!opts.allowMutation) {
    return { content: 'Error: write tool is not available (mutation tools disabled)', isError: true };
  }

  const filePath = input.file_path as string;
  const content = input.content as string;

  if (!filePath) return { content: 'Error: file_path is required', isError: true };
  if (content === undefined) return { content: 'Error: content is required', isError: true };

  try {
    const fullPath = resolve(opts.cwd, filePath);
    const relPath = relative(opts.cwd, fullPath) || filePath;
    const fileExists = existsSync(fullPath);

    let oldLines: string[] = [];
    if (fileExists) {
      try {
        const oldContent = readFileSync(fullPath, 'utf-8');
        oldLines = oldContent.split('\n');
      } catch {
        // If we can't read, treat as new file
      }
    }

    writeFileSync(fullPath, content, 'utf-8');
    const newLines = content.split('\n');

    if (fileExists && oldLines.length > 0) {
      // Compute diff for existing file overwrite
      const diff = computeDiff(oldLines, newLines);
      const addedLines = diff.filter(d => d.type === 'add').length;
      const removedLines = diff.filter(d => d.type === 'remove').length;
      const diffOutput = formatDiff(diff);

      return {
        content: `File written: ${relPath} (${addedLines} added, ${removedLines} removed)`,
        isError: false,
        metadata: {
          filePath: relPath,
          addedLines,
          removedLines,
          diffLines: diffOutput,
          isNewFile: false,
        },
      };
    }

    // New file
    return {
      content: `File written: ${relPath}`,
      isError: false,
      metadata: {
        filePath: relPath,
        addedLines: newLines.length,
        removedLines: 0,
        diffLines: newLines.map((l, i) => `${String(i + 1).padStart(4)} +${l}`),
        isNewFile: true,
      },
    };
  } catch (err) {
    return { content: `Error writing file: ${(err as Error).message}`, isError: true };
  }
};
