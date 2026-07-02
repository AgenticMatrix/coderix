import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import type { ToolExecutor } from '../types.js';
import { computeDiff, formatDiff } from '../shared/diff.js';

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
