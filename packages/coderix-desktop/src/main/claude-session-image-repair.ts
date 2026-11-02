/**
 * Repair corrupted image blocks in a Claude Code session transcript.
 *
 * Claude Code stores every image a tool returned as a base64 block in its
 * session JSONL and replays that history on `--resume`. If one block does not
 * decode as the media type it claims (typically a screenshot whose download was
 * cut short), the provider rejects the entire request with a 400 and the
 * conversation can never continue — every new turn resends the same bad block
 * at the same message index.
 *
 * Replacing the block with a text placeholder keeps the tool_result ↔ tool_use
 * pairing intact (deleting the result would leave an orphaned tool_use), so the
 * session resumes and the model simply learns that image was unavailable.
 */

import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { isValidBase64Image } from '../../../coderix-core/src/index.js';

/** Placeholder text left in place of a corrupt image block. */
const CORRUPT_IMAGE_PLACEHOLDER = '[图片数据已损坏，已从会话历史中移除]';

/** The provider's rejection of a history that carries an undecodable image. */
const UNSUPPORTED_IMAGE_ERROR_RE =
  /API Error:\s*400[\s\S]*?(?:unsupported image|could not process image)/i;

export interface ImageRepairResult {
  /** Number of image blocks replaced with text. */
  repaired: number;
  /** Backup written before the file was modified, when anything was repaired. */
  backupPath?: string;
}

/**
 * True when a turn failed solely because a replayed image block is invalid.
 * Matches the provider's `messages.N.content.M.tool_result.image[0]` error.
 */
export function isUnsupportedImageApiError(message: string): boolean {
  return UNSUPPORTED_IMAGE_ERROR_RE.test(message);
}

/** The `claude` CLI's config root (`~/.claude` unless overridden). */
export function claudeConfigDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR?.trim();
  return override || join(homedir(), '.claude');
}

/**
 * Claude Code names a project directory after the cwd with every
 * non-alphanumeric character replaced by `-`.
 */
export function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * Locate a session transcript. Prefers the encoded project dir for `cwd`, then
 * scans all project dirs (the session may have been created under a symlinked
 * or differently-normalized path).
 */
export function findClaudeSessionFile(sessionId: string, cwd?: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(sessionId)) return null;
  const projectsDir = join(claudeConfigDir(), 'projects');
  if (cwd) {
    const direct = join(projectsDir, encodeClaudeProjectDir(cwd), `${sessionId}.jsonl`);
    if (existsSync(direct)) return direct;
  }
  try {
    for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(projectsDir, entry.name, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // No config dir yet — nothing to repair.
  }
  return null;
}

interface ImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
}

function isImageBlock(node: unknown): node is ImageBlock {
  if (!node || typeof node !== 'object') return false;
  const block = node as Partial<ImageBlock>;
  return (
    block.type === 'image' &&
    typeof block.source === 'object' &&
    block.source !== null &&
    block.source.type === 'base64' &&
    typeof block.source.media_type === 'string' &&
    typeof block.source.data === 'string'
  );
}

/** Walk a parsed transcript line, replacing invalid image blocks in place. */
function replaceInvalidImages(node: unknown): number {
  if (!node || typeof node !== 'object') return 0;
  if (Array.isArray(node)) {
    let repaired = 0;
    for (let i = 0; i < node.length; i++) {
      const item = node[i];
      if (isImageBlock(item) && !isValidBase64Image(item.source.media_type, item.source.data)) {
        node[i] = { type: 'text', text: CORRUPT_IMAGE_PLACEHOLDER };
        repaired += 1;
        continue;
      }
      repaired += replaceInvalidImages(item);
    }
    return repaired;
  }
  let repaired = 0;
  for (const value of Object.values(node)) {
    repaired += replaceInvalidImages(value);
  }
  return repaired;
}

/**
 * Replace every invalid image block in a session transcript with text.
 * Writes a timestamped backup next to the file before modifying it.
 */
export function repairInvalidImagesInSessionFile(filePath: string): ImageRepairResult {
  const raw = readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n');
  let repaired = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || !line.includes('"image"')) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const count = replaceInvalidImages(entry);
    if (count > 0) {
      repaired += count;
      lines[i] = JSON.stringify(entry);
    }
  }
  if (repaired === 0) return { repaired: 0 };

  const backupPath = `${filePath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  copyFileSync(filePath, backupPath);
  // Write-then-rename so a crash mid-write can't leave the transcript truncated.
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, lines.join('\n'), 'utf-8');
  renameSync(tmpPath, filePath);
  return { repaired, backupPath };
}

/**
 * Sessions already scanned in this process. The transcript grows on every turn,
 * so re-validating all historical images each time would burn CPU for no gain;
 * images added by the current turn are covered by the retry path instead.
 */
const preflightScanned = new Set<string>();

/** Validate a resumed session once per process, repairing any bad images. */
export function repairClaudeSessionImagesOnce(filePath: string): ImageRepairResult {
  if (preflightScanned.has(filePath)) return { repaired: 0 };
  preflightScanned.add(filePath);
  return repairInvalidImagesInSessionFile(filePath);
}

/** Test seam: forget which sessions were already preflight-scanned. */
export function resetClaudeSessionPreflightCache(): void {
  preflightScanned.clear();
}
