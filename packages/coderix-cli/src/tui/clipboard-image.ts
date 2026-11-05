/**
 * clipboard-image.ts — read an image off the OS clipboard for the TUI.
 *
 * A terminal cannot deliver image bytes through stdin: `Cmd+V` on an image puts
 * nothing useful on the input stream, so the app has to ask the OS clipboard
 * directly. This module does that with the platform's own tool and returns the
 * payload the engine already understands (`{ mediaType, data }`, raw base64).
 *
 * Every command is spawned with `execFile` and a fixed argument list, never a
 * shell string, so clipboard content can never be interpreted as a command.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { isValidImageBuffer, type SupportedImageMediaType } from '@coderix/core';

const execFileAsync = promisify(execFile);

/** Source files above this are almost certainly not a screenshot. */
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

/**
 * Long-edge ceiling. Matches the desktop composer: providers bill by pixels,
 * and an uncapped 5K screenshot costs far more tokens than it is worth.
 */
export const MAX_EDGE = 1568;

/** How many images one turn may carry. Each is replayed into later context. */
export const MAX_PENDING_IMAGES = 4;

export interface ClipboardImage {
  mediaType: SupportedImageMediaType;
  /** Raw base64 — no `data:` prefix. */
  data: string;
  width: number;
  height: number;
  bytes: number;
}

export interface ClipboardImageError {
  code: 'unsupported-platform' | 'no-image' | 'too-large' | 'read-failed';
  message: string;
}

export type ClipboardImageResult =
  | { ok: true; image: ClipboardImage }
  | { ok: false; error: ClipboardImageError };

// ── Platform probes ─────────────────────────────────────────────────

/**
 * macOS keeps the image on the pasteboard under a UTI, not as bytes on stdin.
 * AppleScript is the only stock way to pull it out, and it can only write to a
 * file — `the clipboard as «class PNGf»` on stdout yields a hex dump, not raw
 * bytes.
 */
async function readMacOSClipboard(): Promise<Buffer | null> {
  const dir = await mkdtemp(join(tmpdir(), 'coderix-clip-'));
  const target = join(dir, 'clip.png');
  const script = [
    `set f to (open for access POSIX file ${JSON.stringify(target)} with write permission)`,
    'try',
    'set eof f to 0',
    'write (the clipboard as «class PNGf») to f',
    'close access f',
    'on error',
    'close access f',
    'error "no-image"',
    'end try',
  ].join('\n');

  try {
    await execFileAsync('osascript', ['-e', script]);
    return await readFile(target);
  } catch {
    // AppleScript raises when the pasteboard holds no PNG (text, a file, etc.).
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Wayland (`wl-paste`) and X11 (`xclip`) both write raw bytes to stdout once a
 * concrete MIME type is requested.
 */
async function readLinuxClipboard(): Promise<Buffer | null> {
  const attempts: Array<[string, string[]]> = [
    ['wl-paste', ['--type', 'image/png', '--no-newline']],
    ['xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']],
  ];

  for (const [cmd, args] of attempts) {
    try {
      const { stdout } = await execFileAsync(cmd, args, {
        encoding: 'buffer',
        maxBuffer: MAX_SOURCE_BYTES,
      });
      if (stdout.length > 0) return stdout;
    } catch {
      // Tool absent or the clipboard has no image — try the next one.
    }
  }
  return null;
}

/**
 * PowerShell 7 exposes the clipboard image as a real object; Windows
 * PowerShell 5.1 needs the WinForms route. Try the modern one first.
 */
async function readWindowsClipboard(): Promise<Buffer | null> {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$img = [System.Windows.Forms.Clipboard]::GetImage()',
    'if ($img -eq $null) { exit 1 }',
    '$ms = New-Object System.IO.MemoryStream',
    '$img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)',
    '[Convert]::ToBase64String($ms.ToArray())',
  ].join('; ');

  try {
    const { stdout } = await execFileAsync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', maxBuffer: MAX_SOURCE_BYTES * 2 },
    );
    const b64 = stdout.trim();
    return b64 ? Buffer.from(b64, 'base64') : null;
  } catch {
    return null;
  }
}

async function readNativeClipboard(): Promise<Buffer | null> {
  switch (process.platform) {
    case 'darwin': return readMacOSClipboard();
    case 'linux': return readLinuxClipboard();
    case 'win32': return readWindowsClipboard();
    default: return null;
  }
}

// ── Image inspection ────────────────────────────────────────────────

interface Dimensions { width: number; height: number }

/**
 * Read the pixel size straight from the header. Pulling in an image library
 * for four magic numbers is not worth the dependency.
 */
export function dimensionsOf(buf: Buffer): Dimensions | null {
  // PNG: IHDR width/height are big-endian at offset 16.
  if (buf.length >= 24 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  // GIF: little-endian logical screen size at offset 6.
  if (buf.length >= 10 && buf.subarray(0, 3).toString('latin1') === 'GIF') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }

  // WebP: three container layouts, all after the 'WEBP' tag at offset 12.
  if (buf.length >= 30 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    const kind = buf.subarray(12, 16).toString('latin1');
    if (kind === 'VP8X') {
      return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    }
    if (kind === 'VP8L') {
      const bits = buf.readUInt32LE(21);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
    if (kind === 'VP8 ' && buf.length >= 30) {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
  }

  // JPEG: walk the segment chain to the first Start-Of-Frame marker.
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) { offset++; continue; }
      const marker = buf[offset + 1]!;
      // SOF0..SOF15, excluding DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
      }
      const length = buf.readUInt16BE(offset + 2);
      if (length < 2) return null;
      offset += 2 + length;
    }
  }

  return null;
}

/**
 * Scale so the long edge fits `MAX_EDGE`. Returns null when the image already
 * fits — the caller then forwards the bytes untouched and avoids a re-encode.
 */
export function planResize(width: number, height: number): Dimensions | null {
  if (width <= 0 || height <= 0) return null;
  if (width <= MAX_EDGE && height <= MAX_EDGE) return null;
  const scale = MAX_EDGE / Math.max(width, height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** One-line label shown in the transcript; a terminal cannot draw the image. */
export function describeImage(image: {
  mediaType: string;
  width?: number;
  height?: number;
  bytes?: number;
}): string {
  const format = image.mediaType.replace('image/', '').toUpperCase();
  // Queue-resurfaced images carry no measured size; show what is known.
  const size = image.width && image.height ? `${image.width}×${image.height} ` : '';
  const kb = image.bytes ? Math.max(1, Math.round(image.bytes / 1024)) + 'KB' : '';
  return `${size}${format}${kb ? ' ' + kb : ''}`.trim();
}

// ── Public entry point ──────────────────────────────────────────────

/**
 * Read the image currently on the clipboard.
 *
 * Returns a discriminated result rather than throwing: a missing image is the
 * common case (the user pressed Ctrl+V with text on the clipboard), not an
 * error worth a stack trace in the transcript.
 */
export async function readClipboardImage(): Promise<ClipboardImageResult> {
  if (!['darwin', 'linux', 'win32'].includes(process.platform)) {
    return {
      ok: false,
      error: { code: 'unsupported-platform', message: `clipboard images are not supported on ${process.platform}` },
    };
  }

  let buf: Buffer | null;
  try {
    buf = await readNativeClipboard();
  } catch {
    buf = null;
  }
  if (!buf || buf.length === 0) {
    return { ok: false, error: { code: 'no-image', message: 'no image on the clipboard' } };
  }
  if (buf.length > MAX_SOURCE_BYTES) {
    return { ok: false, error: { code: 'too-large', message: `image is ${Math.round(buf.length / 1024 / 1024)}MB, limit is 8MB` } };
  }

  // Trust the bytes, not the platform: macOS always hands back PNG, but a
  // Linux or Windows clipboard could hold any of the four supported formats.
  const mediaType = sniffMediaType(buf);
  if (!mediaType || !isValidImageBuffer(mediaType, buf)) {
    return { ok: false, error: { code: 'read-failed', message: 'clipboard image could not be decoded' } };
  }

  const size = dimensionsOf(buf) ?? { width: 0, height: 0 };

  // Only oversize images get re-encoded; a screenshot that already fits keeps
  // its exact bytes (and GIF keeps its animation).
  const target = planResize(size.width, size.height);
  if (target && mediaType !== 'image/gif') {
    const shrunk = await shrinkToFit(buf, mediaType, target);
    if (shrunk !== buf) {
      const resized = dimensionsOf(shrunk);
      return {
        ok: true,
        image: {
          mediaType: 'image/png',
          data: shrunk.toString('base64'),
          width: resized?.width ?? target.width,
          height: resized?.height ?? target.height,
          bytes: shrunk.length,
        },
      };
    }
  }

  return {
    ok: true,
    image: {
      mediaType,
      data: buf.toString('base64'),
      width: size.width,
      height: size.height,
      bytes: buf.length,
    },
  };
}

function sniffMediaType(buf: Buffer): SupportedImageMediaType | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png';
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.length >= 3 && buf.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * Shrink an oversize image before it goes into the transcript.
 *
 * No image library is available at this layer, so this leans on tools that ship
 * with the OS (`sips` on macOS, ImageMagick elsewhere). Both are optional: when
 * neither is present the original bytes are returned and the caller still gets
 * a working turn — the 8MB source cap keeps that from being unbounded.
 */
async function shrinkToFit(buf: Buffer, mediaType: SupportedImageMediaType, target: Dimensions): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'coderix-resize-'));
  const source = join(dir, `in.${extensionFor(mediaType)}`);
  const output = join(dir, 'out.png');
  try {
    await writeFile(source, buf);
    await execFileAsync('sips', ['-Z', String(Math.max(target.width, target.height)), '-s', 'format', 'png', source, '--out', output]).catch(async () => {
      await execFileAsync('magick', [source, '-resize', `${target.width}x${target.height}>`, output]);
    });
    return await readFile(output);
  } catch {
    return buf;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function extensionFor(mediaType: SupportedImageMediaType): string {
  switch (mediaType) {
    case 'image/png': return 'png';
    case 'image/jpeg': return 'jpg';
    case 'image/gif': return 'gif';
    case 'image/webp': return 'webp';
  }
}
