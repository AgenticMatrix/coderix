import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ToolExecutor } from '../types.js';
import { computeDiff, formatDiff } from '../shared/diff.js';

export const execute: ToolExecutor = async (input, opts) => {
  if (!opts.allowMutation) {
    return { content: 'Error: edit tool is not available (mutation tools disabled)', isError: true };
  }

  const filePath = input.file_path as string;
  const oldStr = input.old_string as string;
  const newStr = input.new_string as string;
  const replaceAll = input.replace_all as boolean;

  if (!filePath || !oldStr || newStr === undefined) {
    return { content: 'Error: file_path, old_string, and new_string are required', isError: true };
  }

  try {
    const fullPath = resolve(opts.cwd, filePath);
    const oldContent = readFileSync(fullPath, 'utf-8');

    if (!oldContent.includes(oldStr)) {
      return { content: `Error: old_string not found in ${filePath}`, isError: true };
    }

    let newContent: string;
    if (replaceAll) {
      newContent = oldContent.split(oldStr).join(newStr);
    } else {
      newContent = oldContent.replace(oldStr, newStr);
    }

    writeFileSync(fullPath, newContent, 'utf-8');

    // Compute diff
    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');
    const diff = computeDiff(oldLines, newLines);
    const addedLines = diff.filter(d => d.type === 'add').length;
    const removedLines = diff.filter(d => d.type === 'remove').length;
    const diffOutput = formatDiff(diff);

    return {
      content: `File edited: ${filePath}`,
      isError: false,
      metadata: {
        filePath,
        addedLines,
        removedLines,
        diffLines: diffOutput,
      },
    };
  } catch (err) {
    return { content: `Error editing file: ${(err as Error).message}`, isError: true };
  }
};
