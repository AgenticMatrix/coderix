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
import { createCadViewerManager } from './cad-viewer-manager.js';
import type { CadViewerManager } from './cad-viewer-manager.js';
import { installCadSkills } from './cad-skills.js';
import { applyCadEnv } from './cad-paths.js';
import { safeSend } from './safe-send.js';
import { extractOpenUrl } from './open-url.js';
import { startProtocolGateway } from './protocol-gateway/server.js';
import { installCli, bootstrapConfig } from './cli-installer.js';
import { autoInstallClaudeCodeOnBoot } from './claude-code-runtime.js';

// Direct imports from core package source — avoid @coderix/core bundle (pulls in node:sqlite)
import { QueryEngine } from '../../../../packages/coderix-core/src/core/query-engine.js';
import type { QueryEngineConfig } from '../../../../packages/coderix-core/src/core/query-engine.js';
import type { Session, ToolContext, ToolExecutionResult } from '../../../../packages/coderix-core/src/core/types.js';
import { SessionManager } from '../../../../packages/coderix-core/src/core/session.js';
import { ToolRegistry } from '../../../../packages/coderix-core/src/core/tool-registry.js';
import { createEventBus } from '../../../../packages/coderix-core/src/state/observable.js';
import type { EventBus } from '../../../../packages/coderix-core/src/state/observable.js';
import { createCallModel } from '../../../../packages/coderix-core/src/core/provider-adapter.js';
import { PermissionMode, loadSettings, resolvePermissionMode } from '../../../../packages/coderix-core/src/index.js';
import { loadDesktopConfig, resolveModelByName } from '../../../../packages/coderix-core/src/config.js';

// Single source of truth for the agent tool set + sub-agent runtime, shared
// with the CLI and the ACP agent so every frontend exposes the same tools and
// any tool added to core's `plugins` shows up here automatically.
import { createToolRegistry } from '../../../../packages/coderix-core/src/tools/registry.js';
import { createAgentRuntime } from '../../../../packages/coderix-core/src/agents/runtime.js';
import { McpManager } from '../../../../packages/coderix-core/src/mcp/manager.js';
import type { McpServerStatus } from '../../../../packages/coderix-core/src/mcp/manager.js';
import type { ToolPlugin } from '../../../../packages/coderix-core/src/tools/types.js';

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
let cadViewerManager: CadViewerManager | null = null;
let sessionManagerRef: SessionManager | null = null;
let activeWorkDir = process.cwd();
let activeModel = 'deepseek-v4-pro';
let protocolGateway: ReturnType<typeof startProtocolGateway> | null = null;

// Shared EventBus — routes sub-agent lifecycle (and background-task) events from
// every per-session QueryEngine to the IPC bridge, which forwards them to the
// renderer for live sub-agent rendering.
const sharedEventBus: EventBus = createEventBus();

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

    // Make cad_harness's vendored `cad` + `cad-viewer` skills available to the
    // engine (symlink into ~/.coderix/skills/). Idempotent; no-op if absent.
    installCadSkills();

    // Export the CAD toolchain paths (CAD_PYTHON etc.) so the engine's bash
    // tool and the skill scripts it runs resolve the right Python interpreter.
    applyCadEnv();

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

    // Step 1c: Create cad-viewer manager (spawns the 3D viewer on demand for the
    // "apps" display panel) so its IPC handlers are registered before load.
    cadViewerManager = createCadViewerManager(windowManager);

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
      listMcpServers,
      getMcpManager,
      eventBus: sharedEventBus,
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

// Tool registries are built by @coderix/core's createToolRegistry() — the single
// source of truth shared with the CLI and the ACP agent — so the desktop exposes
// the exact same tools (Agent, task/team tools, MCP) and gains any new core tool
// automatically. Do NOT hand-roll a tool list here.
//
// The built-in set is identical everywhere; only MCP server tools vary by project
// (~/.coderix/mcp.json + <cwd>/.coderix/mcp.json). The desktop is multi-workspace,
// so the registry and its McpManager are cached per cwd.

type RegistryExecutor = (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolExecutionResult>;

const toolRegistryByCwd = new Map<string, ToolRegistry>();
const mcpManagerByCwd = new Map<string, McpManager>();

/** Desktop-specific executor hook: route `bash` `open <url>` to the embedded browser. */
const desktopWrapExecutor = (plugin: ToolPlugin, base: RegistryExecutor): RegistryExecutor =>
  async (input, ctx) => {
    if (plugin.name === 'bash') {
      const url = extractOpenUrl(
        (input as { command?: string } | undefined)?.command ?? '',
        ctx.cwd ?? activeWorkDir,
      );
      if (url) {
        safeSend(windowManager?.getMainWindow() ?? null, IPC_CHANNELS.BROWSER_OPEN_URL, { url });
        return { content: `Opened in the embedded browser: ${url}`, isError: false };
      }
    }
    return base(input, ctx);
  };

/** The cached McpManager for a workspace (connected + discovered on first use). */
async function getMcpManager(cwd: string): Promise<McpManager> {
  let manager = mcpManagerByCwd.get(cwd);
  if (!manager) {
    manager = new McpManager(cwd);
    await manager.initialize();
    mcpManagerByCwd.set(cwd, manager);
    const servers = manager.getConnectedServerNames();
    if (servers.length > 0) {
      console.log(`[Coderix] MCP connected for ${cwd}: ${servers.join(', ')}`);
    }
  }
  return manager;
}

/** MCP tool plugins for a workspace, filtered to the session's enabled servers. */
async function getMcpPlugins(cwd: string, mcpServers?: string[]): Promise<ToolPlugin[]> {
  const manager = await getMcpManager(cwd);
  const names = mcpServers ?? manager.getConnectedServerNames();
  return [...manager.getToolsForServers(names), ...manager.getResourcePlugins()];
}

/** All configured MCP servers with live status, for the picker UI. */
async function listMcpServers(cwd: string): Promise<McpServerStatus[]> {
  const manager = await getMcpManager(cwd);
  return manager.listAllServers();
}

/** The workspace's tool registry (built-in + session-filtered MCP tools). */
async function getToolRegistry(cwd: string, mcpServers?: string[]): Promise<ToolRegistry> {
  const key = `${cwd}|${[...(mcpServers ?? [])].sort().join(',')}`;
  const cached = toolRegistryByCwd.get(key);
  if (cached) return cached;

  const mcpPlugins = await getMcpPlugins(cwd, mcpServers).catch((err) => {
    console.warn(`[Coderix] MCP init failed for ${cwd}:`, err instanceof Error ? err.message : err);
    return [] as ToolPlugin[];
  });

  const registry = createToolRegistry({ extraPlugins: mcpPlugins, wrapExecutor: desktopWrapExecutor });
  console.log(`[Coderix] Registered ${registry.names.length} tools for ${key}: ${registry.names.join(', ')}`);
  toolRegistryByCwd.set(key, registry);
  return registry;
}

/** Close every cached MCP manager on shutdown. */
async function shutdownMcpManagers(): Promise<void> {
  const managers = [...mcpManagerByCwd.values()];
  mcpManagerByCwd.clear();
  toolRegistryByCwd.clear();
  await Promise.all(managers.map((m) => m.shutdown().catch(() => {})));
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

  const cwd = session.cwd ?? activeWorkDir;
  const toolRegistry = await getToolRegistry(cwd, session.mcpServers ?? []);
  const agentRuntime = await createAgentRuntime(cwd);

  const engine = new QueryEngine({
    cwd,
    model,
    sessionManager: perSessionManager,
    toolRegistry,
    callModel,
    skills: session.skills ?? [],
    eventBus: sharedEventBus,
    subAgentRegistry: agentRuntime.subAgentRegistry,
    systemPromptAssembler: agentRuntime.systemPromptAssembler,
    agentRegistry: agentRuntime.agentRegistry,
  });
  await engine.init();
  engine.setPermissionMode(resolvePermissionMode(loadSettings()) as PermissionMode);
  return engine;
}

async function initQueryEngine(workDir?: string, modelOverride?: string): Promise<void> {
  if (!ipcBridge) {
    throw new Error('IPC bridge not initialized');
  }

  // A model-only reload (per-session model switch passes `workDir === undefined`)
  // must NOT rebind the workspace. The conversation's minted subdir lives in the
  // ipc-bridge's `currentWorkDir`; resetting it to the boot-time `activeWorkDir`
  // here would make the next turn resume the Claude Code session from the wrong
  // project directory ("No conversation found with session ID"). Only rebind
  // when a real directory is explicitly supplied.
  if (workDir !== undefined) {
    activeWorkDir = workDir;
  }

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
  console.log(`[Coderix] Config ${toolRegistryByCwd.size > 0 ? 'reloaded' : 'loaded'}: model=${model}, baseURL=${override?.baseUrl ?? appConfig.baseUrl}`);

  // Set the engine BEFORE (re)initializing the bootstrap so an engine switch
  // (e.g. coderix → claude-code) takes effect even if the per-session engine
  // factory throws later. `initEngine` clears any cached per-session engines so
  // the next submit for a session rebuilds with the current model / registry /
  // cwd (a live stream is unaffected — its generator already holds its engine).
  ipcBridge.setEngine(appConfig.engine ?? 'coderix');

  // Prime the active workspace's tool registry (built-in tools + its MCP tools)
  // so registration and its log line happen at startup, not on the first message.
  await getToolRegistry(activeWorkDir);

  await ipcBridge.initEngine({
    cwd: workDir !== undefined ? activeWorkDir : undefined,
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
  cadViewerManager?.destroy();
  fileWatcher?.destroy();
  terminalManager?.destroyAll();
  trayManager?.destroy();
  protocolGateway?.close();
  // Best-effort: disconnect MCP servers (don't block quit on slow servers).
  void shutdownMcpManagers();
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
