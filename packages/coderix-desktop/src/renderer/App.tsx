/**
 * App — Root component for Coderix Desktop
 *
 * Wires together the three-panel layout:
 *   Sidebar (sessions + files + team) | Main (chat + composer + terminal) | Detail (diff/preview)
 *
 * Architecture:
 *   - UI state:      Zustand useUIStore (sidebar/detail visibility, terminal, theme, permission mode)
 *   - Chat state:    Zustand useChatStore (messages, streaming, session)
 *   - Session state: Zustand useSessionStore (session list, CRUD)
 *   - Stream state:  Zustand useStreamStore (stream blocks, token usage)
 *   - IPC layer:     Subscribes to main-process stream events and permission requests
 *
 * Design: WeChat × Apple desktop style — frosted glass sidebar, clean typography,
 *         subtle animations, dark mode default.
 */

import React, { useEffect, useCallback, useMemo, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { FolderOpen, Folder, ChevronDown, MessageSquarePlus, Check, X } from 'lucide-react';
import { AppLayout } from './components/layout/AppLayout';
import { Sidebar, type SidebarTab } from './components/sidebar/Sidebar';
import { LibraryView, SkillsView, PluginsView } from './components/library/LibraryView';
import { AppDisplayPanel } from './components/apps/AppDisplayPanel';
import { APPS, type AppDefinition } from './components/apps/registry';
import { ChatView } from './components/chat/ChatView';
import { SubagentPane } from './components/chat/SubagentPane';
import { buildTrajectoryCalls } from './components/chat/trajectory';
import type { TrajectoryCall } from './components/chat/trajectory';
import { Composer } from './components/composer/Composer';
import { ModelCascadePicker } from './components/composer/ModelCascadePicker';
import { SkillPicker } from './components/composer/SkillPicker';
import { McpPicker } from './components/composer/McpPicker';
import { PermissionPrompt } from './components/composer/PermissionPrompt';
import { QuestionPrompt } from './components/composer/QuestionPrompt';
import { DetailPanel } from './components/panels/DetailPanel';
import TerminalPanel from './components/terminal/TerminalPanel';
import SettingsView from './components/settings/SettingsView';
import { BrowserPanel } from './components/browser';
import { GlobalModal } from './components/modals';
import { useUIStore, useChatStore, useSessionStore, useStreamStore, useBrowserStore, useSubagentStore } from './store';
import { HOME_URL } from './store/browserStore.js';
import { useSettingsStore } from './store/settingsStore.js';
import { useEditorStore } from './store/editorStore.js';
import { useT } from './i18n/index.js';
import { useStreamEvents } from './hooks/useStreamEvents';
import { useAgentEvents } from './hooks/useAgentEvents';
import {
  submitQuery,
  interruptQuery,
  onPermissionRequest,
  approvePermission,
  denyPermission,
  getProjectDirectory,
  selectProjectDirectory,
  pickProjectDirectory,
  listProjectDirectories,
  setProjectDirectory,
  removeProjectDirectory,
  getHomeDir,
  listSkills,
  setSessionSkills,
  listMcpCatalog,
  setSessionMcpServers,
  listSkillDirs,
  addSkillDir,
  removeSkillDir,
} from './ipc-client';
import type { SkillInfo, McpServerStatus } from './ipc-client';
import type { PermissionRequest, QuestionRequest } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingPermission {
  request: PermissionRequest;
  resolve: (approved: boolean) => void;
}

interface PendingQuestion {
  request: QuestionRequest;
}

/**
 * Extract the last path segment (folder name) from a workspace path.
 * Handles both POSIX (`/`) and Windows (`\`) separators.
 */
function getFolderName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/**
 * Strip the Claude Code SDK's continuation/auto-compact wrapper from a user
 * message string. When a session is resumed, the SDK prepends a summary of the
 * earlier conversation, ending with a "[Latest message]" line. We keep only
 * that final line — the actual text the user typed.
 */
function stripCompactWrapper(content: string): string {
  const marker = '[Latest message]';
  const idx = content.lastIndexOf(marker);
  if (idx < 0) return content;
  const after = content.slice(idx + marker.length).trim();
  return after || content;
}

// ---------------------------------------------------------------------------
// App Shell
// ---------------------------------------------------------------------------

export function App(): React.ReactElement {
  // ── UI State ────────────────────────────────────────────────────────────
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const detailPanelOpen = useUIStore((s) => s.detailPanelOpen);
  const terminalOpen = useUIStore((s) => s.terminalOpen);
  const browserPanelOpen = useUIStore((s) => s.browserPanelOpen);
  const theme = useUIStore((s) => s.theme);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const toggleDetailPanel = useUIStore((s) => s.toggleDetailPanel);
  const toggleTerminal = useUIStore((s) => s.toggleTerminal);
  const toggleBrowserPanel = useUIStore((s) => s.toggleBrowserPanel);
  const subagentVisible = useSubagentStore((s) => s.tabs.length > 0);
  const activeAppId = useUIStore((s) => s.activeAppId);
  const setActiveAppId = useUIStore((s) => s.setActiveAppId);
  const setTheme = useUIStore((s) => s.setTheme);
  const setTerminalOpen = useUIStore((s) => s.setTerminalOpen);
  const setPermissionMode = useUIStore((s) => s.setPermissionMode);
  const gitBranch = useUIStore((s) => s.gitBranch);
  const gitAhead = useUIStore((s) => s.gitAhead);
  const gitBehind = useUIStore((s) => s.gitBehind);

  // ── Settings state ─────────────────────────────────────────────────────
  const settings = useSettingsStore((s) => s.settings);
  const loadSettings = useSettingsStore((s) => s.load);
  const t = useT();

  // ── Chat State ──────────────────────────────────────────────────────────
  const messages = useChatStore((s) => s.messages);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const error = useChatStore((s) => s.error);
  const setSessionId = useChatStore((s) => s.setSessionId);
  const sessionId = useChatStore((s) => s.sessionId);

  // ── Session State ───────────────────────────────────────────────────────
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const loadSessions = useSessionStore((s) => s.loadSessions);
  const createSession = useSessionStore((s) => s.createSession);

  // ── Stream State (token usage for StatusBar) ────────────────────────────
  const streamCurrentMessage = useStreamStore((s) => s.currentMessage);
  const tokenUsage = useStreamStore((s) => s.tokenUsage);

  // ── Local state ─────────────────────────────────────────────────────────
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<QuestionRequest | null>(null);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('sessions');
  // True while viewing a project's file/git management interface without an
  // active conversation (entered by double-clicking a project in the library).
  const [projectManageOpen, setProjectManageOpen] = useState(false);
  const [projectPath, setProjectPath] = useState('');
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [recentProjects, setRecentProjects] = useState<string[]>([]);
  // Workspace editor popup state: the editable path, the filter query (kept in
  // sync with the input), the resolved home dir for `~` previews, and any
  // inline validation error shown when the typed path can't be switched to.
  const [workspaceValue, setWorkspaceValue] = useState('');
  const [workspaceQuery, setWorkspaceQuery] = useState('');
  const [workspaceHome, setWorkspaceHome] = useState('');
  const [workspaceError, setWorkspaceError] = useState('');
  const workspaceInputRef = useRef<HTMLInputElement>(null);
  // The active session's own model ("provider/model" or bare name). Tracked
  // here (not read from the global default) so switching models in one session
  // never changes the model shown for any other session.
  const [sessionModel, setSessionModelState] = useState<string | null>(null);
  // Skills selected for the active session (mirrors sessionModel's per-session
  // ownership: switching sessions restores that session's own selection).
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [availableSkills, setAvailableSkills] = useState<SkillInfo[]>([]);
  const [customSkillDirs, setCustomSkillDirs] = useState<string[]>([]);
  // MCP servers enabled for the active session + all configured servers.
  const [selectedMcpServers, setSelectedMcpServers] = useState<string[]>([]);
  const [availableMcpServers, setAvailableMcpServers] = useState<McpServerStatus[]>([]);
  const workspaceRef = useRef<HTMLDivElement>(null);

  // Bundled skills (~/.coderix/skills/) are enabled by default for the built-in
  // engine; the user can uncheck them in the picker to opt out. Only the coderix
  // engine reports a `builtin` source, so this is empty for the claude-code engine.
  const builtinSkillNames = useMemo(
    () => availableSkills.filter((s) => s.source === 'builtin').map((s) => s.name),
    [availableSkills],
  );
  // Tracks which session already had its built-in default applied, so we don't
  // re-override an explicitly emptied selection when a session is revisited.
  const defaultedSkillsFor = useRef<string | null>(null);

  // Holds the last committed composer value before clearing
  const composerValueRef = useRef('');

  // Prompts (permission + AskUserQuestion) raised by sessions that are NOT the
  // currently-viewed one. Keyed by session id so a concurrent prompt from a
  // backgrounded session is stashed here and surfaced when that session is
  // selected, instead of being dropped or clobbering the viewed session's
  // prompt. The *viewed* session's prompt lives in `pendingPermission` /
  // `pendingQuestion` state above.
  const backgroundedPermissions = useRef(new Map<string, PermissionRequest>());
  const backgroundedQuestions = useRef(new Map<string, QuestionRequest>());

  // ── Activate IPC stream listeners ───────────────────────────────────────
  // Registers onStreamBlock, onStreamDone, onStreamError, onTokenUsage
  // via the preload contextBridge. Cleaned up on unmount.
  useStreamEvents();
  useAgentEvents();

  // ── Close the sub-agent side pane when the viewed session changes ─────────
  // The pane's tabs are scoped to the conversation that spawned them, so
  // switching sessions closes them. Sub-agent records are kept (not cleared) so
  // switching back and re-clicking the card recovers the full transcript.
  const closeSubagents = useSubagentStore((s) => s.close);
  useEffect(() => {
    closeSubagents();
  }, [sessionId, closeSubagents]);

  // ── Load settings / current project on mount ──────────────────────────
  useEffect(() => {
    loadSettings().catch((err) => console.error('[App] Failed to load settings:', err));
  }, [loadSettings]);

  // Hydrate the transient UI permission mode from the persisted settings
  // (~/.coderix/settings.json). Without this, useUIStore.permissionMode keeps
  // its hardcoded 'ask' default across restarts, so the auto-approve gate below
  // (onPermissionRequest) would always prompt even when the user saved 'auto'.
  useEffect(() => {
    if (!settings) return;
    setPermissionMode(settings.defaultPermissionMode);
  }, [settings, setPermissionMode]);

  useEffect(() => {
    getProjectDirectory()
      .then((result) => setProjectPath(result.path))
      .catch((err) => console.error('[App] Failed to load project directory:', err));
  }, []);

  // Load recent projects when the library view opens, so its projects tab
  // always renders an up-to-date card grid.
  useEffect(() => {
    if (sidebarTab === 'library') {
      listProjectDirectories()
        .then((result) => setRecentProjects(result.paths ?? []))
        .catch((err) => console.error('[App] Failed to list project directories:', err));
    }
  }, [sidebarTab]);

  // Load discoverable Claude Code skills for the current workspace. Re-run on
  // workspace change so project-level (.claude/skills) skills appear/disappear.
  useEffect(() => {
    listSkills()
      .then((skills) => setAvailableSkills(skills))
      .catch((err) => console.error('[App] Failed to list skills:', err));
    listSkillDirs()
      .then((dirs) => setCustomSkillDirs(dirs))
      .catch((err) => console.error('[App] Failed to list skill dirs:', err));
    listMcpCatalog()
      .then((servers) => setAvailableMcpServers(servers))
      .catch((err) => console.error('[App] Failed to list MCP servers:', err));
  }, [projectPath]);

  // Re-read the MCP catalog after a persistent mutation in the 链接器 page
  // (enable/disable, remove, configure). Session selection is unaffected.
  const refreshMcp = useCallback(
    () => listMcpCatalog().then((servers) => setAvailableMcpServers(servers)).catch(() => {}),
    [],
  );

  // Default a freshly-created session to the built-in skills (checked) so they
  // stay enabled unless the user unchecks them in the picker. Applied once per
  // session id; sessions selected via the sidebar set their own authoritative
  // selection (which the `defaultedSkillsFor` ref guards against overriding).
  useEffect(() => {
    if (!sessionId) return;
    if (defaultedSkillsFor.current === sessionId) return;
    if (builtinSkillNames.length === 0) return;
    defaultedSkillsFor.current = sessionId;
    setSelectedSkills(builtinSkillNames);
    setSessionSkills(builtinSkillNames, sessionId ?? undefined).catch(() => {});
  }, [sessionId, builtinSkillNames, setSessionSkills]);

  // ── Custom skill directory management ───────────────────────────────────
  const handleAddSkillDir = () => {
    addSkillDir()
      .then((res) => {
        if (res.canceled) return;
        setCustomSkillDirs(res.dirs);
        setAvailableSkills(res.skills);
      })
      .catch((err) => console.error('[App] Failed to add skill dir:', err));
  };

  const handleRemoveSkillDir = (path: string) => {
    removeSkillDir(path)
      .then((res) => {
        setCustomSkillDirs(res.dirs);
        setAvailableSkills(res.skills);
      })
      .catch((err) => console.error('[App] Failed to remove skill dir:', err));
  };

  // Shared skill-selection mutation (composer picker + library Skills tab).
  const handleSkillsChange = useCallback(
    (next: string[]) => {
      setSelectedSkills(next);
      setSessionSkills(next, sessionId ?? undefined).catch(() => {});
    },
    [setSessionSkills, sessionId],
  );

  // Shared MCP-server-selection mutation (composer MCP picker).
  const handleMcpChange = useCallback(
    (next: string[]) => {
      setSelectedMcpServers(next);
      setSessionMcpServers(next, sessionId ?? undefined).catch(() => {});
    },
    [setSessionMcpServers, sessionId],
  );

  // ── Permission request listener ─────────────────────────────────────────
  useEffect(() => {
    const unsubscribe = onPermissionRequest((req: PermissionRequest) => {
      // Auto-approve if permission mode is 'auto'
      if (useUIStore.getState().permissionMode === 'auto') {
        approvePermission(req.id).catch((err) => {
          console.error('[App] Failed to auto-approve permission:', err);
        });
        return;
      }

      // A backgrounded session's prompt is stashed and shown when that session
      // is selected; only the viewed session's prompt shows immediately.
      if (req.sessionId && req.sessionId !== useChatStore.getState().sessionId) {
        backgroundedPermissions.current.set(req.sessionId, req);
        return;
      }

      // Show inline prompt (replaces any existing pending permission)
      setPendingPermission(req);
    });

    return unsubscribe;
  }, []);

  // ── Question request listener ───────────────────────────────────────────
  useEffect(() => {
    if (!window.coderixAPI?.onQuestionRequest) return;
    const unsub = window.coderixAPI.onQuestionRequest((req: QuestionRequest) => {
      console.log('[App] Question received:', req.toolName, req.questions?.length, 'questions');
      if (req.sessionId && req.sessionId !== useChatStore.getState().sessionId) {
        backgroundedQuestions.current.set(req.sessionId, req);
        return;
      }
      setPendingQuestion(req);
    });
    return unsub;
  }, []);

  // ── Auto-close right panel when all editor/diff tabs are closed ─────
  const editorTabs = useEditorStore((s) => s.tabs);
  useEffect(() => {
    if (editorTabs.length === 0 && detailPanelOpen) {
      toggleDetailPanel();
    }
  }, [editorTabs.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── File open event (from FileExplorer) ─────────────────────────────
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail as { path: string; name: string; content: string };
      useEditorStore.getState().openFile({ path: d.path, name: d.name, content: d.content, language: '', modified: false });
      // Open the right panel if not already open
      if (!useUIStore.getState().detailPanelOpen) useUIStore.getState().toggleDetailPanel();
    };
    window.addEventListener('coderix:open-file', handler);
    return () => window.removeEventListener('coderix:open-file', handler);
  }, []);

  // ── Git diff event listener ──────────────────────────────────────────
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail as { file: string; diff: string; content?: string };
      useEditorStore.getState().openDiff({
        path: d.file,
        name: d.file.split('/').pop() ?? d.file,
        diff: d.diff,
        content: d.content,
      });
      if (!useUIStore.getState().detailPanelOpen) useUIStore.getState().toggleDetailPanel();
    };
    window.addEventListener('coderix:open-diff', handler);
    return () => window.removeEventListener('coderix:open-diff', handler);
  }, []);

  // ── Reload sessions when sidebar opens ─────────────────────────────────
  useEffect(() => {
    if (sidebarOpen) loadSessions();
  }, [sidebarOpen, loadSessions]);

  // ── Theme sync to DOM ───────────────────────────────────────────────────
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // ── Language sync from persisted settings ──────────────────────────────
  useEffect(() => {
    if (settings?.language) {
      useUIStore.getState().setLanguage(settings.language);
    }
  }, [settings?.language]);

  // ── Keyboard shortcuts ──────────────────────────────────────────────────
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      const meta = e.metaKey || e.ctrlKey;

      // ⌘B — toggle sidebar
      if (meta && e.key === 'b' && !e.shiftKey) {
        e.preventDefault();
        toggleSidebar();
      }
      // ⌘J — toggle detail panel
      if (meta && e.key === 'j' && !e.shiftKey) {
        e.preventDefault();
        toggleDetailPanel();
      }
      // ⌘` — toggle terminal (use code for cross-keyboard reliability)
      if (meta && (e.key === '`' || e.code === 'Backquote')) {
        e.preventDefault();
        toggleTerminal();
      }
      // ⌘. — interrupt the viewed session's generation (other sessions keep
      // running).
      if (meta && e.key === '.') {
        e.preventDefault();
        const sid = useChatStore.getState().sessionId ?? undefined;
        void interruptQuery(sid).catch((err) => {
          console.error('[App] Failed to interrupt query:', err);
        });
        useChatStore.getState().interruptStream(sid);
      }
      // ⌘⇧T — toggle theme
      if (meta && e.shiftKey && e.key === 't') {
        e.preventDefault();
        setTheme(theme === 'dark' ? 'light' : 'dark');
      }
      // ⌘, — open settings
      if (meta && e.key === ',') {
        e.preventDefault();
        setSettingsOpen((prev) => !prev);
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleSidebar, toggleDetailPanel, toggleTerminal, setTheme, theme]);

  // ── Header bar custom events ──────────────────────────────────────────
  useEffect(() => {
    function handleToggleSidebar(): void {
      toggleSidebar();
    }

    window.addEventListener('coderix:toggle-sidebar', handleToggleSidebar);
    return () => window.removeEventListener('coderix:toggle-sidebar', handleToggleSidebar);
  }, [toggleSidebar]);

  // ── Open agent-requested URLs in the embedded browser ────────────────────
  // Open a URL in the embedded browser panel (shared by agent-driven `open <url>`
  // commands and terminal http-link clicks).
  const openUrlInBrowser = useCallback((url: string) => {
    if (!url) return;
    const a = window.coderixAPI?.browser;
    const browserStore = useBrowserStore.getState();
    const active = browserStore.tabs.find((t) => t.id === browserStore.activeTabId);
    // Reuse the active tab if it is still on the default home page (fresh);
    // otherwise open a new tab so we don't clobber the user's browsing.
    if (active && (active.url === '' || active.url === HOME_URL)) {
      browserStore.updateTab(active.id, { url, title: '', loadError: undefined });
      a?.navigate(active.id, url).catch(() => {});
    } else {
      browserStore.openTab(url);
    }
    // Reveal the panel if it isn't already visible.
    if (!useUIStore.getState().browserPanelOpen) {
      useUIStore.getState().toggleBrowserPanel();
    }
  }, []);

  // When Claude Code runs `open <url>` / `xdg-open <url>` / `start <url>`, the
  // main process redirects it here (via `browser:open-url`) instead of the OS
  // default browser. Open the browser panel and show the URL in a tab.
  useEffect(() => {
    const a = window.coderixAPI?.browser;
    if (!a?.onOpenUrl) return;
    return a.onOpenUrl((url) => openUrlInBrowser(url));
  }, [openUrlInBrowser]);

  // ── Callbacks ───────────────────────────────────────────────────────────
  const handleSessionSelect = useCallback(
    async (id: string) => {
      // Selecting a conversation always returns the main area to the chat view
      // (leaving skills/plugins/library). Do this before the no-op guard so
      // clicking the already-active session still navigates back to chat.
      setSidebarTab('sessions');
      setProjectManageOpen(false);

      // Clicking the already-active session is a no-op — re-selecting it must
      // not interrupt a running task or reload the transcript.
      if (id === useSessionStore.getState().currentSessionId) {
        return;
      }

      // Route the swap through the per-session stores: stash the currently
      // viewed session's live state into its cache slot and load the target's
      // cached transcript. Switching never aborts a running task — any
      // background stream keeps accumulating into its own cache.
      useStreamStore.getState().setViewedSession(id);
      const hadCached = setSessionId(id);
      useSessionStore.getState().setCurrentSessionId(id);

      // Surface any permission / question prompt this session raised while it
      // was backgrounded, and drop the previously-viewed session's prompt from
      // the visible slot (its own prompt was already stashed or resolved).
      const storedPermission = backgroundedPermissions.current.get(id);
      backgroundedPermissions.current.delete(id);
      setPendingPermission(storedPermission ?? null);
      const storedQuestion = backgroundedQuestions.current.get(id);
      backgroundedQuestions.current.delete(id);
      setPendingQuestion(storedQuestion ?? null);

      // The session's own persisted skills are authoritative — don't let the
      // built-in default effect override them when this session is re-opened.
      defaultedSkillsFor.current = id;
      // Load session messages from backend
      try {
        if (window.coderixAPI?.session?.load) {
          const session = await window.coderixAPI.session.load(id) as any;

          // The session now owns its model; surface it in the composer picker.
          // Re-read settings only to keep other labels (StatusBar etc.) in sync.
          const loadedModel =
            typeof session?.model === 'string' &&
            session.model &&
            session.model !== 'unknown'
              ? session.model
              : null;
          setSessionModelState(loadedModel);
          useSettingsStore.getState().load().catch(() => {});

          // Restore the session's own skill selection (per-session skills).
          setSelectedSkills(
            Array.isArray(session?.skills)
              ? (session.skills as string[])
              : [],
          );

          // Restore the session's own MCP server selection (per-session MCP).
          setSelectedMcpServers(
            Array.isArray(session?.mcpServers)
              ? (session.mcpServers as string[])
              : [],
          );

          // Keep the workspace label in sync with the session's own workspace
          // (the main process already switched `currentWorkDir` on load).
          if (typeof session?.cwd === 'string' && session.cwd) {
            setProjectPath(session.cwd);
          }

          if (session?.messages) {
            const chatMsgs = session.messages.map((m: any) => {
              let blocks = m.content || [];
              // Convert string content to text block (strip the SDK's auto-compact
              // continuation wrapper so only the user's actual input is shown).
              if (typeof blocks === 'string') {
                blocks = [{ type: 'text', content: stripCompactWrapper(blocks), state: 'done' }];
              } else if (Array.isArray(blocks)) {
                // Normalize content blocks: backend uses 'text' field, UI expects 'content' field
                blocks = blocks.map((b: any) => {
                  // Backend blocks use `text` for text blocks, `thinking` for
                  // thinking/reasoning blocks, and `content` for tool results.
                  // Tool results may carry `content` as a string or as an array
                  // of text blocks — flatten the latter so the tool card always
                  // receives plain text.
                  let content: unknown = b.text ?? b.thinking ?? b.content ?? '';
                  if (Array.isArray(content)) {
                    content = content
                      .map((c: any) =>
                        typeof c === 'string' ? c : (c?.text ?? ''),
                      )
                      .join('\n');
                  }

                  return {
                    type: b.type || 'text',
                    content: typeof content === 'string' ? content : '',
                    state: b.is_error ? 'error' : 'done',
                    ...(b.tool_use_id ? { toolId: b.tool_use_id } : {}),
                    ...(b.id ? { toolId: b.id } : {}),
                    ...(b.name ? { toolName: b.name } : {}),
                    ...(b.input ? { toolInput: b.input } : {}),
                    ...(b.metadata ? { toolMetadata: b.metadata } : {}),
                    ...(typeof b.startedAt === 'number' ? { startedAt: b.startedAt } : {}),
                    ...(typeof b.endedAt === 'number' ? { endedAt: b.endedAt } : {}),
                  };
                });
              }
              return {
                id: m.id || `${Date.now()}-${Math.random()}`,
                role: m.role as 'user' | 'assistant',
                blocks,
                timestamp: m.timestamp || Date.now(),
              };
            });

            // Pair tool_result blocks with their matching tool_use blocks.
            // Tool results live in user messages but should render inside the
            // preceding assistant message's tool card.
            for (let i = chatMsgs.length - 1; i >= 0; i--) {
              const msg = chatMsgs[i];
              if (!msg || msg.role !== 'user') continue;

              const toolResults: typeof msg.blocks = [];
              const others: typeof msg.blocks = [];
              for (const b of msg.blocks) {
                if (b.type === 'tool_result' && b.toolId) {
                  toolResults.push(b);
                } else {
                  others.push(b);
                }
              }

              // Attach each tool_result to its matching tool_use
              for (const tr of toolResults) {
                let attached = false;
                for (let j = i - 1; j >= 0; j--) {
                  const prev = chatMsgs[j];
                  if (!prev || prev.role !== 'assistant') continue;
                  const idx = prev.blocks.findIndex(
                    (b: { type: string; toolId?: string }) => b.type === 'tool_use' && b.toolId === tr.toolId,
                  );
                  if (idx >= 0) {
                    prev.blocks[idx] = {
                      ...prev.blocks[idx],
                      toolResult: tr.content,
                      toolMetadata: tr.toolMetadata,
                      // An errored tool_result marks its tool_use as errored too,
                      // so the card renders an error state rather than "Done".
                      ...(tr.state === 'error' ? { state: 'error' as const } : {}),
                    };
                    attached = true;
                    break;
                  }
                }
                // If unmatched, keep as standalone in its current message
                if (!attached) {
                  others.push(tr);
                }
              }

              // Remove messages that are now empty (all tool_results were paired)
              if (others.length === 0) {
                chatMsgs.splice(i, 1);
              } else if (others.length !== msg.blocks.length) {
                chatMsgs[i] = { ...msg, blocks: others };
              }
            }

            // A session that was streaming in the background already has an
            // up-to-date transcript in memory; only hydrate a cold session from
            // disk, so a just-streamed turn isn't clobbered by a stale read.
            if (!hadCached) {
              useChatStore.setState({ messages: chatMsgs, isStreaming: false });

              // Hydrate the status bar's token/cost state from the persisted
              // snapshot so a reloaded session doesn't show 0 until its next turn.
              if (useChatStore.getState().sessionId === id) {
                const tu = session?.tokenUsage as
                  | {
                      inputTokens?: number;
                      outputTokens?: number;
                      cacheReadInputTokens?: number;
                      cacheCreationInputTokens?: number;
                    }
                  | undefined;
                if (tu) {
                  useStreamStore.getState().hydrateTokenUsage({
                    inputTokens: tu.inputTokens ?? 0,
                    outputTokens: tu.outputTokens ?? 0,
                    cacheReadTokens: tu.cacheReadInputTokens ?? 0,
                    cacheWriteTokens: tu.cacheCreationInputTokens ?? 0,
                    totalCost: session?.totalCost ?? 0,
                    currency: 'USD',
                    contextTokens: session?.contextTokens ?? 0,
                  });
                }
              }
            }
          }
        }
      } catch (err) {
        console.error('[App] Failed to load session:', err);
      }
    },
    [setSessionId],
  );

  // ── Load sessions on mount & auto-create default session ──────────────
  useEffect(() => {
    async function init(): Promise<void> {
      await loadSessions();
      const sessions = useSessionStore.getState().sessions;
      if (sessions.length === 0) {
        await createSession();
      } else {
        // Auto-select the most recent session and hydrate it fully (transcript,
        // model, skills, workspace) through the same path as a sidebar click.
        // Selecting without hydrating left the first session "current" but with
        // an empty chat pane, so clicking it was a no-op (it was already active).
        await handleSessionSelect(sessions[0].id);
      }
    }
    init().catch((err) => console.error('[App] Session init failed:', err));
  }, [loadSessions, createSession, handleSessionSelect]);

  const handleNewSession = useCallback(async () => {
    // A fresh session inherits the global default model.
    setSessionModelState(null);
    setSelectedSkills([]);
    const cwd = await createSession();
    // A new conversation always lands in a fresh hash subdir under the default
    // workspace — reflect it in the workspace label immediately.
    if (cwd) setProjectPath(cwd);
    const newSid = useSessionStore.getState().currentSessionId;
    if (newSid) {
      // Route the swap through the per-session stores (never abort the previous
      // session's running task) and point the view at the new empty session.
      useStreamStore.getState().setViewedSession(newSid);
      setSessionId(newSid);
    }
  }, [createSession, setSessionId]);

  const handleOpenSettings = useCallback(() => {
    setSettingsOpen((prev) => !prev);
  }, []);

  // Close the workspace menu when clicking outside of it.
  useEffect(() => {
    const clickOut = (e: MouseEvent) => {
      if (workspaceRef.current && !workspaceRef.current.contains(e.target as Node)) {
        setWorkspaceOpen(false);
      }
    };
    document.addEventListener('mousedown', clickOut);
    return () => document.removeEventListener('mousedown', clickOut);
  }, []);

  // Shared post-switch cleanup: reset the active session/chat and reload the
  // session list for the new workspace directory.
  const switchToProject = useCallback(async (path: string) => {
    setProjectPath(path);
    // Leave the conversation without killing any running task: stash the viewed
    // session's live state so it resumes intact when re-selected.
    useStreamStore.getState().setViewedSession(null);
    setSessionId(null);
    useSessionStore.getState().setCurrentSessionId(null);
    setSessionModelState(null);
    setSelectedSkills([]);
    await loadSessions();
  }, [loadSessions, setSessionId]);

  const handleProjectSelect = useCallback(async () => {
    try {
      const result = await selectProjectDirectory();
      if (result.canceled) return;
      await switchToProject(result.path);
    } catch (err) {
      console.error('[App] Failed to select project directory:', err);
    }
  }, [switchToProject]);

  // ── Workspace editor popup ─────────────────────────────────────────────
  // Confirm applies the typed/browsed path; browse only previews a picked dir
  // into the input; remove drops an entry from the recent list. All mirror the
  // agentstation WorkspaceButton flow (preview → confirm) rather than switching
  // the moment a folder is picked.

  const applyWorkspacePath = useCallback(
    async (path: string) => {
      const trimmed = path.trim();
      if (!trimmed) return;
      try {
        const result = await setProjectDirectory(trimmed);
        setWorkspaceError('');
        await switchToProject(result.path);
        setWorkspaceOpen(false);
      } catch (err) {
        console.error('[App] Failed to switch project directory:', err);
        setWorkspaceError(t('workspace.invalidPath'));
      }
    },
    [switchToProject, t],
  );

  const handleWorkspaceConfirm = useCallback(() => {
    void applyWorkspacePath(workspaceValue);
  }, [applyWorkspacePath, workspaceValue]);

  const handleWorkspaceBrowse = useCallback(async () => {
    try {
      const result = await pickProjectDirectory();
      if (result.canceled) return;
      setWorkspaceValue(result.path);
      setWorkspaceQuery(result.path);
      setWorkspaceError('');
      workspaceInputRef.current?.focus();
    } catch (err) {
      console.error('[App] Failed to pick directory:', err);
    }
  }, []);

  const handleWorkspaceRemove = useCallback(async (path: string) => {
    try {
      const result = await removeProjectDirectory(path);
      setRecentProjects(result.paths ?? []);
    } catch (err) {
      console.error('[App] Failed to remove recent project:', err);
    }
  }, []);

  // Switch the main-area surface (技能 / 插件 / 库), always leaving the
  // "project manage" (no-conversation) mode behind — only a library
  // double-click re-enters it.「新建任务」always lands back in the conversation.
  const handleNavigate = useCallback((view: SidebarTab) => {
    setSidebarTab(view);
    setProjectManageOpen(false);
  }, []);

  const handleSidebarNewTask = useCallback(async () => {
    setSidebarTab('sessions');
    setProjectManageOpen(false);
    await handleNewSession();
  }, [handleNewSession]);

  // Attach an app to the current conversation: enable its skills and surface its
  // display page on the right, while the conversation continues on the left.
  const handleOpenApp = useCallback(
    (app: AppDefinition) => {
      setActiveAppId(app.id);
      const nextSkills = Array.from(new Set([...selectedSkills, ...app.skills]));
      setSelectedSkills(nextSkills);
      setSessionSkills(nextSkills, sessionId ?? undefined).catch(() => {});
      // Left = the conversation, right = the app display.
      setSidebarTab('sessions');
      setProjectManageOpen(false);
      useUIStore.getState().setSidebarOpen(true);
    },
    [setActiveAppId, selectedSkills, setSessionSkills, sessionId],
  );

  // Double-click a project in the library: open its file/git management view
  // without a conversation, offering a "create conversation" action instead.
  const handleOpenProject = useCallback(async (path: string) => {
    if (!path) return;
    try {
      const result = await setProjectDirectory(path);
      await switchToProject(result.path);
      // Reveal the sidebar (its persistent file list now points at this
      // project) and swap the chat area for the "create conversation" prompt.
      useUIStore.getState().setSidebarOpen(true);
      setProjectManageOpen(true);
      setSidebarTab('sessions');
    } catch (err) {
      console.error('[App] Failed to open project:', err);
    }
  }, [switchToProject]);

  // Create a new conversation in the currently-open project workspace. Keep the
  // left sidebar on the project view (files/git), but swap the main area from
  // the "create conversation" prompt to the new conversation's chat + composer.
  const handleCreateConversation = useCallback(async () => {
    await handleNewSession();
    setProjectManageOpen(false);
  }, [handleNewSession]);

  const toggleWorkspaceMenu = useCallback(() => {
    setWorkspaceOpen((prev) => {
      const next = !prev;
      if (next) {
        // Seed the editor with the current workspace path and clear any stale
        // filter/error, then focus + select the input for quick retyping.
        setWorkspaceValue(projectPath);
        setWorkspaceQuery('');
        setWorkspaceError('');
        listProjectDirectories()
          .then((result) => setRecentProjects(result.paths ?? []))
          .catch(() => {});
        if (!workspaceHome) {
          getHomeDir()
            .then((r) => setWorkspaceHome(r.path))
            .catch(() => {});
        }
        setTimeout(() => {
          workspaceInputRef.current?.focus();
          workspaceInputRef.current?.select();
        }, 0);
      }
      return next;
    });
  }, [projectPath, workspaceHome]);

  const handleComposerSubmit = useCallback(
    async (value: string) => {
      if (!value.trim()) return;

      // Auto-create a session if none exists yet
      let currentSid = useChatStore.getState().sessionId;
      if (!currentSid) {
        const cwd = await createSession();
        if (cwd) setProjectPath(cwd);
        currentSid = useSessionStore.getState().currentSessionId;
        if (currentSid) {
          setSessionId(currentSid);
        }
      }

      // Add the user message to the chat store (triggers streaming state)
      await sendMessage(value);

      // Submit the query via IPC to the main process
      if (currentSid) {
        try {
          console.log('[App] Submitting query:', value.substring(0, 30), 'session:', currentSid);
          await submitQuery(value, currentSid, selectedSkills);
          // The main process mints the conversation's hash subdir on the first
          // message — refresh the workspace label so it reflects the new dir.
          getProjectDirectory()
            .then((r) => setProjectPath(r.path))
            .catch(() => {});
        } catch (err) {
          console.error('[App] Failed to submit query:', err);
          useChatStore.getState().setError(
            err instanceof Error ? err.message : 'Query submission failed',
          );
        }
      } else {
        console.error('[App] Cannot submit query — no session ID');
        useChatStore.getState().setError('No active session');
      }
    },
    [sendMessage, createSession, setSessionId, selectedSkills],
  );

  // ── Build trajectory calls for the trajectory view ───────────────────────
  // Group the flat message list (plus the in-flight streaming message) into
  // ZCode-style calls — one user turn (INPUT) followed by the assistant
  // response (OUTPUT). Thinking blocks are always shown (detailed mode is the
  // only mode now).
  const trajectoryCalls = useMemo<TrajectoryCall[]>(
    () => buildTrajectoryCalls(messages, streamCurrentMessage, isStreaming),
    [messages, streamCurrentMessage, isStreaming],
  );

  const isEmpty = trajectoryCalls.length === 0;

  // ── Agent status derivation ─────────────────────────────────────────────
  // While streaming, derive a finer-grained status from the blocks being
  // built: an in-flight tool_use → "executing"; otherwise the most recent
  // block type drives the label (thinking → "thinking", text → "output").
  //
  // Only show 'idle' once the model has actually finished responding for this
  // turn (respondingDone).  Between LLM calls (tools settling between two
  // model turns) isStreaming can be momentarily false even though another
  // response is coming — in that gap we keep the previous status instead of
  // flashing idle.
  const respondingDone = useChatStore((s) => s.respondingDone);
  const prevAgentStatusRef = useRef<'idle' | 'thinking' | 'executing' | 'output'>('idle');
  const agentStatus = useMemo<'idle' | 'thinking' | 'executing' | 'output'>(() => {
    if (!isStreaming) {
      if (respondingDone) return 'idle';
      // Turn still in flight (between LLM calls) — keep current status.
      return prevAgentStatusRef.current;
    }
    const blocks = streamCurrentMessage?.blocks ?? [];
    const toolRunning = blocks.some(
      (b) => b.type === 'tool_use' && (b.state === 'executing' || b.state === 'pending'),
    );
    if (toolRunning) return 'executing';
    const last = blocks[blocks.length - 1];
    if (!last) return 'thinking';
    if (last.type === 'thinking' || last.type === 'tool_result') return 'thinking';
    if (last.type === 'text') return 'output';
    return 'thinking';
  }, [isStreaming, respondingDone, streamCurrentMessage]);
  prevAgentStatusRef.current = agentStatus;

  // ── Context window size for the status bar ───────────────────────────────
  // Resolve the active model's max_context from settings. Models without an
  // explicit max_context carry 0 (see settingsStore), so treat a non-positive
  // value as "unknown" and fall back to the 512K default.
  const contextMax = useMemo(() => {
    if (!settings) return 512 * 1024;
    const name = sessionModel ?? settings.defaultModel ?? '';
    if (!name) return 512 * 1024;
    const slash = name.indexOf('/');
    const providerPart = slash >= 0 ? name.slice(0, slash) : null;
    const modelPart = slash >= 0 ? name.slice(slash + 1) : name;
    for (const p of settings.providers) {
      if (providerPart && p.name.toLowerCase() !== providerPart.toLowerCase()) continue;
      for (const m of p.models) {
        if (m.name !== modelPart) continue;
        return m.maxContext > 0 ? m.maxContext : 512 * 1024;
      }
    }
    return 512 * 1024;
  }, [settings, sessionModel]);

  // Workspace display name — the last path segment (folder name). Defaults to
  // the folder name so the menu header reads like the project's name.
  const workspaceName = projectPath ? getFolderName(projectPath) : t('workspace.chooseDir');

  // Recent projects filtered by the workspace editor's query (case-insensitive
  // substring match against the full path, like the agentstation picker).
  const filteredRecentProjects = useMemo(() => {
    if (!workspaceQuery.trim()) return recentProjects;
    const lower = workspaceQuery.toLowerCase();
    return recentProjects.filter((p) => p.toLowerCase().includes(lower));
  }, [recentProjects, workspaceQuery]);

  // Expand a leading `~` in the typed path using the resolved home dir, so the
  // preview can show the concrete directory a tilde path resolves to.
  const expandedWorkspaceValue = useMemo(() => {
    if (!workspaceHome || !workspaceValue.startsWith('~')) return workspaceValue;
    return workspaceHome + workspaceValue.slice(1);
  }, [workspaceValue, workspaceHome]);

  // The currently-attached app (null when no app is open).
  const activeApp = useMemo(() => APPS.find((a) => a.id === activeAppId) ?? null, [activeAppId]);

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <>
      <AppLayout
        sidebar={
        <Sidebar
          activeSessionId={currentSessionId ?? undefined}
          onSessionSelect={handleSessionSelect}
          onNewSession={handleSidebarNewTask}
          activeView={sidebarTab}
          onNavigate={handleNavigate}
        />
      }
        sidebarVisible={sidebarOpen}
        detailPanel={<DetailPanel projectPath={projectPath} />}
        detailVisible={detailPanelOpen}
        browserPanel={<BrowserPanel onClose={toggleBrowserPanel} />}
        browserPanelVisible={browserPanelOpen && !settingsOpen}
        onToggleBrowserPanel={toggleBrowserPanel}
        onToggleDetailPanel={toggleDetailPanel}
        appDisplayPanel={
          activeApp ? (
            <AppDisplayPanel
              app={activeApp}
              workspaceDir={projectPath}
              onClose={() => setActiveAppId(null)}
            />
          ) : undefined
        }
        appDisplayVisible={activeApp !== null}
        subagentPanel={<SubagentPane />}
        subagentVisible={subagentVisible}
        statusBarProps={{
          engine: settings?.engine,
          agentStatus,
          inputTokens: tokenUsage.inputTokens || undefined,
          outputTokens: tokenUsage.outputTokens || undefined,
          cacheReadTokens: tokenUsage.cacheReadTokens || undefined,
          contextTokens: tokenUsage.contextTokens || undefined,
          contextMax,
          cost: tokenUsage.totalCost || undefined,
          currency: tokenUsage.currency || undefined,
          gitBranch: gitBranch || undefined,
          gitAhead: gitAhead || undefined,
          gitBehind: gitBehind || undefined,
          terminalOpen,
          onToggleTerminal: toggleTerminal,
          onOpenSettings: () => setSettingsOpen(true),
        }}
      >
        {/* Main content: skills / plugins / library surface when active, else
            project-manage prompt, else chat + composer + terminal */}
        {sidebarTab === 'skills' ? (
          <SkillsView
            skills={availableSkills}
            selectedSkills={selectedSkills}
            onSkillsChange={handleSkillsChange}
          />
        ) : sidebarTab === 'plugins' ? (
          <PluginsView
            onOpenApp={handleOpenApp}
            mcpServers={availableMcpServers}
            selectedMcp={selectedMcpServers}
            onMcpChange={handleMcpChange}
            onRefreshMcp={refreshMcp}
          />
        ) : sidebarTab === 'library' ? (
          <LibraryView
            projects={recentProjects}
            currentProject={projectPath}
            onOpenProject={handleOpenProject}
            onAddProject={handleProjectSelect}
            onRemoveProject={handleWorkspaceRemove}
          />
        ) : projectManageOpen ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 px-8 text-center">
            <div className="flex items-center justify-center w-12 h-12 rounded-[var(--radius-lg)] bg-[var(--color-brand-muted)] text-[var(--color-brand)]">
              <MessageSquarePlus size={24} />
            </div>
            <div className="space-y-1">
              <div className="text-sm font-semibold text-[var(--color-text-primary)]">{t('project.createConversation')}</div>
              <div className="text-xs text-[var(--color-text-tertiary)]">{t('project.createConversationDesc')}</div>
            </div>
            <button
              type="button"
              onClick={handleCreateConversation}
              className="mt-2 px-4 py-2 rounded-[var(--radius-md)] bg-[var(--color-brand)] text-white text-sm font-medium hover:opacity-90 transition-opacity"
            >
              {t('project.createConversation')}
            </button>
          </div>
        ) : (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {/* Error banner */}
          {error && (
            <div
              className="px-4 py-2 text-sm bg-red-900/60 border-b border-red-700/50 text-red-200 flex items-center gap-2"
              role="alert"
            >
              <span className="flex-1">{error}</span>
              <button
                className="text-red-300 hover:text-white px-2 py-0.5 rounded"
                onClick={() => useChatStore.getState().setError(null)}
              >
                ✕
              </button>
            </div>
          )}

          <ChatView
            calls={trajectoryCalls}
            isEmpty={isEmpty}
            isStreaming={isStreaming}
          />

          {/* Permission prompt — inline above composer (Claude Code style) */}
          {pendingPermission && (
            <PermissionPrompt
              request={pendingPermission}
              onResolved={() => setPendingPermission(null)}
            />
          )}

          {pendingQuestion && (
            <QuestionPrompt
              request={pendingQuestion}
              onResolved={() => setPendingQuestion(null)}
            />
          )}

          {/* Workspace + model selector — side by side above the composer input */}
          <div ref={workspaceRef} className="relative flex items-center gap-3 pl-11 pr-6 pb-1">
            <button
              type="button"
              onClick={toggleWorkspaceMenu}
              className="inline-flex items-center gap-1.5 text-sm text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] transition-colors cursor-pointer max-w-full"
              title={projectPath || t('workspace.chooseProject')}
            >
              <FolderOpen size={14} className="flex-shrink-0" />
              <span className="truncate">{workspaceName}</span>
              <ChevronDown size={12} className={`flex-shrink-0 transition-transform ${workspaceOpen ? 'rotate-180' : ''}`} />
            </button>

            {workspaceOpen && (
              <div className="absolute bottom-full left-11 mb-1 z-50 w-[min(500px,calc(100vw-4rem))] bg-[var(--color-bg-primary)] border border-[var(--color-separator)] rounded-[var(--radius-md)] shadow-lg overflow-hidden">
                {/* Header — title + cancel/confirm */}
                <div className="flex items-center justify-between px-3.5 py-1.5 border-b border-[var(--color-separator)]">
                  <span className="text-xs font-semibold text-[var(--color-text-primary)]">{t('workspace.editTitle')}</span>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setWorkspaceOpen(false)}
                      className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-[11px] font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
                    >
                      <X size={13} />
                      {t('common.cancel')}
                    </button>
                    <button
                      type="button"
                      onClick={handleWorkspaceConfirm}
                      disabled={!workspaceValue.trim()}
                      className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-[11px] font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-quaternary)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      <Check size={13} />
                      {t('common.confirm')}
                    </button>
                  </div>
                </div>

                {/* Body */}
                <div className="p-3.5">
                  {/* Path input + browse */}
                  <div className="flex gap-1.5 items-center">
                    <input
                      ref={workspaceInputRef}
                      className="flex-1 min-w-0 px-2.5 py-1.5 border border-[var(--color-separator)] rounded-[var(--radius-sm)] text-[13px] font-mono text-[var(--color-text-primary)] bg-[var(--color-bg-secondary)] outline-none focus:border-[var(--color-brand)] transition-colors"
                      value={workspaceValue}
                      onChange={(e) => {
                        setWorkspaceValue(e.target.value);
                        setWorkspaceQuery(e.target.value);
                        setWorkspaceError('');
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); handleWorkspaceConfirm(); }
                        else if (e.key === 'Escape') { setWorkspaceOpen(false); }
                      }}
                      placeholder={t('workspace.pathPlaceholder')}
                      spellCheck={false}
                    />
                    <button
                      type="button"
                      onClick={handleWorkspaceBrowse}
                      title={t('workspace.browseFolder')}
                      className="flex items-center justify-center w-8 h-8 border border-[var(--color-separator)] rounded-[var(--radius-sm)] bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)] transition-colors flex-shrink-0"
                    >
                      <FolderOpen size={14} />
                    </button>
                  </div>

                  {/* Inline error */}
                  {workspaceError && (
                    <div className="mt-1.5 text-[11px] text-[var(--color-danger)]">{workspaceError}</div>
                  )}

                  {/* Recent projects */}
                  {filteredRecentProjects.length > 0 && (
                    <div className="pt-2 pb-0.5 text-[11px] font-semibold text-[var(--color-text-tertiary)]">{t('workspace.recentProjects')}</div>
                  )}
                  {filteredRecentProjects.length > 0 && (
                    <div className="mt-1.5 flex flex-col gap-0.5 max-h-40 overflow-y-auto border border-[var(--color-separator)] rounded-[var(--radius-sm)] p-1 bg-[var(--color-bg-primary)]">
                      {filteredRecentProjects.map((p) => (
                        <button
                          key={p}
                          type="button"
                          onClick={() => {
                            setWorkspaceValue(p);
                            setWorkspaceQuery(p);
                            setWorkspaceError('');
                            workspaceInputRef.current?.focus();
                          }}
                          title={p}
                          className={`flex items-center gap-1.5 px-2 py-1 rounded text-left text-xs leading-snug hover:bg-[var(--color-bg-secondary)] transition-colors w-full ${workspaceValue === p ? 'bg-[var(--color-brand-muted)]' : 'text-[var(--color-text-primary)]'}`}
                        >
                          <Folder size={13} className="flex-shrink-0 text-[var(--color-text-tertiary)]" />
                          <span className="font-medium whitespace-nowrap">{getFolderName(p)}</span>
                          <span className="text-[var(--color-text-tertiary)] text-[10px] truncate flex-1 min-w-0">{p}</span>
                          <span
                            className="flex-shrink-0 w-[18px] h-[18px] flex items-center justify-center rounded text-[13px] text-[var(--color-text-tertiary)] hover:bg-[var(--color-danger-muted)] hover:text-[var(--color-danger)] transition-colors"
                            title={t('workspace.removeFromHistory')}
                            onClick={(e) => { e.stopPropagation(); void handleWorkspaceRemove(p); }}
                          >
                            ×
                          </span>
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Tilde expansion preview */}
                  {expandedWorkspaceValue !== workspaceValue && (
                    <div className="mt-2 flex items-center gap-1.5 px-2.5 py-1.5 bg-[var(--color-bg-secondary)] rounded-[var(--radius-sm)] text-xs font-mono text-[var(--color-text-secondary)]">
                      <Folder size={12} className="flex-shrink-0" />
                      <span className="truncate">{expandedWorkspaceValue}</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            <ModelCascadePicker
              model={(sessionModel ?? settings?.defaultModel) || t('modelpicker.unconfigured')}
              onModelChange={setSessionModelState}
              sessionId={sessionId ?? undefined}
            />

            <SkillPicker
              skills={availableSkills}
              selected={selectedSkills}
              onChange={handleSkillsChange}
              customDirs={customSkillDirs}
              onAddDir={handleAddSkillDir}
              onRemoveDir={handleRemoveSkillDir}
            />

            <McpPicker
              servers={availableMcpServers}
              selected={selectedMcpServers}
              onChange={handleMcpChange}
            />
          </div>

          {/* Composer — fixed at bottom of chat */}
          <Composer
            onSubmit={handleComposerSubmit}
            disabled={isStreaming || pendingQuestion !== null}
            isStreaming={isStreaming}
            onInterrupt={() => {
              const sid = sessionId ?? undefined;
              void interruptQuery(sid).catch((err) => {
                console.error('[App] Failed to interrupt query:', err);
              });
              useChatStore.getState().interruptStream(sid);
            }}
          />

          {/* Terminal — collapsible, toggled from the icon sidebar */}
          <TerminalPanel
            isOpen={terminalOpen}
            onToggle={toggleTerminal}
            projectPath={projectPath}
            onOpenBrowserUrl={openUrlInBrowser}
          />
        </div>
        )}
      </AppLayout>


      {/* Global modal layer — permission dialogs, question prompts */}
      <GlobalModal />

      {/* Settings modal — rendered via Portal to escape framer-motion's transform context */}
      {settingsOpen && createPortal(
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            width: '100vw',
            height: '100vh',
            zIndex: 2147483647,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '32px',
          }}
          onClick={() => setSettingsOpen(false)}
        >
          <div
            style={{
              position: 'relative',
              display: 'flex',
              flexDirection: 'column',
              width: '880px',
              maxWidth: '95vw',
              height: '85vh',
              maxHeight: '85vh',
              borderRadius: '12px',
              boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
              background: 'var(--color-bg-primary)',
              overflow: 'hidden',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Settings fills the modal; its internal content pane scrolls */}
            <div style={{ flex: 1, minHeight: 0 }}>
              <SettingsView onClose={() => setSettingsOpen(false)} />
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

App.displayName = 'App';
