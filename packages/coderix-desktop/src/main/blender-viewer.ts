/**
 * Blender viewer — a tiny loopback HTTP server that serves an interactive
 * three.js `.glb` viewer page and the workspace's exported `.glb` files, so the
 * "blender-viewer" display panel can embed a real 3D view of the model (the
 * Blender analogue of cad_harness's `.step`/`.glb` viewer). Blender's own native
 * GUI can't be embedded in Electron — this viewer is the in-panel substitute.
 *
 * The viewer page fetches the model from `/file?path=<abs>` (same origin, so no
 * CORS) and renders it with OrbitControls (rotate/zoom/pan) plus a grid floor.
 * three.js is loaded from a CDN via an importmap; the app already requires the
 * network (LLM API + MCP), so this is an acceptable dependency.
 */

import { createServer, type Server } from 'node:http';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { ipcMain } from 'electron';
import path from 'node:path';

export const BLENDER_VIEWER_CHANNELS = {
  LIST_MODELS: 'blenderViewer:listModels',
  VIEWER_URL: 'blenderViewer:viewerUrl',
  STATUS: 'blenderViewer:status',
} as const;

export const BLENDER_VIEWER_HOST = '127.0.0.1';
export const BLENDER_VIEWER_PORT = 3246;

export interface BlenderModel {
  /** Display name (workspace-relative path). */
  name: string;
  /** Absolute path of the `.glb` file. */
  path: string;
  /** mtime (ms) for "most recently exported" ordering. */
  mtime: number;
}

const VIEWER_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Blender Viewer</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: #18181c; }
  #info { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
          color: #9a9aa3; font: 13px/1.5 -apple-system, "PingFang SC", sans-serif; }
  canvas { display: block; }
</style>
</head>
<body>
<div id="info">加载中…</div>
<script type="importmap">
{ "imports": {
    "three": "https://unpkg.com/three@0.160.0/build/three.module.js",
    "three/addons/": "https://unpkg.com/three@0.160.0/examples/jsm/"
} }
</script>
<script type="module">
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const info = document.getElementById('info');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1a1e);
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.01, 10000);
camera.position.set(4, 3, 6);

const hemi = new THREE.HemisphereLight(0xffffff, 0x33333a, 1.1);
scene.add(hemi);
const dir = new THREE.DirectionalLight(0xffffff, 2.0);
dir.position.set(5, 8, 4);
scene.add(dir);

const grid = new THREE.GridHelper(20, 20, 0x44444c, 0x26262b);
scene.add(grid);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

const params = new URLSearchParams(location.search);
const file = params.get('file');
if (file) {
  const loader = new GLTFLoader();
  loader.load(
    '/file?path=' + encodeURIComponent(file),
    (gltf) => {
      scene.add(gltf.scene);
      const box = new THREE.Box3().setFromObject(gltf.scene);
      if (box.isEmpty()) { info.textContent = ''; return; }
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z) || 1;
      const dist = maxDim / (2 * Math.tan((camera.fov * Math.PI) / 360));
      camera.position.copy(center).add(new THREE.Vector3(dist * 0.7, dist * 0.55, dist));
      camera.near = maxDim / 1000;
      camera.far = maxDim * 100;
      camera.updateProjectionMatrix();
      controls.target.copy(center);
      controls.update();
      info.textContent = '';
    },
    undefined,
    (err) => {
      info.textContent = '加载失败：' + ((err && err.message) || err || '未知错误');
    },
  );
} else {
  info.textContent = '未指定模型';
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
</script>
</body>
</html>`;

/** Recursively collect `.glb` files in a workspace, newest first. */
function listGlbFiles(dir: string): BlenderModel[] {
  const out: BlenderModel[] = [];
  const skipped = new Set(['node_modules', '__pycache__', '.git', '.coderix', '.claude', 'history']);
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !skipped.has(entry.name)) stack.push(abs);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.glb')) {
        try {
          const mtime = statSync(abs).mtimeMs;
          out.push({ name: path.relative(dir, abs).split(path.sep).join('/'), path: abs, mtime });
        } catch {
          // unreadable — skip
        }
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
}

export interface BlenderViewerManager {
  status(): Promise<{ running: boolean; baseUrl: string }>;
  listModels(dirPath: string): Promise<BlenderModel[]>;
  viewerUrl(fileAbs: string): Promise<{ url: string }>;
  destroy(): void;
}

export function createBlenderViewerManager(): BlenderViewerManager {
  const host = BLENDER_VIEWER_HOST;
  const port = BLENDER_VIEWER_PORT;
  const baseUrl = `http://${host}:${port}`;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', baseUrl);
    if (url.pathname === '/' || url.pathname === '') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(VIEWER_HTML);
      return;
    }
    if (url.pathname === '/file') {
      const p = url.searchParams.get('path');
      const lower = (p ?? '').toLowerCase();
      if (!p || !(lower.endsWith('.glb') || lower.endsWith('.gltf'))) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('bad path');
        return;
      }
      try {
        const data = readFileSync(p);
        res.writeHead(200, {
          'Content-Type': 'model/gltf-binary',
          'Content-Length': data.length,
          'Cache-Control': 'no-store',
        });
        res.end(data);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
      }
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });
  server.listen(port, host, () => {
    console.log(`[BlenderViewer] serving .glb viewer at ${baseUrl}`);
  });

  ipcMain.handle(BLENDER_VIEWER_CHANNELS.STATUS, () => ({ running: true, baseUrl }));
  ipcMain.handle(BLENDER_VIEWER_CHANNELS.LIST_MODELS, (_event, dirPath: string) => {
    if (!dirPath) return [];
    return listGlbFiles(dirPath);
  });
  ipcMain.handle(BLENDER_VIEWER_CHANNELS.VIEWER_URL, (_event, fileAbs: string) => ({
    url: `${baseUrl}/?file=${encodeURIComponent(fileAbs)}`,
  }));

  return {
    status: () => Promise.resolve({ running: true, baseUrl }),
    listModels: (dirPath) => Promise.resolve(listGlbFiles(dirPath)),
    viewerUrl: (fileAbs) => Promise.resolve({ url: `${baseUrl}/?file=${encodeURIComponent(fileAbs)}` }),
    destroy(): void {
      ipcMain.removeHandler(BLENDER_VIEWER_CHANNELS.STATUS);
      ipcMain.removeHandler(BLENDER_VIEWER_CHANNELS.LIST_MODELS);
      ipcMain.removeHandler(BLENDER_VIEWER_CHANNELS.VIEWER_URL);
      server.close();
    },
  };
}
