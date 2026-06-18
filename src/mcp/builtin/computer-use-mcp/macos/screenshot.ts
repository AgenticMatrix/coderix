/**
 * macOS Screenshot — screencapture wrapper.
 *
 * Uses /usr/sbin/screencapture for full-screen captures.
 * Returns base64-encoded PNG data with dimensions.
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ScreenshotResult {
  data: string;      // base64 PNG
  width: number;
  height: number;
  format: 'png';
}

/**
 * Take a full-screen screenshot (all displays).
 * Returns base64 PNG with pixel dimensions.
 */
export function takeScreenshot(): ScreenshotResult {
  const tmpPath = join(tmpdir(), `coderix-cu-screenshot-${Date.now()}.png`);

  try {
    // -x: no sound, -C: capture cursor
    execSync(`/usr/sbin/screencapture -x -C "${tmpPath}"`, {
      timeout: 10_000,
      stdio: 'pipe',
    });

    if (!existsSync(tmpPath)) {
      throw new Error('screencapture did not produce output');
    }

    const buffer = readFileSync(tmpPath);
    const data = buffer.toString('base64');

    // Get image dimensions via sips (macOS built-in)
    let width = 0;
    let height = 0;
    try {
      const dims = execSync(`/usr/bin/sips -g pixelWidth -g pixelHeight "${tmpPath}"`, {
        timeout: 5000,
        stdio: 'pipe',
      }).toString();

      const wMatch = dims.match(/pixelWidth:\s*(\d+)/);
      const hMatch = dims.match(/pixelHeight:\s*(\d+)/);
      if (wMatch) width = parseInt(wMatch[1]!, 10);
      if (hMatch) height = parseInt(hMatch[1]!, 10);
    } catch {
      // Ignore dimension errors — return 0x0
    }

    return { data, width, height, format: 'png' };
  } finally {
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

/**
 * Crop a base64 image to the specified region.
 * Uses sips for cropping (built-in on macOS).
 */
export function cropScreenshot(
  base64Data: string,
  region: { x: number; y: number; width: number; height: number },
): ScreenshotResult {
  const srcPath = join(tmpdir(), `coderix-cu-original-${Date.now()}.png`);
  const outPath = join(tmpdir(), `coderix-cu-cropped-${Date.now()}.png`);

  try {
    const buffer = Buffer.from(base64Data, 'base64');
    writeFileSync(srcPath, buffer);

    execSync(
      `/usr/bin/sips -c ${region.height} ${region.width} "${srcPath}" --cropOffset ${region.y} ${region.x} -o "${outPath}"`,
      { timeout: 10_000, stdio: 'pipe' },
    );

    const cropped = readFileSync(outPath);
    return {
      data: cropped.toString('base64'),
      width: region.width,
      height: region.height,
      format: 'png',
    };
  } finally {
    try { if (existsSync(srcPath)) unlinkSync(srcPath); } catch { /* ignore */ }
    try { if (existsSync(outPath)) unlinkSync(outPath); } catch { /* ignore */ }
  }
}

/** Save a base64 screenshot to disk. Returns the file path. */
export function saveScreenshot(base64Data: string, filename?: string): string {
  const name = filename || `screenshot-${Date.now()}.png`;
  const destPath = join(process.cwd(), name);
  const buffer = Buffer.from(base64Data, 'base64');
  writeFileSync(destPath, buffer);
  return destPath;
}
