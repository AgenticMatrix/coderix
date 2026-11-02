import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import type { ToolExecutor } from '../types.js';
import { imageMediaTypeForPath, isValidImageBuffer } from '../../utils/image-validation.js';

/**
 * Image formats the model API rejects. They used to fall through to
 * `image/png`, which made every BMP/TIFF read fail the whole request with a
 * 400 instead of telling the model the format is unsupported.
 */
const UNSUPPORTED_IMAGE_EXTS = new Set(['.bmp', '.tif', '.tiff', '.ico', '.heic', '.heif', '.avif']);

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
    const mediaType = imageMediaTypeForPath(fullPath);
    if (mediaType && !offset && !limit) {
      const buf = await readFile(fullPath);
      // An interrupted download leaves a file that still starts with the PNG
      // signature but no IEND chunk; sending it as an image block makes the
      // provider reject the entire request, so surface it as a tool error.
      if (!isValidImageBuffer(mediaType, buf)) {
        return {
          content: `Error: ${fullPath} is not a valid ${mediaType} image (truncated or corrupt). Re-generate or re-download it, or convert it to PNG/JPEG.`,
          isError: true,
          duration: Date.now() - startTime,
          metadata: { filePath },
        };
      }
      return {
        content: '',
        isError: false,
        duration: Date.now() - startTime,
        metadata: { filePath },
        image: { data: buf.toString('base64'), media_type: mediaType },
      };
    }

    if (UNSUPPORTED_IMAGE_EXTS.has(ext) && !offset && !limit) {
      return {
        content: `Error: ${ext} images are not supported by the model API (allowed: PNG, JPEG, GIF, WebP). Convert the file first.`,
        isError: true,
        duration: Date.now() - startTime,
        metadata: { filePath },
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
