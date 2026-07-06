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
import { DetailPanel } from './components/panels/DetailPanel';
import TerminalPanel from './components/terminal/TerminalPanel';
import SettingsView from './components/settings/SettingsView';
import { GlobalModal } from './components/modals';
import type { SidebarTab } from './components/sidebar/IconSidebar';

import { useUIStore, useChatStore, useSessionStore, useStreamStore } from './store';
import { useStreamEvents } from './hooks/useStreamEvents';
import {
  submitQuery,
  onPermissionRequest,
  approvePermission,
  denyPermission,
} from './ipc-client';
import type { PermissionRequest } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingPermission {
  request: PermissionRequest;
  resolve: (approved: boolean) => void;
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
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('sessions');

  // Holds the last committed composer value before clearing
  const composerValueRef = useRef('');

  // ── Activate IPC stream listeners ───────────────────────────────────────
  // Registers onStreamBlock, onStreamDone, onStreamError, onTokenUsage
  // via the preload contextBridge. Cleaned up on unmount.
  useStreamEvents();

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
      // ⌘` — toggle terminal
      if (meta && e.key === '`') {
        e.preventDefault();
        toggleTerminal();
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
    (id: string) => {
      setSessionId(id);
      useSessionStore.getState().setCurrentSessionId(id);
    },
    [setSessionId],
  );

  const handleNewSession = useCallback(async () => {
    await createSession();
    // Sync chat store sessionId with the newly created session
    const newSid = useSessionStore.getState().currentSessionId;
    if (newSid) {
      setSessionId(newSid);
    }
  }, [createSession, setSessionId]);

  const handleOpenSettings = useCallback(() => {
    setSettingsOpen((prev) => !prev);
  }, []);

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
  // Stabilize references: during streaming, only the streaming message changes.
  // Reusing previous ChatViewMessage objects for unchanged messages prevents
  // Framer Motion's AnimatePresence from re-processing every child each render.
  const prevChatMessagesRef = useRef<ChatViewMessage[]>([]);

  const chatViewMessages = useMemo<ChatViewMessage[]>(() => {
    const result: ChatViewMessage[] = [];
    const prevList = prevChatMessagesRef.current;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;
      const prev = prevList[i];

      // Reuse previous wrapper object if message data hasn't changed
      if (
        prev &&
        prev.id === msg.id &&
        prev.blocks === msg.blocks &&
        prev.role === msg.role
      ) {
        result.push(prev);
      } else {
        result.push({
          id: msg.id,
          role: msg.role,
          blocks: msg.blocks,
          timestamp: msg.timestamp,
        });
      }
    }

    // Append streaming message (always fresh — blocks change every delta)
    if (streamCurrentMessage) {
      result.push({
        id: streamCurrentMessage.id,
        role: 'assistant',
        blocks: streamCurrentMessage.blocks,
        timestamp: Date.now(),
        isStreaming: true,
      });
    }

    prevChatMessagesRef.current = result;
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
            activeTab={sidebarTab}
            onTabChange={setSidebarTab}
          />
        }
        sidebarVisible={sidebarOpen}
        iconActiveTab={sidebarTab}
        onIconTabChange={setSidebarTab}
        onIconSettings={() => setSettingsOpen(true)}
        detailPanel={<DetailPanel />}
        detailVisible={detailPanelOpen}
        statusBarProps={{
          model: 'DeepSeek V4 Pro',
          agentStatus,
          inputTokens: tokenUsage.inputTokens || undefined,
          outputTokens: tokenUsage.outputTokens || undefined,
          cost: tokenUsage.totalCost || undefined,
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

          {/* Composer — fixed at bottom of chat */}
          <Composer
            onSubmit={handleComposerSubmit}
            disabled={isStreaming || !!pendingPermission}
            model="DeepSeek V4 Pro"
          />

          {/* Terminal — collapsible */}
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
              width: '720px',
              maxWidth: '95vw',
              height: '85vh',
              maxHeight: '85vh',
              borderRadius: '12px',
              boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
              background: '#ffffff',
              overflow: 'hidden',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header bar */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '16px 20px',
              borderBottom: '1px solid #eee',
              flexShrink: 0,
            }}>
              <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>
                Settings
              </h2>
              <button
                onClick={() => setSettingsOpen(false)}
                style={{
                  width: '28px',
                  height: '28px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: '6px',
                  border: 'none',
                  background: 'transparent',
                  cursor: 'pointer',
                  fontSize: '16px',
                }}
                aria-label="Close settings"
              >
                ✕
              </button>
            </div>
            {/* Scrollable content */}
            <div style={{ flex: 1, overflowY: 'auto' }}>
              <SettingsView />
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

App.displayName = 'App';
