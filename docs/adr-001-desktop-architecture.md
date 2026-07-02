# ADR-001: Coderix Desktop Application Architecture

**Status**: Proposed  
**Date**: 2026-07-01  
**Author**: 小李-2 (Desktop Application Architect)  
**Deciders**: 技术总监, Coderix Core Team

---

## Executive Summary

Coderix is an open-source CLI AI coding assistant (Apache 2.0) built with Node.js + TypeScript + Ink (React TUI). It currently runs exclusively in the terminal and has a companion VSCode extension (`extensions/vscode/`). This ADR proposes a **desktop application architecture** that maximizes code reuse from the existing codebase while delivering a native desktop experience comparable to Cursor, Windsurf, and Claude Code's desktop offering.

The key architectural insight is that Coderix's **core engine is already a well-factored, UI-agnostic backend** — `QueryEngine`, `ToolRegistry`, `SessionManager`, `ProviderAdapter`, `SystemPromptAssembler`, and the entire agents/tools subsystem are pure TypeScript with no terminal dependency. This makes a desktop port straightforward: we reuse the entire `src/` core as a Node.js backend process and build a new rendering frontend on top.

---

## 1. Framework Selection

### 1.1 Comparison Matrix

| Criterion | Electron | Tauri (v2) | Neutralino.js |
|---|---|---|---|
| **Language** | Node.js + Chromium | Rust backend + Web frontend | C++ backend + Web frontend |
| **Bundle Size (macOS)** | ~180-250 MB | ~3-10 MB | ~5 MB |
| **Memory Baseline (idle)** | ~150-300 MB | ~40-80 MB | ~30-50 MB |
| **Cold Start (macOS M2)** | ~2-4s | ~0.3-0.8s | ~0.2-0.5s |
| **Node.js Runtime** | Built-in (bundled) | ❌ Must sidecar | ❌ Must sidecar |
| **TypeScript/React Reuse** | Direct (same runtime) | Via webview + IPC bridge | Via webview + IPC bridge |
| **Native API Surface** | Full (Chromium + Node.js) | Limited (Rust bindings only) | Very limited |
| **Process Sandbox** | Mature (Chromium security model) | Mature (Rust + OS sandbox) | Basic |
| **Auto-Update** | electron-updater (mature) | Tauri updater (newer) | Manual |
| **Code Signing (macOS)** | Mature toolchain | Mature toolchain | Manual |
| **Community & Ecosystem** | Massive | Growing fast | Small |
| **Learning Curve** | Low (JS/TS team) | Medium (Rust required) | Low |
| **Existing Code Reuse** | 100% of `src/` | Core logic only (rewrite in Rust or sidecar) | Core logic only (sidecar) |

### 1.2 Deep-Dive Analysis

#### Electron
- **Code Reuse**: Electron embeds Node.js directly. The entire `src/` directory can be `import`-ed as-is in the main process. `QueryEngine`, `ToolRegistry`, `SessionManager`, and the entire agent loop run natively in the Main process. No IPC serialization overhead for core engine operations.
- **Rendering**: Ink (React TUI) is replaced with standard React DOM in a Chromium renderer process, but React component patterns from `src/tui/components/` can inform the UI redesign.
- **Downside**: Bundle size and memory are the well-known tradeoffs. However, for a developer tool (not a consumer app), 150 MB disk and 200 MB RAM are acceptable — VS Code itself uses similar resources.

#### Tauri (v2)
- **Code Reuse**: Tauri's backend is Rust. Coderix's `src/` cannot run directly — we would need to either:
  a) Rewrite `QueryEngine` and all core logic in Rust (multi-month effort, ongoing maintenance burden)
  b) Run Coderix as a sidecar Node.js process and communicate via IPC (adds latency, complexity)
- **IPC Overhead**: Every agent loop iteration, tool execution, and stream event would cross the IPC boundary between Rust ↔ Node.js sidecar ↔ Webview. This introduces significant engineering complexity for streaming content blocks.
- **Best For**: New projects that can start from scratch in Rust, or projects where a small Rust core suffices.

#### Neutralino.js
- Similar to Tauri but with fewer features and a smaller community. Not suitable for a production-grade developer tool.

### 1.3 Recommendation: **Electron**

**Rationale**:
1. **Maximum Code Reuse**: The entire `src/` core runs directly in the Electron Main process — zero rewrite needed for `QueryEngine`, agents, tools, provider adapters, permission engine, MCP integration, session management, hooks, memory, teams, etc.
2. **Existing VSCode Extension Pattern**: The team already has experience with the Electron/webview pattern via the VSCode extension. The architecture mirrors that: Main process runs the engine, Renderer process is a React webview.
3. **Streaming First-Class**: Content block streaming (`content_block_start` → `content_block_delta` → `content_block_stop`) from the provider adapter flows directly through the Main process to the Renderer via Electron IPC — no serialization impedance mismatch.
4. **Developer Tool Context**: Coderix's target users are developers. 200 MB disk and 200 MB RAM is well within acceptable range for a daily-use development tool. JetBrains IDEs use 1-2 GB.
5. **Auto-Update & Distribution**: electron-builder + electron-updater is the most mature and well-documented pipeline for cross-platform desktop distribution.

### 1.4 Mitigation of Electron Downsides

| Concern | Mitigation |
|---|---|
| Bundle size | Tree-shake `node_modules`, use `electron-builder` ASAR packaging, exclude dev deps |
| Memory | Lazy-load sub-modules (MCP, skills, memory), aggressive context compaction (already in `compactor.ts`) |
| Startup time | Defer non-critical initialization (MCP servers, agent registry), use V8 snapshots |
| Security | Enable `contextIsolation`, `sandbox`, disable `nodeIntegration` in renderer — see §4 |

---

## 2. Process Architecture

### 2.1 Process Model

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        Electron Application                               │
│                                                                           │
│  ┌──────────────────────────────────────────┐                            │
│  │            MAIN PROCESS (Node.js)         │                            │
│  │                                           │                            │
│  │  ┌─────────────┐  ┌────────────────────┐  │                            │
│  │  │ Window       │  │  Coderix Core      │  │                            │
│  │  │ Manager      │  │  (reused from src/) │  │                            │
│  │  └─────────────┘  │                     │  │                            │
│  │                    │  • QueryEngine      │  │                            │
│  │  ┌─────────────┐  │  • ToolRegistry     │  │                            │
│  │  │ Tray & Menu  │  │  • SessionManager   │  │                            │
│  │  │ Manager      │  │  • PermissionEngine │  │                            │
│  │  └─────────────┘  │  • SystemPrompt      │  │                            │
│  │                    │  • ProviderAdapter   │  │                            │
│  │  ┌─────────────┐  │  • AgentRegistry     │  │                            │
│  │  │ Auto-Updater │  │  • SubAgentRegistry  │  │                            │
│  │  └─────────────┘  │  • McpManager        │  │                            │
│  │                    │  • HookManager       │  │                            │
│  │  ┌─────────────┐  │  • Memory system     │  │                            │
│  │  │ File Watcher │  │  • Team system       │  │                            │
│  │  └─────────────┘  │  • Compactor         │  │                            │
│  │                    │  • TokenBudget       │  │                            │
│  │  ┌─────────────┐  │  • Gateway Server    │  │                            │
│  │  │ IPC Bridge   │◄─┤    (JSON-RPC)       │  │                            │
│  │  │ (main↔render)│  └────────────────────┘  │                            │
│  │  └──────┬──────┘                            │                            │
│  └─────────┼───────────────────────────────────┘                            │
│            │ contextBridge + ipcRenderer.invoke()                           │
│  ┌─────────┼───────────────────────────────────┐                            │
│  │         ▼       RENDERER PROCESS             │                            │
│  │  ┌──────────────────────────────────────┐    │                            │
│  │  │         React Application            │    │                            │
│  │  │                                      │    │                            │
│  │  │  ┌────────────┐  ┌────────────────┐  │    │                            │
│  │  │  │ Chat View   │  │ Settings View  │  │    │                            │
│  │  │  │ - Messages   │  │ - Model Config │  │    │                            │
│  │  │  │ - Thinking   │  │ - MCP Servers  │  │    │                            │
│  │  │  │ - Tool Results│  │ - Providers    │  │    │                            │
│  │  │  │ - Streaming  │  │ - Theme        │  │    │                            │
│  │  │  └────────────┘  └────────────────┘  │    │                            │
│  │  │                                      │    │                            │
│  │  │  ┌────────────┐  ┌────────────────┐  │    │                            │
│  │  │  │ Terminal    │  │ File Explorer  │  │    │                            │
│  │  │  │ (xterm.js)  │  │ (Tree View)    │  │    │                            │
│  │  │  └────────────┘  └────────────────┘  │    │                            │
│  │  │                                      │    │                            │
│  │  │  ┌────────────────────────────────┐  │    │                            │
│  │  │  │      State Management          │  │    │                            │
│  │  │  │  (Zustand or Redux + Immer)    │  │    │                            │
│  │  │  └────────────────────────────────┘  │    │                            │
│  │  └──────────────────────────────────────┘    │                            │
│  └──────────────────────────────────────────────┘                            │
│                                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                          │
│  │  Utility     │  │  GPU Process │  │  Extension  │  (optional, for          │
│  │  Process     │  │  (rendering) │  │  Host       │   VSCode compat)         │
│  └─────────────┘  └─────────────┘  └─────────────┘                          │
└──────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Main Process Responsibilities

The Main process runs the Coderix engine and handles all OS-level concerns:

| Module | Source | Responsibility |
|---|---|---|
| **QueryEngine** | `src/core/query-engine.ts` | Agent loop orchestration — reused as-is |
| **ToolRegistry** | `src/core/tool-registry.ts` | Tool registration and execution — reused as-is |
| **SessionManager** | `src/core/session.ts` | Session CRUD, persistence — reused as-is |
| **PermissionEngine** | `src/core/permission.ts` | Permission enforcement — reused as-is |
| **SystemPromptAssembler** | `src/core/system-prompt.ts` | Prompt construction — reused as-is |
| **ProviderAdapter** | `src/core/provider-adapter.ts` | Anthropic/DeepSeek/OpenAI → StreamEvent bridge — reused as-is |
| **Agent Registry** | `src/agents/registry.ts` | Agent definition loading — reused as-is |
| **SubAgentRegistry** | `src/core/subagent-registry.ts` | Sub-agent lifecycle — reused as-is |
| **McpManager** | `src/mcp/manager.ts` | MCP server lifecycle — reused as-is |
| **HookManager** | `src/hooks/manager.ts` | Lifecycle hooks — reused as-is |
| **Compactor** | `src/core/compactor.ts` | Context window compaction — reused as-is |
| **TokenBudget** | `src/core/token-budget.ts` | Token accounting — reused as-is |
| **Memory System** | `src/memory/` | Memory recall and extraction — reused as-is |
| **WindowManager** | **New** (`desktop/main/window-manager.ts`) | Create/manage BrowserWindows, multi-window support |
| **IpcBridge** | **New** (`desktop/main/ipc-bridge.ts`) | Expose engine API to renderer via `contextBridge` |
| **TrayManager** | **New** (`desktop/main/tray-manager.ts`) | System tray icon, context menu |
| **GlobalShortcutManager** | **New** (`desktop/main/shortcuts.ts`) | Register global hotkeys |
| **AutoUpdater** | **New** (`desktop/main/updater.ts`) | electron-updater integration |
| **FileWatcher** | **New** (`desktop/main/file-watcher.ts`) | chokidar-based project file watching |
| **NativeTerminal** | **New** (`desktop/main/native-terminal.ts`) | node-pty for integrated terminal |

### 2.3 Renderer Process Responsibilities

| Module | Source | Responsibility |
|---|---|---|
| **ChatView** | **New** (`desktop/renderer/views/ChatView.tsx`) | Main chat interface with ContentBlock rendering |
| **Terminal** | **New** (`desktop/renderer/components/Terminal.tsx`) | xterm.js-based terminal emulator |
| **FileExplorer** | **New** (`desktop/renderer/components/FileExplorer.tsx`) | Project file tree with git status |
| **DiffView** | **New** (`desktop/renderer/components/DiffView.tsx`) | Side-by-side diff for file changes |
| **SettingsView** | **New** (`desktop/renderer/views/SettingsView.tsx`) | Configuration editor |
| **State Store** | **New** (`desktop/renderer/store/`) | Zustand store mirroring `AppState` |
| **ThemeProvider** | **New** (`desktop/renderer/theme/`) | Dark/light theme (reuse Ink theme design tokens) |

### 2.4 Code Reuse Map

```
src/core/*          → desktop/main/  (direct import in Main process)
src/agents/*        → desktop/main/  (direct import in Main process)
src/tools/*         → desktop/main/  (direct import in Main process)
src/provider/*      → desktop/main/  (direct import in Main process)
src/mcp/*           → desktop/main/  (direct import in Main process)
src/hooks/*         → desktop/main/  (direct import in Main process)
src/memory/*        → desktop/main/  (direct import in Main process)
src/teams/*         → desktop/main/  (direct import in Main process)
src/state/*         → desktop/renderer/store/ (inspiration, rewrite for Zustand)
src/tui/components/* → Not reused — TUI is Ink/terminal, desktop is React DOM
src/cli/*           → Not reused — CLI entry point replaced by Electron main
src/types.ts        → Shared type definitions
```

### 2.5 IPC Communication Design

```
┌──────────────────────┐         ┌──────────────────────┐
│   Renderer Process    │         │     Main Process      │
│                       │         │                       │
│  ipcRenderer.invoke() │────────▶│  ipcMain.handle()     │
│  (channel, payload)   │◀────────│  (response)           │
│                       │         │                       │
│  ipcRenderer.on()     │◀────────│  mainWindow.webContents│
│  (channel, callback)  │         │  .send(channel, data)  │
└──────────────────────┘         └──────────────────────┘
```

#### Channel Definitions

```typescript
// ── Request/Response Channels (invoke/handle) ─────────────────────────

// Session & Query
'query:submit'          → Submit user message, returns AsyncIterable<StreamEvent>
'query:interrupt'       → Abort current query
'session:list'          → List saved sessions
'session:load'          → Load a session
'session:fork'          → Fork current session
'session:delete'        → Delete a session

// Permission
'permission:approve'    → Approve a tool execution request
'permission:deny'       → Deny a tool execution request
'permission:setMode'    → Set permission mode (plan/ask/auto)

// File System
'fs:readFile'           → Read file content
'fs:writeFile'          → Write file content
'fs:listDir'            → List directory contents
'fs:watch'              → Start watching a path (returns file change events)

// Terminal
'terminal:create'       → Create a new PTY session
'terminal:write'        → Write input to PTY
'terminal:resize'       → Resize PTY
'terminal:destroy'      → Destroy PTY session

// Config
'config:get'            → Get settings
'config:set'            → Update settings
'config:getModelList'   → Get available models

// App
'app:getVersion'        → Get app version
'app:checkUpdate'       → Check for updates
'app:quit'              → Quit application

// ── Push Channels (main → renderer, one-way) ─────────────────────────

'stream:blockStart'     → Content block started (text/thinking/tool_use)
'stream:blockDelta'     → Content block delta received
'stream:blockStop'      → Content block completed
'stream:toolState'      → Tool execution state changed
'stream:toolResult'     → Tool execution result ready
'stream:done'           → Turn completed
'stream:error'          → Error occurred

'state:permissionReq'   → Permission required (modal overlay)
'state:questionReq'     → User question from tool
'state:tokenUsage'      → Token usage update
'state:costUpdate'      → Cost update
'state:compact'         → Context compaction occurred

'fs:fileChanged'        → File system change detected
'window:focus'          → Window gained focus
'app:updateAvailable'   → Update available
```

#### Streaming Pattern

Content block streaming requires careful handling across the IPC boundary:

```typescript
// Main Process: QueryEngine yields StreamEvents
// These are forwarded to renderer as push messages

async function* handleQuerySubmit(prompt: string): AsyncGenerator<void> {
  for await (const event of queryEngine.submitMessage(prompt)) {
    switch (event.type) {
      case 'message': {
        const msg = event.data as QueryMessage;
        if (msg.type === 'stream_event') {
          const se = msg.event as StreamEvent;
          switch (se.type) {
            case 'content_block_start':
              mainWindow.webContents.send('stream:blockStart', se);
              break;
            case 'content_block_delta':
              mainWindow.webContents.send('stream:blockDelta', se);
              break;
            case 'content_block_stop':
              mainWindow.webContents.send('stream:blockStop', se);
              break;
            case 'message_stop':
              mainWindow.webContents.send('stream:done', se.message);
              break;
          }
        } else if (msg.type === 'assistant') {
          mainWindow.webContents.send('stream:done', msg.message);
        }
        break;
      }
      case 'permission_required':
        mainWindow.webContents.send('state:permissionReq', event.deferred);
        break;
      case 'question_required':
        mainWindow.webContents.send('state:questionReq', event.deferred);
        break;
      case 'error':
        mainWindow.webContents.send('stream:error', event.data);
        break;
    }
  }
}
```

```typescript
// Renderer Process: Zustand Store
// Subscription-based state updates from push events

const useStreamStore = create<StreamState>((set) => ({
  blocks: [],
  isStreaming: false,
}));

// Registered via preload script
window.electronAPI.onStreamBlockStart((event) => {
  useStreamStore.setState((state) => ({
    blocks: [...state.blocks, event.content_block],
    isStreaming: true,
  }));
});

window.electronAPI.onStreamBlockDelta((event) => {
  useStreamStore.setState((state) => {
    const blocks = [...state.blocks];
    const last = blocks[blocks.length - 1];
    if (last && event.delta.type === 'text_delta') {
      blocks[blocks.length - 1] = { ...last, text: (last.text ?? '') + event.delta.text };
    }
    return { blocks };
  });
});
```

---

## 3. Key Architectural Decisions

### 3.1 Window Management Strategy

**Decision**: Single-window with split panes (primary) + optional detached windows.

```
┌────────────────────────────────────────────────────────────────┐
│  Coderix                                 File  Edit  View  Help │
├────────────────────────────────────────────────────────────────┤
│ ┌──────────┐ ┌──────────────────────────────────────────────┐ │
│ │          │ │  Chat Area                                     │ │
│ │  File    │ │                                                │ │
│ │  Explorer│ │  ┌──────────────────────────────────────────┐ │ │
│ │          │ │  │ User: "Refactor the auth module..."        │ │ │
│ │  src/    │ │  └──────────────────────────────────────────┘ │ │
│ │  ├─ core/│ │  ┌──────────────────────────────────────────┐ │ │
│ │  ├─ agents│ │  │ Assistant: (thinking) Let me analyze...  │ │ │
│ │  ├─ tools│ │  │ [tool_use: grep "auth" in src/]          │ │ │
│ │  └─ ...  │ │  │ [tool_result: 15 matches]                │ │ │
│ │          │ │  └──────────────────────────────────────────┘ │ │
│ │          │ │                                                │ │
│ │          │ │  ┌──────────────────────────────────────────┐ │ │
│ │          │ │  │ > _                                      │ │ │
│ │          │ │  └──────────────────────────────────────────┘ │ │
│ └──────────┘ └──────────────────────────────────────────────┘ │
│ ┌────────────────────────────────────────────────────────────┐ │
│ │ Terminal (xterm.js)                                    ⬆ ⬇ │ │
│ │ $ npm test                                                │ │
│ │ ✓ 125 tests passed                                        │ │
│ └────────────────────────────────────────────────────────────┘ │
├────────────────────────────────────────────────────────────────┤
│ deepseek-v4-pro  │  📊 12.3K tokens  │  💰 $0.042  │  📍 main │
└────────────────────────────────────────────────────────────────┘
```

**Layout features**:
- **Chat Pane** (center, primary): ContentBlock-based chat view with thinking toggle, tool result expansion
- **File Explorer** (left sidebar, collapsible): Project tree with git decorations
- **Terminal Panel** (bottom, resizable): xterm.js embedded terminal (can pop out as separate window)
- **Status Bar** (bottom): Model, token usage, cost, git branch, mode indicator

**Detached Windows**: Users can pop the terminal into a separate window (like VS Code's "Move Panel Right") or open a file in a detached diff view.

### 3.2 Terminal Emulation

**Decision**: **xterm.js** with **node-pty** in the Main process.

Rationale:
- xterm.js is the industry standard (used by VS Code, Hyper, Tabby) — mature, well-maintained, supports all ANSI escape sequences, true color, ligatures, and Unicode
- node-pty runs in the Main process (native module), creates actual PTY sessions that behave identically to the user's native terminal
- The existing bash tool executor already generates ANSI-colored output — xterm.js renders this correctly
- Addons: `xterm-addon-fit` (responsive resize), `xterm-addon-web-links` (clickable URLs), `xterm-addon-search` (find in terminal)

```typescript
// desktop/main/native-terminal.ts

import * as pty from 'node-pty';
import { ipcMain } from 'electron';

interface TerminalSession {
  id: string;
  pty: pty.IPty;
  cwd: string;
}

const sessions = new Map<string, TerminalSession>();

ipcMain.handle('terminal:create', (_, { cwd, rows, cols }) => {
  const id = crypto.randomUUID();
  const ptyProcess = pty.spawn(process.env.SHELL || '/bin/zsh', [], {
    name: 'xterm-256color',
    cols: cols ?? 120,
    rows: rows ?? 30,
    cwd: cwd ?? process.env.HOME,
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  ptyProcess.onData((data) => {
    mainWindow.webContents.send(`terminal:${id}:data`, data);
  });

  ptyProcess.onExit(({ exitCode }) => {
    mainWindow.webContents.send(`terminal:${id}:exit`, exitCode);
    sessions.delete(id);
  });

  sessions.set(id, { id, pty: ptyProcess, cwd });
  return id;
});

ipcMain.on('terminal:write', (_, { sessionId, data }) => {
  sessions.get(sessionId)?.pty.write(data);
});

ipcMain.on('terminal:resize', (_, { sessionId, rows, cols }) => {
  sessions.get(sessionId)?.pty.resize(cols, rows);
});

ipcMain.on('terminal:destroy', (_, { sessionId }) => {
  sessions.get(sessionId)?.pty.kill();
  sessions.delete(sessionId);
});
```

### 3.3 File System Watching

**Decision**: **chokidar** in the Main process, with debounced push events to the Renderer.

```typescript
// desktop/main/file-watcher.ts

import chokidar from 'chokidar';
import { BrowserWindow } from 'electron';

export function startFileWatcher(
  cwd: string,
  mainWindow: BrowserWindow,
): chokidar.FSWatcher {
  const watcher = chokidar.watch(cwd, {
    ignored: [
      '**/node_modules/**',
      '**/.git/**',
      '**/dist/**',
      '**/.coderix/**',
      '**/*.lock',
    ],
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: {
      stabilityThreshold: 100,  // ms — debounce rapid writes
      pollInterval: 10,
    },
  });

  watcher.on('all', (event, path) => {
    mainWindow.webContents.send('fs:fileChanged', {
      event,                    // 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'
      path,
      relativePath: path.replace(`${cwd}/`, ''),
      timestamp: Date.now(),
    });
  });

  return watcher;
}
```

**File Explorer integrations**:
- Git status via `simple-git` (lightweight, no external git binary dependency for basic ops)
- File icons via `vscode-icons` or custom icon set
- LSP diagnostic integration (Phase 2 — connect to TypeScript/ESLint language servers)

### 3.4 System Tray & Global Shortcuts

**Decision**: System tray with context menu + configurable global hotkey for quick toggle.

```typescript
// desktop/main/tray-manager.ts

import { Tray, Menu, nativeImage, globalShortcut } from 'electron';

export function createTray(mainWindow: BrowserWindow): Tray {
  const tray = new Tray(nativeImage.createFromPath(
    path.join(__dirname, '../assets/tray-icon.png')
  ));

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Coderix',
      click: () => {
        mainWindow.show();
        mainWindow.focus();
      },
    },
    {
      label: 'New Session',
      click: () => {
        mainWindow.webContents.send('session:new');
        mainWindow.show();
        mainWindow.focus();
      },
    },
    { type: 'separator' },
    {
      label: 'Permission Mode',
      submenu: [
        { label: 'Auto', type: 'radio', checked: true },
        { label: 'Ask', type: 'radio' },
        { label: 'Plan', type: 'radio' },
      ],
    },
    { type: 'separator' },
    {
      label: 'Check for Updates...',
      click: () => { /* trigger auto-updater */ },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => { app.quit(); },
    },
  ]);

  tray.setToolTip('Coderix');
  tray.setContextMenu(contextMenu);

  // Global hotkey: Ctrl+Shift+Space (configurable in settings)
  globalShortcut.register('CommandOrControl+Shift+Space', () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  return tray;
}
```

### 3.5 Auto-Update Strategy

**Decision**: **electron-updater** (from `electron-builder`) with staged rollouts.

```
┌──────────────┐     ┌──────────────────┐     ┌──────────────────┐
│   App Start   │────▶│  Check for Update │────▶│  Update          │
│               │     │  (GitHub Releases) │     │  Available?       │
└──────────────┘     └──────────────────┘     └───────┬──────────┘
                                                       │
                                    ┌──────────────────┼──────────────────┐
                                    ▼                  ▼                  ▼
                              ┌──────────┐     ┌──────────────┐    ┌──────────┐
                              │ Download  │     │ Notify User   │    │ No Update│
                              │ in        │     │ "Update in 2h"│    │ (quiet)  │
                              │ Background│     │ or "Install   │    └──────────┘
                              └────┬─────┘     │ on Quit"      │
                                   │           └──────────────┘
                                   ▼
                              ┌──────────┐
                              │ On Quit:  │
                              │ Install & │
                              │ Relaunch  │
                              └──────────┘
```

```typescript
// desktop/main/updater.ts

import { autoUpdater } from 'electron-updater';
import { BrowserWindow, dialog } from 'electron';

export function setupAutoUpdater(mainWindow: BrowserWindow): void {
  autoUpdater.autoDownload = false; // Let user decide
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', ({ version, releaseDate }) => {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update Available',
      message: `Coderix ${version} is available (released ${releaseDate}).`,
      buttons: ['Download Now', 'Remind Me Later'],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) {
        autoUpdater.downloadUpdate();
      }
    });
  });

  autoUpdater.on('download-progress', ({ percent }) => {
    mainWindow.webContents.send('app:updateProgress', percent);
    mainWindow.setProgressBar(percent / 100);
  });

  autoUpdater.on('update-downloaded', () => {
    mainWindow.setProgressBar(-1); // Reset
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update Ready',
      message: 'Update downloaded. Install on next restart?',
      buttons: ['Restart Now', 'Install on Quit'],
    }).then(({ response }) => {
      if (response === 0) {
        autoUpdater.quitAndInstall();
      }
    });
  });

  // Check every 4 hours
  setInterval(() => autoUpdater.checkForUpdates(), 4 * 60 * 60 * 1000);

  // Initial check after 30s (let app settle)
  setTimeout(() => autoUpdater.checkForUpdates(), 30_000);
}
```

---

## 4. Security Model

### 4.1 Process Sandboxing

```
┌──────────────────────────────────────────────────────────────┐
│                     ELECTRON APP                              │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  Main Process (nodeIntegration: false by design)      │    │
│  │                                                       │    │
│  │  ✅ Full Node.js access (engine, tools, file system)   │    │
│  │  ✅ OS-level APIs (terminal, tray, shortcuts)         │    │
│  │  ✅ Keychain access (API keys)                        │    │
│  │  ❌ No remote content execution                       │    │
│  │  ❌ No direct DOM access                              │    │
│  └──────────────────────────────────────────────────────┘    │
│                          │                                    │
│               contextBridge (whitelist only)                  │
│                          │                                    │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  Renderer Process (sandbox: true)                     │    │
│  │                                                       │    │
│  │  ❌ No Node.js access (nodeIntegration: false)        │    │
│  │  ❌ No require()                                      │    │
│  │  ❌ No process global                                 │    │
│  │  ✅ contextIsolation: true                            │    │
│  │  ✅ CSP: default-src 'self'                           │    │
│  │  ✅ Only preload-exposed API surface                  │    │
│  └──────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

**Preload Script** (the only bridge between renderer and Node.js):

```typescript
// desktop/main/preload.ts

import { contextBridge, ipcRenderer } from 'electron';

// ── Whitelisted API surface exposed to renderer ────────────────────

contextBridge.exposeInMainWorld('electronAPI', {
  // Query
  submitQuery: (prompt: string) => ipcRenderer.invoke('query:submit', prompt),
  interruptQuery: () => ipcRenderer.invoke('query:interrupt'),
  
  // Session
  listSessions: () => ipcRenderer.invoke('session:list'),
  loadSession: (id: string) => ipcRenderer.invoke('session:load', id),
  forkSession: (opts: any) => ipcRenderer.invoke('session:fork', opts),
  
  // Permission
  approvePermission: (toolUseId: string) =>
    ipcRenderer.invoke('permission:approve', toolUseId),
  denyPermission: (toolUseId: string) =>
    ipcRenderer.invoke('permission:deny', toolUseId),
  setPermissionMode: (mode: string) =>
    ipcRenderer.invoke('permission:setMode', mode),
  
  // File System (read-only from renderer)
  readFile: (path: string) => ipcRenderer.invoke('fs:readFile', path),
  listDir: (path: string) => ipcRenderer.invoke('fs:listDir', path),
  
  // Terminal
  createTerminal: (opts: any) => ipcRenderer.invoke('terminal:create', opts),
  writeTerminal: (id: string, data: string) =>
    ipcRenderer.send('terminal:write', { sessionId: id, data }),
  resizeTerminal: (id: string, rows: number, cols: number) =>
    ipcRenderer.send('terminal:resize', { sessionId: id, rows, cols }),
  destroyTerminal: (id: string) =>
    ipcRenderer.send('terminal:destroy', { sessionId: id }),
  
  // Push event listeners (one-way: main → renderer)
  onStreamBlockStart: (cb: Function) =>
    ipcRenderer.on('stream:blockStart', (_, data) => cb(data)),
  onStreamBlockDelta: (cb: Function) =>
    ipcRenderer.on('stream:blockDelta', (_, data) => cb(data)),
  onStreamBlockStop: (cb: Function) =>
    ipcRenderer.on('stream:blockStop', (_, data) => cb(data)),
  onStreamDone: (cb: Function) =>
    ipcRenderer.on('stream:done', (_, data) => cb(data)),
  onPermissionRequired: (cb: Function) =>
    ipcRenderer.on('state:permissionReq', (_, data) => cb(data)),
  onFileChanged: (cb: Function) =>
    ipcRenderer.on('fs:fileChanged', (_, data) => cb(data)),
  
  // App
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  checkUpdate: () => ipcRenderer.invoke('app:checkUpdate'),
  onUpdateAvailable: (cb: Function) =>
    ipcRenderer.on('app:updateAvailable', (_, data) => cb(data)),
  onUpdateProgress: (cb: Function) =>
    ipcRenderer.on('app:updateProgress', (_, data) => cb(data)),
  
  // Remove listeners
  removeAllListeners: (channel: string) =>
    ipcRenderer.removeAllListeners(channel),
});
```

### 4.2 File System Access Permissions

The existing `PermissionEngine` (`src/core/permission.ts`) already enforces a three-tier model:

| Level | Desktop Behavior |
|---|---|
| **SAFE** (read-only) | Auto-approved in all modes. No user prompt. |
| **MUTATION** (file writes, git) | Auto-approved in "Auto" mode. Prompt in "Ask" mode. Blocked in "Plan" mode. |
| **DESTRUCTIVE** (rm -rf, git push --force) | Always prompt regardless of mode. Require explicit confirmation. |

**Desktop additions**:
- **Directory Whitelist**: Only allow file operations within the project directory and its subdirectories by default. Operations outside require user confirmation.
- **Shell Sandbox**: `bash` tool executions run within a configurable working directory. Commands are classified by the existing `command-classifier.ts` and `dangerous-patterns.ts` before execution.
- **Docker Sandbox (Phase 2)**: Optionally run tool executions inside a Docker container for complete isolation (existing `sandbox` concept in core types).

### 4.3 API Key Management

**Decision**: **OS-native keychain** (macOS Keychain, Windows Credential Manager, Linux libsecret) via `keytar` or `electron-store` with encryption.

```typescript
// desktop/main/secrets.ts

import { safeStorage } from 'electron';
import Store from 'electron-store';

interface SecureConfig {
  apiKeys: Record<string, string>; // provider → encrypted key
}

// Level 1: OS keychain (primary — most secure)
// Level 2: Encrypted electron-store (fallback when keychain unavailable)

const store = new Store<SecureConfig>({
  name: 'secure-config',
  encryptionKey: 'coderix-secure-v1', // Derived from machine ID at runtime
});

export async function storeApiKey(provider: string, key: string): Promise<void> {
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(key);
    store.set(`apiKeys.${provider}`, encrypted.toString('base64'));
  } else {
    // Fallback: store encrypted with app-specific key
    store.set(`apiKeys.${provider}`, key);
  }
}

export async function getApiKey(provider: string): Promise<string | null> {
  const stored = store.get(`apiKeys.${provider}`);
  if (!stored) return null;
  
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(stored, 'base64'));
    } catch {
      return null;
    }
  }
  return stored;
}
```

**Key principles**:
1. API keys are NEVER sent to the renderer process
2. Keys are loaded in the Main process and injected directly into the provider adapter
3. Environment variables (`ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, etc.) are read by the Main process and take precedence over stored keys
4. Keys are NEVER logged or included in error messages
5. On session export/import, API keys are stripped

---

## 5. Packaging & Distribution

### 5.1 macOS

```
Coderix.app/
├── Contents/
│   ├── MacOS/
│   │   └── Coderix              # Main executable
│   ├── Resources/
│   │   ├── app.asar             # Bundled app code
│   │   ├── assets/              # Icons, images
│   │   └── *.lproj/             # Localization
│   ├── Frameworks/
│   │   ├── Electron Framework.framework/
│   │   ├── Coderix Helper (GPU).app/
│   │   ├── Coderix Helper (Plugin).app/
│   │   └── Coderix Helper (Renderer).app/
│   └── Info.plist
```

**Signing & Notarization**:

```yaml
# electron-builder configuration (partial)
mac:
  category: public.app-category.developer-tools
  icon: assets/icon.icns
  hardenedRuntime: true
  gatekeeperAssess: false
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist
  notarize:
    teamId: ${APPLE_TEAM_ID}
  target:
    - target: dmg
      arch: [x64, arm64]
    - target: zip
      arch: [x64, arm64]

# entitlements.mac.plist
# Required:
# - com.apple.security.cs.allow-unsigned-executable-memory (node-pty)
# - com.apple.security.cs.disable-library-validation (native modules)
# - com.apple.security.device.audio-input (optional, for voice input)
# - com.apple.security.network.client (API calls)
# - com.apple.security.files.user-selected.read-write (file access)
```

**Auto-update channels for macOS**:
- `latest-mac.yml` — Stable channel
- `beta-mac.yml` — Beta channel (opt-in via settings)
- `alpha-mac.yml` — Nightly builds

### 5.2 Windows

```yaml
win:
  icon: assets/icon.ico
  target:
    - target: nsis
      arch: [x64]
    - target: portable
      arch: [x64]
  certificateFile: ${WIN_CERT_FILE}
  certificatePassword: ${WIN_CERT_PASSWORD}

nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: true
  createStartMenuShortcut: true
  shortcutName: Coderix
```

**Windows-specific considerations**:
- Install node-pty Windows bindings (prebuilt binaries)
- Use Windows Credential Manager for API key storage
- Register file associations (`.coderix-session` for session files)

### 5.3 Linux

```yaml
linux:
  icon: assets/icon.png
  category: Development
  target:
    - target: AppImage
      arch: [x64]
    - target: deb
      arch: [x64]
    - target: rpm
      arch: [x64]
```

**Linux-specific considerations**:
- AppImage for universal compatibility
- `.deb` for Debian/Ubuntu
- `.rpm` for Fedora/RHEL
- Use `libsecret` for API key storage (via `keytar`)

### 5.4 CI/CD Pipeline

```
┌──────────┐    ┌──────────────┐    ┌──────────────────┐    ┌─────────────┐
│  GitHub   │    │  GitHub       │    │  Platform-specific│    │  GitHub      │
│  Push/PR  │───▶│  Actions CI   │───▶│  Build & Sign     │───▶│  Release     │
│  (main)   │    │               │    │                    │    │  (Draft)     │
└──────────┘    └──────────────┘    └──────────────────┘    └─────────────┘
                       │                                               │
                       ▼                                               ▼
                ┌──────────────┐                              ┌──────────────┐
                │  Unit Tests   │                              │  electron-    │
                │  (vitest)     │                              │  updater      │
                │  Lint + Build │                              │  fetches      │
                └──────────────┘                              └──────────────┘
```

```yaml
# .github/workflows/desktop-release.yml (conceptual)

name: Desktop Release

on:
  push:
    tags: ['v*.*.*']
  workflow_dispatch:
    inputs:
      channel:
        type: choice
        options: [stable, beta]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: pnpm install --frozen-lockfile
      - run: pnpm test
      - run: pnpm typecheck

  build-macos:
    needs: test
    runs-on: macos-latest
    strategy:
      matrix:
        arch: [x64, arm64]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter coderix-desktop build
      - run: npx electron-builder --mac --${{ matrix.arch }}
        env:
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
      - uses: actions/upload-artifact@v4
        with:
          name: macos-${{ matrix.arch }}
          path: release/*.dmg

  build-windows:
    needs: test
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter coderix-desktop build
      - run: npx electron-builder --win
        env:
          WIN_CERT_FILE: ${{ secrets.WIN_CERT_FILE }}
          WIN_CERT_PASSWORD: ${{ secrets.WIN_CERT_PASSWORD }}
      - uses: actions/upload-artifact@v4
        with:
          name: windows-x64
          path: release/*.exe

  build-linux:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter coderix-desktop build
      - run: npx electron-builder --linux
      - uses: actions/upload-artifact@v4
        with:
          name: linux-x64
          path: release/*.{AppImage,deb,rpm}

  release:
    needs: [build-macos, build-windows, build-linux]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
      - name: Create GitHub Release
        uses: softprops/action-gh-release@v1
        with:
          draft: true
          files: |
            macos-x64/*.dmg
            macos-arm64/*.dmg
            windows-x64/*.exe
            linux-x64/*.AppImage
            linux-x64/*.deb
            linux-x64/*.rpm
```

---

## 6. Project Structure

```
coderix/
├── packages/
│   ├── coderix-core/       # Extracted core engine
│   ├── coderix-cli/        # CLI application
│   ├── coderix-desktop/    # Desktop application (Electron)
│   │   ├── main/                     # Electron Main process
│   │   │   ├── index.ts              # App entry point
│   │   │   ├── window-manager.ts     # BrowserWindow lifecycle
│   │   │   ├── ipc-bridge.ts         # IPC channel handlers
│   │   │   ├── tray-manager.ts       # System tray
│   │   │   ├── shortcuts.ts          # Global shortcuts
│   │   │   ├── updater.ts            # Auto-update
│   │   │   ├── file-watcher.ts       # chokidar integration
│   │   │   ├── native-terminal.ts    # node-pty manager
│   │   │   ├── secrets.ts            # API key storage
│   │   │   ├── preload.ts            # contextBridge preload
│   │   │   └── menu.ts               # Application menu
│   │   │
│   │   ├── renderer/                 # React renderer
│   │   │   ├── index.html            # HTML shell
│   │   │   ├── index.tsx             # React entry
│   │   │   ├── App.tsx               # Root component
│   │   │   ├── store/                # Zustand stores
│   │   │   │   ├── chatStore.ts
│   │   │   │   ├── streamStore.ts
│   │   │   │   ├── sessionStore.ts
│   │   │   │   ├── fileStore.ts
│   │   │   │   └── settingsStore.ts
│   │   │   ├── views/
│   │   │   │   ├── ChatView.tsx      # Main chat interface
│   │   │   │   ├── SettingsView.tsx  # Settings page
│   │   │   │   └── WelcomeView.tsx   # Onboarding
│   │   │   ├── components/
│   │   │   │   ├── chat/
│   │   │   │   │   ├── MessageList.tsx
│   │   │   │   │   ├── TextBlock.tsx
│   │   │   │   │   ├── ThinkingBlock.tsx
│   │   │   │   │   ├── ToolUseBlock.tsx
│   │   │   │   │   ├── ToolResultBlock.tsx
│   │   │   │   │   └── InputBox.tsx
│   │   │   │   ├── Terminal.tsx      # xterm.js wrapper
│   │   │   │   ├── FileExplorer.tsx
│   │   │   │   ├── DiffView.tsx
│   │   │   │   ├── StatusBar.tsx
│   │   │   │   ├── PermissionModal.tsx
│   │   │   │   └── QuestionModal.tsx
│   │   │   ├── hooks/
│   │   │   │   ├── useIpcEvent.ts
│   │   │   │   ├── useStream.ts
│   │   │   │   └── useTheme.ts
│   │   │   ├── theme/
│   │   │   │   ├── tokens.ts
│   │   │   │   ├── dark.css
│   │   │   │   └── light.css
│   │   │   └── types/
│   │   │       └── electron.d.ts     # Window.electronAPI type declarations
│   │   │
│   │   └── shared/                   # Shared between main & renderer
│   │       ├── ipc-channels.ts       # Channel name constants
│   │       └── types.ts              # IPC payload types
│   │
│   └── coderix-vscode/     # VSCode extension
│
├── pnpm-workspace.yaml
├── turbo.json
└── package.json            # Root workspace config
```

---

## 7. Migration Path & Rollout Strategy

### Phase 1: P0 MVP (12 weeks)
- Monorepo scaffold (pnpm + Turborepo)
- Core extraction (coderix-core package)
- Basic Electron shell with React renderer
- Chat interface with Markdown rendering
- File tree with basic operations
- Terminal integration (xterm.js)
- Session management (create, switch, delete)
- Permission approval UI
- Settings panel (model, theme, shortcuts)
- Auto-update (electron-updater)
- CI/CD pipeline (lint, typecheck, test, build)
- macOS code signing + notarization

### Phase 2: P1 Core (16 weeks)
- Multi-session with tabbed interface
- Advanced session management (fork, merge, export)
- Diff viewer with side-by-side and inline modes
- File editor with syntax highlighting (Monaco)
- VSCode extension migration
- MCP server integration UI
- PR workflow (GitHub/GitLab integration)
- Keyboard shortcuts system
- Internationalization (i18n) framework
- Performance optimization (virtual scrolling, lazy loading)
- Cross-platform packaging (Windows, Linux)
- E2E test suite (Playwright + Electron)

### Phase 3: P2 Enhanced (12 weeks)
- Plugin/Extension API
- Team collaboration features
- Browser preview panel
- Advanced diff (3-way merge, image diff)
- Custom theme engine
- Accessibility audit and improvements
- Performance benchmarking and optimization

---

## 8. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Electron bundle size too large | Medium | Medium | Tree-shaking, ASAR compression, lazy module loading |
| node-pty native module issues on Windows/Linux | Medium | High | Prebuilt binaries in CI, fallback to child_process.spawn |
| Streaming IPC performance bottleneck | Low | High | Batched events, binary IPC for large payloads, web worker offloading |
| Code signing/notarization complexity | High | Medium | Dedicated CI jobs per platform, automated notarization |
| Mac App Store rejection (private APIs) | Medium | Low | Distribute via website + Homebrew cask primarily, App Store as secondary |
| Renderer process crash on large content | Medium | Medium | Virtualized message lists, paginated tool results, content truncation (already in `tool-result-limiter.ts`) |

---

## 9. Alternatives Considered

### 9.1 PWA (Progressive Web App)
- **Rejected**: No native terminal (PTY), no file system access, no global shortcuts, no system tray. PWAs cannot deliver the developer tool experience required.

### 9.2 Native macOS (SwiftUI) + Embedded WebView
- **Rejected**: Would require full rewrite of all core logic in Swift. No code reuse from `src/`. Multi-platform (Windows/Linux) would require separate implementations.

### 9.3 Flutter Desktop
- **Rejected**: Dart runtime cannot run existing TypeScript code. Would require complete rewrite or sidecar Node.js process with JSON-RPC bridge — same complexity as Tauri but with worse native terminal support.

### 9.4 Stick to CLI + VSCode Extension only
- **Rejected**: The desktop app provides differentiation and reach beyond the developer audience that uses terminal-based tools. Many developers prefer a dedicated GUI for AI-assisted coding.

---

## 10. Open Questions

**Resolved**: Monorepo with pnpm workspaces — see ENGINEERING_PLAN.md Section 2.

1. **LSP strategy**: Should we bundle language servers or rely on system-installed ones? Recommendation: detect system-installed servers first, offer to download via settings.

2. **Extension API**: Should the desktop app support extensions beyond MCP? Recommendation: MCP-first for Phase 1-3, custom extension API in Phase 4.

3. **Remote development**: Support for SSH remote development (like VS Code Remote)? Recommendation: Phase 5+ — requires `node-pty` over SSH, significant engineering effort.

---

## Appendix A: Dependency Map

```
desktop/main/
  depends on:
    electron (runtime)
    src/core/* (query-engine, tool-registry, session, permission, compactor, etc.)
    src/agents/* (agent registry, agent spawn)
    src/tools/* (all tool executors)
    src/provider/* (API adapters)
    src/mcp/* (MCP manager)
    src/hooks/* (lifecycle hooks)
    src/memory/* (memory system)
    src/teams/* (multi-agent teams)
    node-pty (native terminal)
    chokidar (file watching)
    electron-updater (auto-update)
    electron-store (secure config)
    keytar (OS keychain)

desktop/renderer/
  depends on:
    react, react-dom (UI framework)
    xterm, xterm-addon-fit, xterm-addon-web-links (terminal)
    zustand (state management)
    @tanstack/react-virtual (virtual scrolling for chat/file lists)
    @vscode/codicons (icon set)
    framer-motion (spring animations for UI)
    lucide-react (icon library)
    react-dnd (drag and drop for file tree)
    shiki (syntax highlighting — replaces highlight.js)
    monaco-editor (Phase 2 — diff viewer, inline editing)
```

---

## Appendix B: Performance Budget

| Metric | Target | Measurement |
|---|---|---|
| Cold start (app launch to interactive) | < 3s (M2 Mac) | `app.on('ready')` → `mainWindow.show()` |
| Hot start (from tray) | < 500ms | `mainWindow.show()` → paint |
| Streaming latency (first token) | < 2s (p95) | Time from `query:submit` to first `stream:blockStart` |
| IPC round-trip | < 5ms (p99) | `ipcRenderer.invoke()` timing |
| Memory idle (no session) | < 200 MB | `process.memoryUsage().rss` |
| Memory active (large session) | < 500 MB | `process.memoryUsage().rss` |
| Disk (installed) | < 300 MB | `du -sh Coderix.app` |
| CPU idle | < 1% | Activity Monitor |
| GPU (during streaming) | < 10% | Activity Monitor |

---

*This ADR is a living document. Updates will be made as implementation proceeds and new constraints are discovered.*
