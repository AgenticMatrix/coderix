/**
 * Claude Code Read guard — validate an image file before it becomes a
 * tool_result image block.
 *
 * The CLI turns image files into base64 blocks itself. A truncated file (an
 * interrupted download is the usual cause) still carries the PNG/JPEG
 * signature, so it is sent as-is and the provider rejects the *whole request*
 * with 400 "unsupported image" — the turn dies and the bad block stays in the
 * transcript. Denying the Read up front turns that into an ordinary tool error
 * the model can react to, and keeps invalid data out of the session history.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { imageMediaTypeForPath, isValidImageBuffer } from '../../../coderix-core/src/index.js';

export function buildImageReadValidationHook(cwd: string): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Read') return {};

    const toolInput = input.tool_input as { file_path?: unknown } | undefined;
    const filePath = typeof toolInput?.file_path === 'string' ? toolInput.file_path : '';
    if (!filePath) return {};

    // Only files the CLI will inline as image blocks need checking; anything
    // else (SVG, PDF, plain text) is read by the normal text path.
    const mediaType = imageMediaTypeForPath(filePath);
    if (!mediaType) return {};

    let buf: Buffer;
    try {
      buf = await readFile(resolve(cwd, filePath));
    } catch {
      // Missing or unreadable — let the Read tool report its own error.
      return {};
    }
    if (isValidImageBuffer(mediaType, buf)) return {};

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `${filePath} is not a valid ${mediaType} image (truncated or corrupt). ` +
          'Do not retry the same read: re-download or re-generate the file, or convert it to ' +
          'PNG/JPEG, then read it again.',
      },
    };
  };
}
