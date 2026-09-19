/**
 * Coderix Desktop — Electron Main Process Entry Point
 */

import { app, BrowserWindow, Notification } from 'electron';
import { existsSync } from 'node:fs';
import { createWindowManager } from './window-manager.js';
import type { WindowManager } from './window-manager.js';
import { createIpcBridge, getLastWorkspace, getDefaultWorkspaceDir, isDefaultWorkspaceContext, IPC_CHANNELS } from './ipc-bridge.js';
import type { IpcBridge } from './ipc-bridge.js';
import { createFileWatcherManager } from './file-watcher.js';
import type { FileWatcherManager } from './file-watcher.js';
import { createTerminalManager } from './native-terminal.js';
import type { TerminalManager } from './native-terminal.js';
import { createTrayManager } from './tray-manager.js';
import type { TrayManager } from './tray-manager.js';
import { createBrowserViewManager } from './browser-view-manager.js';
import type { BrowserViewManager } from './browser-view-manager.js';
import { safeSend } from './safe-send.js';
import { extractOpenUrl } from './open-url.js';
import { startProtocolGateway } from './protocol-gateway/server.js';
import { installCli, bootstrapConfig } from './cli-installer.js';
import { autoInstallClaudeCodeOnBoot } from './claude-code-runtime.js';

// Direct imports from core package source — avoid @coderix/core bundle (pulls in node:sqlite)
import { QueryEngine } from '../../../../packages/coderix-core/src/core/query-engine.js';
import type { QueryEngineConfig } from '../../../../packages/coderix-core/src/core/query-engine.js';
import type { Session } from '../../../../packages/coderix-core/src/core/types.js';
import { SessionManager } from '../../../../packages/coderix-core/src/core/session.js';
import { ToolRegistry } from '../../../../packages/coderix-core/src/core/tool-registry.js';
import { createCallModel } from '../../../../packages/coderix-core/src/core/provider-adapter.js';
import { PermissionMode, loadSettings, resolvePermissionMode } from '../../../../packages/coderix-core/src/index.js';
import { loadDesktopConfig, resolveModelByName } from '../../../../packages/coderix-core/src/config.js';

// Tool schema + executor imports (avoid index.ts → renderers → React/ink)
import { schema as bashSchema } from '../../../../packages/coderix-core/src/tools/bash/schema.js';
import { execute as bashExec } from '../../../../packages/coderix-core/src/tools/bash/executor.js';
import { schema as readSchema } from '../../../../packages/coderix-core/src/tools/read/schema.js';
import { execute as readExec } from '../../../../packages/coderix-core/src/tools/read/executor.js';
import { schema as writeSchema } from '../../../../packages/coderix-core/src/tools/write/schema.js';
import { execute as writeExec } from '../../../../packages/coderix-core/src/tools/write/executor.js';
import { schema as updateSchema } from '../../../../packages/coderix-core/src/tools/update/schema.js';
import { execute as updateExec } from '../../../../packages/coderix-core/src/tools/update/executor.js';
import { schema as globSchema } from '../../../../packages/coderix-core/src/tools/glob/schema.js';
import { execute as globExec } from '../../../../packages/coderix-core/src/tools/glob/executor.js';
import { schema as grepSchema } from '../../../../packages/coderix-core/src/tools/grep/schema.js';
import { execute as grepExec } from '../../../../packages/coderix-core/src/tools/grep/executor.js';
import { schema as webFetchSchema } from '../../../../packages/coderix-core/src/tools/web-fetch/schema.js';
import { execute as webFetchExec } from '../../../../packages/coderix-core/src/tools/web-fetch/executor.js';
import { schema as webSearchSchema } from '../../../../packages/coderix-core/src/tools/web-search/schema.js';
import { execute as webSearchExec } from '../../../../packages/coderix-core/src/tools/web-search/executor.js';
import { schema as notebookEditSchema } from '../../../../packages/coderix-core/src/tools/notebook-edit/schema.js';
import { execute as notebookEditExec } from '../../../../packages/coderix-core/src/tools/notebook-edit/executor.js';
import { schema as listenSchema } from '../../../../packages/coderix-core/src/tools/listen/schema.js';
import { execute as listenExec } from '../../../../packages/coderix-core/src/tools/listen/executor.js';
import { schema as askUserSchema } from '../../../../packages/coderix-core/src/tools/ask-user-question/schema.js';
import { execute as askUserExec } from '../../../../packages/coderix-core/src/tools/ask-user-question/executor.js';
import { schema as enterPlanSchema } from '../../../../packages/coderix-core/src/tools/enter-plan-mode/schema.js';
import { execute as enterPlanExec } from '../../../../packages/coderix-core/src/tools/enter-plan-mode/executor.js';
import { schema as exitPlanSchema } from '../../../../packages/coderix-core/src/tools/exit-plan-mode/schema.js';
import { execute as exitPlanExec } from '../../../../packages/coderix-core/src/tools/exit-plan-mode/executor.js';
import { schema as taskOutputSchema } from '../../../../packages/coderix-core/src/tools/task-output/schema.js';
import { execute as taskOutputExec } from '../../../../packages/coderix-core/src/tools/task-output/executor.js';
import { schema as taskStopSchema } from '../../../../packages/coderix-core/src/tools/task-stop/schema.js';
import { execute as taskStopExec } from '../../../../packages/coderix-core/src/tools/task-stop/executor.js';
import { schema as enterWorktreeSchema } from '../../../../packages/coderix-core/src/tools/enter-worktree/schema.js';
import { execute as enterWorktreeExec } from '../../../../packages/coderix-core/src/tools/enter-worktree/executor.js';
import { schema as exitWorktreeSchema } from '../../../../packages/coderix-core/src/tools/exit-worktree/schema.js';
import { execute as exitWorktreeExec } from '../../../../packages/coderix-core/src/tools/exit-worktree/executor.js';

// ---------------------------------------------------------------------------
// Prevent multiple instances (single-instance lock)
// ---------------------------------------------------------------------------

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

let windowManager: WindowManager | null = null;
let ipcBridge: IpcBridge | null = null;
let fileWatcher: FileWatcherManager | null = null;
let terminalManager: TerminalManager | null = null;
let trayManager: TrayManager | null = null;
let browserViewManager: BrowserViewManager | null = null;
let sessionManagerRef: SessionManager | null = null;
let activeWorkDir = process.cwd();
let activeModel = 'deepseek-v4-pro';
let protocolGateway: ReturnType<typeof startProtocolGateway> | null = null;

// ---------------------------------------------------------------------------
// Bootstrap sequence — create window FIRST before any heavy init
// ---------------------------------------------------------------------------

async function bootstrap(): Promise<void> {
  try {
    // First-launch config bootstrap — ensure ~/.coderix/{settings.json,skills,…}
    // exists before loadConfig() reads it. On a fresh install the core can't
    // reach its bundled resources through the asar, so loadConfig() would throw
    // "No model configured" and the app would quit before any window opens.
    // Idempotent: existing settings.json / user-customized skills are preserved.
    bootstrapConfig();

    const initialConfig = loadDesktopConfig();
    // Restore the last-used workspace across restarts. `loadConfig().cwd` is
    // `process.cwd()` (the app's launch dir, e.g. `packages/coderix-desktop`),
    // which is never the project the user wants to reopen — fall back to it
    // only when there's no persisted workspace yet (first launch).
    activeWorkDir = getLastWorkspace() ?? getDefaultWorkspaceDir();
    activeModel = initialConfig.modelId;

    // Start the loopback protocol-conversion gateway so the claude-code engine
    // can drive OpenAI-compatible models (anthropic → openai on the wire). The
    // resolved base_url travels in the gateway path, so the gateway forwards to
    // the exact endpoint the engine already chose rather than re-resolving a
    // model name against ~/.coderix/settings.json (names collide across
    // providers).
    protocolGateway = startProtocolGateway();

    // Step 1: Create window manager
    windowManager = createWindowManager();

    // Step 1b: Create browser view manager (WebContentsView tabs) so its IPC
    // handlers are registered before the renderer loads.
    browserViewManager = createBrowserViewManager(windowManager);

    // Step 2: Create SessionManager early so session IPC handlers work
    // before QueryEngine is initialized (renderer calls session:create on load)
    const sessionManager = new SessionManager();
    sessionManagerRef = sessionManager;

    // Restore the workspace from the most recently used session so a restart
    // reopens the project that session was working in (each session remembers
    // its own workspace), instead of the app's launch directory. Only a
    // default-workspace dir (base or hash subdir) is trusted here — a session
    // that recorded the launch dir (dev) or a stale legacy base must not pin
    // the app there.
    try {
      const latest = sessionManager.list({ limit: 1 })[0];
      if (latest?.workDir && existsSync(latest.workDir) && isDefaultWorkspaceContext(latest.workDir)) {
        activeWorkDir = latest.workDir;
      }
    } catch {
      // No sessions yet — keep the global last-workspace / launch-dir fallback.
    }

    // Step 3: Create IPC bridge BEFORE window (renderer calls IPC on load)
    fileWatcher = createFileWatcherManager();
    terminalManager = createTerminalManager();
    ipcBridge = createIpcBridge({
      windowManager,
      fileWatcher,
      terminalManager,
      sessionManager,
      workDir: activeWorkDir,
      model: activeModel,
      reloadQueryEngine: (workDir, model) => initQueryEngine(workDir, model),
      createEngineForSession,
    });

    // Step 3: Create the window — this must happen before heavy init
    const mainWindow = windowManager.createMainWindow();
    if (!mainWindow) {
      throw new Error('Failed to create main window');
    }
    fileWatcher.setMainWindow(mainWindow);

    // Step 4: Set up system tray
    trayManager = createTrayManager();
    trayManager.create(() => windowManager?.getMainWindow() ?? null);

    // Step 5: Handle second-instance
    app.on('second-instance', () => {
      const win = windowManager?.getMainWindow();
      if (win) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
    });

    // Step 6: Handle open-file (macOS)
    app.on('open-file', (_event, filePath) => {
      safeSend(windowManager?.getMainWindow(), 'app:openFile', filePath);
    });

    console.log('[Coderix] Bootstrap complete');

    // Step 6b: First-launch CLI install — symlink the bundled `coderix` binary
    // onto the user's PATH so the terminal has a `coderix` command. Idempotent
    // and non-blocking; failures are logged, never fatal.
    autoInstallCli();

    // Step 6c: First-launch claude-code runtime install — pull the ~200MB native
    // CLI into ~/.coderix/runtimes/claude-code (not bundled with the app) when
    // the default engine is claude-code. Fire-and-forget so it never blocks
    // startup; the engine itself also installs on demand as a fallback.
    if (initialConfig.engine === 'claude-code') {
      autoInstallClaudeCodeOnBoot();
    }

    // Step 7: Defer QueryEngine init to avoid blocking renderer startup
    setTimeout(() => {
      initQueryEngine(activeWorkDir).catch((err) => {
        console.error('[Coderix] Failed to initialize query engine:', err);
      });
    }, 1000);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Coderix] Bootstrap failed:', message);
    app.quit();
  }
}

// ---------------------------------------------------------------------------
// First-launch CLI install
// ---------------------------------------------------------------------------

/**
 * Symlink the bundled `coderix` binary onto the PATH. Idempotent — a no-op when
 * already installed. Announces a real install (or a failure) via a macOS
 * notification so the user knows the terminal command became available.
 */
function autoInstallCli(): void {
  try {
    const result = installCli();
    if (result.ok) {
      if (result.message.startsWith('Already installed')) {
        console.log(`[Coderix] CLI already installed: ${result.targetPath}`);
      } else {
        console.log(`[Coderix] CLI installed: ${result.message}`);
        if (Notification.isSupported()) {
          new Notification({ title: 'Coderix CLI', body: result.message }).show();
        }
      }
    } else {
      console.warn(`[Coderix] CLI install skipped: ${result.message}`);
      if (Notification.isSupported()) {
        new Notification({ title: 'Coderix CLI', body: result.message }).show();
      }
    }
  } catch (err) {
    console.error('[Coderix] CLI install error:', err);
  }
}

// ---------------------------------------------------------------------------
// QueryEngine initialization
// ---------------------------------------------------------------------------

// Shared, read-only tool registry reused across every per-session engine. The
// in-process coderix engine needs one engine instance per concurrently-running
// session, but the tool set (bash/read/write/…) is identical, so it is built
// once and shared. The executor wrapper reads `ctx.cwd` (each engine passes its
// session's workspace) so tools run in the right directory per session.
let sharedToolRegistry: ToolRegistry | null = null;

function buildSharedToolRegistry(): ToolRegistry {
  if (sharedToolRegistry) return sharedToolRegistry;

  const toolRegistry = new ToolRegistry();
  const toolList: Array<{ schema: any; executor: any }> = [
    { schema: bashSchema, executor: bashExec },
    { schema: readSchema, executor: readExec },
    { schema: writeSchema, executor: writeExec },
    { schema: updateSchema, executor: updateExec },
    { schema: globSchema, executor: globExec },
    { schema: grepSchema, executor: grepExec },
    { schema: webFetchSchema, executor: webFetchExec },
    { schema: webSearchSchema, executor: webSearchExec },
    { schema: notebookEditSchema, executor: notebookEditExec },
    { schema: listenSchema, executor: listenExec },
    { schema: askUserSchema, executor: askUserExec },
    { schema: enterPlanSchema, executor: enterPlanExec },
    { schema: exitPlanSchema, executor: exitPlanExec },
    { schema: taskOutputSchema, executor: taskOutputExec },
    { schema: taskStopSchema, executor: taskStopExec },
    { schema: enterWorktreeSchema, executor: enterWorktreeExec },
    { schema: exitWorktreeSchema, executor: exitWorktreeExec },
  ];
  for (const t of toolList) {
    if (!t.schema || !t.executor) continue;
    const { name, description, input_schema } = t.schema;
    toolRegistry.register(
      { name, description, input_schema },
      async (input, ctx) => {
        // Intercept `open <url>` / `xdg-open` / `start` commands so the model's
        // "open this in the browser" opens the embedded browser instead of the
        // OS default (Chrome). Mirrors the claude-code engine's PreToolUse hook,
        // but lives in the executor wrapper so it also covers the in-process
        // Coderix engine (the default engine).
        if (name === 'bash') {
          const url = extractOpenUrl(
            (input as { command?: string } | undefined)?.command ?? '',
            ctx.cwd ?? activeWorkDir,
          );
          if (url) {
            safeSend(windowManager?.getMainWindow() ?? null, IPC_CHANNELS.BROWSER_OPEN_URL, { url });
            return { content: `Opened in the embedded browser: ${url}`, isError: false };
          }
        }
        const result = await t.executor(input, { cwd: ctx.cwd ?? activeWorkDir, allowMutation: true, sessionId: ctx.sessionId });
        return { content: String(result.content ?? ''), isError: result.isError ?? false };
      },
    );
  }
  console.log(`[Coderix] Registered ${toolRegistry.names.length} tools: ${toolRegistry.names.join(', ')}`);
  sharedToolRegistry = toolRegistry;
  return toolRegistry;
}

// Build a callModel bound to a specific model + endpoint, falling back to an
// "API 未配置" assistant message when the client can't be constructed.
function makeCallModelSafe(
  appConfig: ReturnType<typeof loadDesktopConfig>,
  override: ReturnType<typeof resolveModelByName>,
  model: string,
): QueryEngineConfig['callModel'] {
  const baseURL = override?.baseUrl ?? appConfig.baseUrl;
  const apiKey = override?.apiKey ?? appConfig.apiKey;
  try {
    const callModel = createCallModel(
      { ...appConfig, baseUrl: baseURL, apiKey, protocol: override?.protocol ?? appConfig.protocol },
      model,
    );
    console.log(`[Coderix] callModel initialized: model=${model}, baseURL=${baseURL}`);
    return callModel;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Coderix] Failed to initialize Anthropic client:', message);
    return (async function* (_params: unknown) {
      yield {
        type: 'message' as const,
        data: {
          type: 'assistant' as const,
          message: {
            content: `⚠️ **API 未配置**\n\n无法初始化模型客户端:\n\`\`\`\n${message}\n\`\`\`\n\n请在设置中配置 API Key。`,
            stop_reason: 'end_turn' as const,
            usage: { input_tokens: 0, output_tokens: 0 },
            model: 'system',
          },
        },
      } as unknown;
    }) as unknown as QueryEngineConfig['callModel'];
  }
}

// Build a QueryEngine bound to a single session. Each engine owns a private
// SessionManager that `adopt()`s the registry's session object (single in-memory
// source of truth) plus a fresh callModel bound to the session's model. This is
// what lets the in-process coderix engine run multiple sessions in parallel:
// isActive/messageQueue/abortController are all per-instance.
async function createEngineForSession(session: Session): Promise<QueryEngine> {
  const appConfig = loadDesktopConfig();
  const sessionModel =
    session.model && session.model !== 'unknown' ? session.model : activeModel;
  const override = resolveModelByName(sessionModel);
  const model = override?.model ?? sessionModel;
  const callModel = makeCallModelSafe(appConfig, override, model);

  const perSessionManager = new SessionManager(false);
  perSessionManager.adopt(session);

  const engine = new QueryEngine({
    cwd: session.cwd ?? activeWorkDir,
    model,
    sessionManager: perSessionManager,
    toolRegistry: buildSharedToolRegistry(),
    callModel,
    skills: session.skills ?? [],
  });
  await engine.init();
  engine.setPermissionMode(resolvePermissionMode(loadSettings()) as PermissionMode);
  return engine;
}

async function initQueryEngine(workDir: string = activeWorkDir, modelOverride?: string): Promise<void> {
  if (!ipcBridge) {
    throw new Error('IPC bridge not initialized');
  }

  activeWorkDir = workDir;

  // Load config from ~/.coderix/settings.json
  const appConfig = loadDesktopConfig();
  // A model override (per-session model switch) binds the engine to that model
  // and its own endpoint/auth, without mutating the desktop default model.
  const override = modelOverride ? resolveModelByName(modelOverride) : undefined;
  const model = override?.model ?? appConfig.model;
  // The stable `provider/model` identity (e.g. "local_deepseek/deepseek-v4-pro")
  // that sessions persist and re-resolve by. `model` above is the bare API name
  // and is ambiguous across providers, so only the full id may be stored.
  const modelId = override ? `${override.provider}/${override.model}` : appConfig.modelId;

  activeModel = modelId;
  console.log(`[Coderix] Config ${sharedToolRegistry ? 'reloaded' : 'loaded'}: model=${model}, baseURL=${override?.baseUrl ?? appConfig.baseUrl}`);

  // Set the engine BEFORE (re)initializing the bootstrap so an engine switch
  // (e.g. coderix → claude-code) takes effect even if the per-session engine
  // factory throws later. `initEngine` clears any cached per-session engines so
  // the next submit for a session rebuilds with the current model / registry /
  // cwd (a live stream is unaffected — its generator already holds its engine).
  ipcBridge.setEngine(appConfig.engine ?? 'coderix');

  // Prime the shared tool registry (built once) so tool registration and its
  // log line happen at startup rather than on the first message.
  buildSharedToolRegistry();

  await ipcBridge.initEngine({
    cwd: activeWorkDir,
    model: modelId,
    sessionManager: sessionManagerRef!,
  });
  console.log('[Coderix] QueryEngine bootstrap ready');
}

// ---------------------------------------------------------------------------
// App lifecycle events
// ---------------------------------------------------------------------------

app.whenReady().then(bootstrap);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (windowManager) {
    const existingWindow = windowManager.getMainWindow();
    if (existingWindow && !existingWindow.isDestroyed()) {
      existingWindow.show();
      existingWindow.focus();
    } else {
      windowManager.createMainWindow();
    }
  }
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

app.on('before-quit', () => {
  console.log('[Coderix] Shutting down...');
  windowManager?.saveWindowState();
  ipcBridge?.destroy();
  browserViewManager?.destroy();
  fileWatcher?.destroy();
  terminalManager?.destroyAll();
  trayManager?.destroy();
  protocolGateway?.close();
  console.log('[Coderix] Shutdown complete');
});

// ---------------------------------------------------------------------------
// Unhandled error handling
// ---------------------------------------------------------------------------

process.on('uncaughtException', (error) => {
  console.error('[Coderix] Uncaught exception:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Coderix] Unhandled rejection:', reason);
});
