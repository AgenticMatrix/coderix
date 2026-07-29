import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import type { ToolExecutor } from '../types.js';

const IMAGE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg',
]);

function imageMediaType(ext: string): string {
  switch (ext) {
    case '.png': return 'image/png';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    default: return 'image/png';
  }
}

export const execute: ToolExecutor = async (input, opts) => {
  const filePath = input.file_path as string;
  const offset = (input.offset as number) ?? undefined;
  const limit = (input.limit as number) ?? undefined;

  if (!filePath) return { content: 'Error: file_path is required', isError: true };

  const startTime = Date.now();

  try {
    const fullPath = resolve(opts.cwd, filePath);
    const ext = extname(fullPath).toLowerCase();

    // Image files: read as base64, return as proper image content block
    if (IMAGE_EXTS.has(ext) && !offset && !limit) {
      const buf = await readFile(fullPath);
      const data = buf.toString('base64');
      const mediaType = imageMediaType(ext);
      const duration = Date.now() - startTime;
      return {
        content: '',
        isError: false,
        duration,
        metadata: { filePath },
        image: { data, media_type: mediaType },
      };
    }

    const content = await readFile(fullPath, 'utf-8');
    const lines = content.split('\n');
    const startLine = offset ? offset - 1 : 0;
    const endLine = limit ? startLine + limit : lines.length;
    const result = lines.slice(startLine, endLine).join('\n');
    const duration = Date.now() - startTime;

    // Track for post-compact file restoration
    if (opts.readFileTracker && !input.offset && !input.limit) {
      opts.readFileTracker.record(fullPath, result);
    }

    if (result.length > opts.maxOutput) {
      return {
        content: result.slice(0, opts.maxOutput) + '\n... (output truncated)',
        isError: false,
        duration,
        metadata: { filePath },
      };
    }
    return { content: result, isError: false, duration, metadata: { filePath } };
  } catch (err) {
    const duration = Date.now() - startTime;
    return {
      content: `Error reading file: ${(err as Error).message}`,
      isError: true,
      duration,
      metadata: { filePath },
    };
  }
};
