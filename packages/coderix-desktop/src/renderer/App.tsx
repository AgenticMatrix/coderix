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
import { AppLayout } from './components/layout/AppLayout';
import { Sidebar } from './components/sidebar/Sidebar';
import { ChatView } from './components/chat/ChatView';
import type { ChatViewMessage } from './components/chat/ChatView';
import { Composer } from './components/composer/Composer';
import { PermissionPrompt } from './components/composer/PermissionPrompt';
import { QuestionPrompt } from './components/composer/QuestionPrompt';
import { DetailPanel } from './components/panels/DetailPanel';
import TerminalPanel from './components/terminal/TerminalPanel';
import SettingsView from './components/settings/SettingsView';
import { GlobalModal } from './components/modals';
import type { SidebarTab } from './components/sidebar/IconSidebar';

import { useUIStore, useChatStore, useSessionStore, useStreamStore } from './store';
import { useSettingsStore } from './store/settingsStore.js';
import { useEditorStore } from './store/editorStore.js';
import { useStreamEvents } from './hooks/useStreamEvents';
import {
  submitQuery,
  interruptQuery,
  onPermissionRequest,
  approvePermission,
  denyPermission,
  getProjectDirectory,
  selectProjectDirectory,
} from './ipc-client';
import type { PermissionRequest, QuestionRequest, StreamBlock } from './types';

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
 * Synthetic background task/agent notifications are injected into the
 * conversation as user messages so the model knows a background task
 * finished. They are model context, not user-visible turns — filter them
 * out of the rendered transcript (mirrors the CLI TUI behaviour).
 */
function isBackgroundNotificationMessage(msg: { role: string; blocks: StreamBlock[] }): boolean {
  return (
    msg.role === 'user' &&
    msg.blocks.some(
      (b) => b.type === 'text' && typeof b.content === 'string' && b.content.startsWith('<background-agent-notifications>'),
    )
  );
}

// ---------------------------------------------------------------------------
// App Shell
// ---------------------------------------------------------------------------

export function App(): React.ReactElement {
  // ── UI State ────────────────────────────────────────────────────────────
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const detailPanelOpen = useUIStore((s) => s.detailPanelOpen);
  const terminalOpen = useUIStore((s) => s.terminalOpen);
  const theme = useUIStore((s) => s.theme);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const toggleDetailPanel = useUIStore((s) => s.toggleDetailPanel);
  const toggleTerminal = useUIStore((s) => s.toggleTerminal);
  const setTheme = useUIStore((s) => s.setTheme);
  const setTerminalOpen = useUIStore((s) => s.setTerminalOpen);
  const gitBranch = useUIStore((s) => s.gitBranch);
  const gitAhead = useUIStore((s) => s.gitAhead);
  const gitBehind = useUIStore((s) => s.gitBehind);

  // ── Settings state ─────────────────────────────────────────────────────
  const settings = useSettingsStore((s) => s.settings);
  const loadSettings = useSettingsStore((s) => s.load);

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
  const [diffData, setDiffData] = useState<{ file: string; diff: string } | null>(null);
  const [projectPath, setProjectPath] = useState('');

  // Holds the last committed composer value before clearing
  const composerValueRef = useRef('');

  // ── Activate IPC stream listeners ───────────────────────────────────────
  // Registers onStreamBlock, onStreamDone, onStreamError, onTokenUsage
  // via the preload contextBridge. Cleaned up on unmount.
  useStreamEvents();

  // ── Load settings / current project on mount ──────────────────────────
  useEffect(() => {
    loadSettings().catch((err) => console.error('[App] Failed to load settings:', err));
  }, [loadSettings]);

  useEffect(() => {
    getProjectDirectory()
      .then((result) => setProjectPath(result.path))
      .catch((err) => console.error('[App] Failed to load project directory:', err));
  }, []);

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

      // Show inline prompt (replaces any existing pending permission)
      setPendingPermission(req);
    });

    return unsubscribe;
  }, []);

  // ── Question request listener (auto-answer for now) ────────────────────
  useEffect(() => {
    if (!window.coderixAPI?.onQuestionRequest) return;
    const unsub = window.coderixAPI.onQuestionRequest((req: QuestionRequest) => {
      console.log('[App] Question received:', req.toolName, req.questions?.length, 'questions');
      setPendingQuestion(req);
    });
    return unsub;
  }, []);

  // ── Load sessions on mount & auto-create default session ──────────────
  useEffect(() => {
    async function init(): Promise<void> {
      await loadSessions();
      const sessions = useSessionStore.getState().sessions;
      if (sessions.length === 0) {
        await createSession();
      } else {
        // Use the most recent session
        const latest = sessions[0];
        setSessionId(latest.id);
        useSessionStore.getState().setCurrentSessionId(latest.id);
      }
    }
    init().catch((err) => console.error('[App] Session init failed:', err));
  }, [loadSessions, createSession, setSessionId]);

  // ── Auto-close right panel when all editor tabs are closed ──────────
  const editorFiles = useEditorStore((s) => s.files);
  useEffect(() => {
    if (editorFiles.length === 0 && detailPanelOpen && !diffData) {
      toggleDetailPanel();
    }
  }, [editorFiles.length]); // eslint-disable-line react-hooks/exhaustive-deps

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
      const d = (e as CustomEvent).detail as { file: string; diff: string };
      setDiffData(d);
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
      // ⌘. — interrupt generation
      if (meta && e.key === '.') {
        e.preventDefault();
        void interruptQuery().catch((err) => {
          console.error('[App] Failed to interrupt query:', err);
        });
        useChatStore.getState().interruptStream();
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

  // ── Callbacks ───────────────────────────────────────────────────────────
  const handleSessionSelect = useCallback(
    async (id: string) => {
      setSessionId(id);
      useSessionStore.getState().setCurrentSessionId(id);
      // Load session messages from backend
      try {
        if (window.coderixAPI?.session?.load) {
          const session = await window.coderixAPI.session.load(id) as any;
          if (session?.messages) {
            const chatMsgs = session.messages.map((m: any) => {
              let blocks = m.content || [];
              // Convert string content to text block
              if (typeof blocks === 'string') {
                blocks = [{ type: 'text', content: blocks, state: 'done' }];
              } else if (Array.isArray(blocks)) {
                // Normalize content blocks: backend uses 'text' field, UI expects 'content' field
                blocks = blocks.map((b: any) => ({
                  type: b.type || 'text',
                  content: b.text || b.content || '',
                  state: 'done',
                  ...(b.tool_use_id ? { toolId: b.tool_use_id } : {}),
                  ...(b.id ? { toolId: b.id } : {}),
                  ...(b.name ? { toolName: b.name } : {}),
                  ...(b.input ? { toolInput: b.input } : {}),
                  ...(b.metadata ? { toolMetadata: b.metadata } : {}),
                }));
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
                    prev.blocks[idx] = { ...prev.blocks[idx], toolResult: tr.content, toolMetadata: tr.toolMetadata };
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

            useChatStore.setState({ messages: chatMsgs, isStreaming: false });
          }
        }
      } catch (err) {
        console.error('[App] Failed to load session:', err);
      }
    },
    [setSessionId],
  );

  const handleNewSession = useCallback(async () => {
    // Clear current messages
    useChatStore.setState({ messages: [], isStreaming: false, streamingContent: '' });
    useStreamStore.setState({ currentMessage: null });
    await createSession();
    const newSid = useSessionStore.getState().currentSessionId;
    if (newSid) setSessionId(newSid);
  }, [createSession, setSessionId]);

  const handleOpenSettings = useCallback(() => {
    setSettingsOpen((prev) => !prev);
  }, []);

  const handleProjectSelect = useCallback(async () => {
    try {
      const result = await selectProjectDirectory();
      if (result.canceled) return;
      setProjectPath(result.path);
      setSessionId(null);
      useSessionStore.getState().setCurrentSessionId(null);
      useChatStore.setState({ messages: [], isStreaming: false, streamingContent: '', sessionId: null });
      useStreamStore.setState({ currentMessage: null });
      await loadSessions();
    } catch (err) {
      console.error('[App] Failed to select project directory:', err);
    }
  }, [loadSessions, setSessionId]);

  const handleComposerSubmit = useCallback(
    async (value: string) => {
      if (!value.trim()) return;

      // Auto-create a session if none exists yet
      let currentSid = useChatStore.getState().sessionId;
      if (!currentSid) {
        await createSession();
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
          await submitQuery(value, currentSid);
          // Reload sessions to pick up auto-generated titles
          useSessionStore.getState().loadSessions();
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
    [sendMessage, createSession, setSessionId],
  );

  // ── Build chat messages for ChatView ────────────────────────────────────
  // Tool-only assistant turns (no text block) merge into the preceding
  // assistant message so their "N tools used" group flows directly under the
  // text instead of rendering as a separate block.
  const chatViewMessages = useMemo<ChatViewMessage[]>(() => {
    const result: ChatViewMessage[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;
      // Skip synthetic background task/agent notifications.
      if (isBackgroundNotificationMessage(msg)) continue;
      const hasText = msg.blocks.some((b: StreamBlock) => b.type === 'text');
      const isToolOnlyAssistant =
        msg.role === 'assistant' &&
        !hasText &&
        msg.blocks.some((b: StreamBlock) => b.type === 'tool_use');

      if (isToolOnlyAssistant) {
        const last = result[result.length - 1];
        if (last && last.role === 'assistant') {
          result[result.length - 1] = {
            ...last,
            blocks: [...last.blocks, ...msg.blocks],
          };
          continue;
        }
      }

      result.push({
        id: msg.id,
        role: msg.role,
        blocks: msg.blocks,
        timestamp: msg.timestamp,
        // A text turn starts a new "group" (blank-line separator above);
        // tool-only turns flow together with no separator.
        isGroupStart: msg.role === 'assistant' && hasText,
      });
    }

    // Append streaming message (always fresh — blocks change every delta)
    if (streamCurrentMessage) {
      result.push({
        id: streamCurrentMessage.id,
        role: 'assistant',
        blocks: streamCurrentMessage.blocks,
        timestamp: Date.now(),
        isStreaming: true,
        isGroupStart: streamCurrentMessage.blocks.some(
          (b: StreamBlock) => b.type === 'text',
        ),
      });
    }

    return result;
  }, [messages, streamCurrentMessage]);

  const isEmpty = chatViewMessages.length === 0;

  // ── Agent status derivation ─────────────────────────────────────────────
  const agentStatus = isStreaming
    ? ('thinking' as const)
    : ('idle' as const);

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <>
      <AppLayout
        sidebar={
        <Sidebar
          activeSessionId={currentSessionId ?? undefined}
          onSessionSelect={handleSessionSelect}
          onNewSession={handleNewSession}
          onOpenSettings={() => setSettingsOpen(true)}
          onSelectProject={handleProjectSelect}
          activeTab={sidebarTab}
          onTabChange={setSidebarTab}
          projectPath={projectPath}
        />
      }
        sidebarVisible={sidebarOpen}
        iconActiveTab={sidebarTab}
        onIconTabChange={setSidebarTab}
        onIconSettings={() => setSettingsOpen(true)}
        detailPanel={<DetailPanel data={diffData} onClose={() => { setDiffData(null); if (detailPanelOpen) toggleDetailPanel(); }} />}
        detailVisible={detailPanelOpen}
        statusBarProps={{
          model: settings?.defaultModel || '未配置模型',
          agentStatus,
          inputTokens: tokenUsage.inputTokens || undefined,
          outputTokens: tokenUsage.outputTokens || undefined,
          cost: tokenUsage.totalCost || undefined,
          projectPath,
          onSelectProject: handleProjectSelect,
          gitBranch: gitBranch || undefined,
          gitAhead: gitAhead || undefined,
          gitBehind: gitBehind || undefined,
          terminalOpen,
          onToggleTerminal: toggleTerminal,
        }}
      >
        {/* Main content: ChatView (scrollable) + Composer (fixed bottom) + Terminal */}
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
            messages={chatViewMessages}
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

          {/* Composer — fixed at bottom of chat */}
          <Composer
            onSubmit={handleComposerSubmit}
            disabled={isStreaming || pendingQuestion !== null}
            isStreaming={isStreaming}
            onInterrupt={() => {
              void interruptQuery().catch((err) => {
                console.error('[App] Failed to interrupt query:', err);
              });
              useChatStore.getState().interruptStream();
            }}
            model={settings?.defaultModel || '未配置模型'}
            onModelPick={() => setSettingsOpen(true)}
          />

          {/* Terminal — collapsible, toggled from the icon sidebar */}
          <TerminalPanel isOpen={terminalOpen} onToggle={toggleTerminal} />
        </div>
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
