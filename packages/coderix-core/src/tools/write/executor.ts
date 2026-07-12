import { writeFile, readFile, access } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import type { ToolExecutor } from '../types.js';
import { computeDiff, formatDiff } from '../shared/diff.js';

export const execute: ToolExecutor = async (input, opts) => {
  const filePath = input.file_path as string;
  const content = input.content as string;

  if (!filePath) return { content: 'Error: file_path is required', isError: true };
  if (content === undefined) return { content: 'Error: content is required', isError: true };

  // In plan mode, only allow writing .md and .txt files
  if (opts.planModeState && !opts.planModeState.hasExitedPlanMode) {
    const ext = filePath.toLowerCase().split('.').pop();
    if (ext !== 'md' && ext !== 'txt') {
      return {
        content: 'Plan mode: can only write to .md or .txt files. Use the plan file path shown in the system instructions.',
        isError: true,
      };
    }
  }

  try {
    const fullPath = resolve(opts.cwd, filePath);
    const relPath = relative(opts.cwd, fullPath) || filePath;
    let fileExists = false;
    try {
      await access(fullPath);
      fileExists = true;
    } catch {
      // file does not exist
    }

    let oldLines: string[] = [];
    if (fileExists) {
      try {
        const oldContent = await readFile(fullPath, 'utf-8');
        oldLines = oldContent.split('\n');
      } catch {
        // If we can't read, treat as new file
      }
    }

    await writeFile(fullPath, content, 'utf-8');
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
