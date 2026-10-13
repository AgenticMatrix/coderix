/**
 * Blender stream — a live MJPEG viewport feed of the running Blender scene, so
 * the "blender-viewer" panel can show the model being built in near-real time
 * (the closest "web way" to putting Blender itself in the right panel — its
 * native GUI can't be embedded, but its render can be streamed as a live image).
 *
 * The server exposes `GET /live` as a `multipart/x-mixed-replace` stream (an
 * `<img src=…>` auto-refreshes — no client JS needed). Frames are produced only
 * while at least one client is connected, rendered EEVEE at half resolution to
 * JPEG (~2–3 fps), and never run concurrently with the preview renderer's own
 * frame (single Blender instance, single scene).
 */

import { createServer, type Server, type ServerResponse } from 'node:http';
import { ipcMain } from 'electron';
import { readFileSync } from 'node:fs';
import { sendCode } from './blender-preview.js';
import { resolveBlenderHost, resolveBlenderPort, resolveBlenderStreamPath } from './blender-paths.js';

export const BLENDER_STREAM_CHANNELS = {
  URL: 'blenderStream:url',
} as const;

export const BLENDER_STREAM_HOST = '127.0.0.1';
export const BLENDER_STREAM_PORT = 3247;

/** Target frame interval (ms) — EEVEE at half res is ~0.3–1s/frame. */
const FRAME_INTERVAL_MS = 400;

const MIME_BOUNDARY = 'blender-frame';

interface BlenderResponse {
  status?: string;
  message?: string;
  stderr?: string;
}

/** Render the current scene to `outPath` as a low-quality JPEG, return its bytes. */
async function renderFrameToJpeg(host: string, port: number, outPath: string): Promise<Buffer | null> {
  const code = [
    'import bpy, os',
    'scene = bpy.context.scene',
    `out = ${JSON.stringify(outPath)}`,
    "os.makedirs(os.path.dirname(out), exist_ok=True)",
    'if scene.camera is None:',
    '    cams = [o for o in scene.objects if o.type == "CAMERA"]',
    '    if cams:',
    '        scene.camera = cams[0]',
    '    else:',
    '        bpy.ops.object.camera_add()',
    '        scene.camera = bpy.context.active_object',
    'rd = scene.render',
    "rd.engine = 'BLENDER_EEVEE'",
    'rd.resolution_percentage = 50',
    "rd.filepath = out",
    "rd.image_settings.file_format = 'JPEG'",
    'rd.image_settings.quality = 70',
    'bpy.ops.render.render(write_still=True)',
    'result = {"status": "ok", "filepath": out}',
  ].join('\n');

  const r = (await sendCode(host, port, code, true, 60_000)) as BlenderResponse;
  if (r && r.status === 'ok') {
    try {
      return readFileSync(outPath);
    } catch {
      return null;
    }
  }
  return null;
}

export interface BlenderStreamManager {
  url(): Promise<{ url: string }>;
  destroy(): void;
}

export function createBlenderStreamManager(): BlenderStreamManager {
  const host = resolveBlenderHost();
  const port = resolveBlenderPort();
  const streamPath = resolveBlenderStreamPath();
  const streamUrl = `http://${BLENDER_STREAM_HOST}:${BLENDER_STREAM_PORT}/live`;

  const clients = new Set<ServerResponse>();
  let latestFrame: Buffer | null = null;
  let renderInFlight = false;
  let loopRunning = false;

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  function writeFrame(res: ServerResponse, frame: Buffer): void {
    res.write(`--${MIME_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
    res.write(frame);
    res.write('\r\n');
  }

  function broadcast(frame: Buffer): void {
    for (const res of clients) {
      try {
        writeFrame(res, frame);
      } catch {
        // client went away — the close handler removes it
      }
    }
  }

  /** Produce frames while clients are connected; skip a tick while a render is in flight. */
  function ensureLoop(): void {
    if (loopRunning) return;
    loopRunning = true;
    void (async () => {
      while (clients.size > 0) {
        if (!renderInFlight) {
          renderInFlight = true;
          try {
            const frame = await renderFrameToJpeg(host, port, streamPath);
            if (frame) {
              latestFrame = frame;
              broadcast(frame);
            }
          } catch {
            // Blender busy / disconnected — skip this frame
          } finally {
            renderInFlight = false;
          }
        }
        await sleep(FRAME_INTERVAL_MS);
      }
      loopRunning = false;
    })();
  }

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', streamUrl);
    if (url.pathname !== '/live') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': `multipart/x-mixed-replace; boundary=${MIME_BOUNDARY}`,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Connection: 'keep-alive',
    });
    clients.add(res);
    // Seed the client immediately with the last frame so it isn't blank on load.
    if (latestFrame) {
      try {
        writeFrame(res, latestFrame);
      } catch {
        // ignore
      }
    }
    ensureLoop();
    req.on('close', () => clients.delete(res));
  });
  server.listen(BLENDER_STREAM_PORT, BLENDER_STREAM_HOST, () => {
    console.log(`[BlenderStream] serving MJPEG viewport at ${streamUrl}`);
  });

  ipcMain.handle(BLENDER_STREAM_CHANNELS.URL, () => ({ url: streamUrl }));

  return {
    url: () => Promise.resolve({ url: streamUrl }),
    destroy(): void {
      ipcMain.removeHandler(BLENDER_STREAM_CHANNELS.URL);
      for (const res of clients) {
        try {
          res.end();
        } catch {
          // ignore
        }
      }
      clients.clear();
      server.close();
    },
  };
}
