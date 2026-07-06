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

import React, { useEffect, useCallback, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AppLayout } from './components/layout/AppLayout';
import { Sidebar } from './components/sidebar/Sidebar';
import { ChatView } from './components/chat/ChatView';
import type { ChatViewMessage } from './components/chat/ChatView';
import { Composer } from './components/composer/Composer';
import { DetailPanel } from './components/panels/DetailPanel';
import { GlobalModal } from './components/modals/GlobalModal';
import TerminalPanel from './components/terminal/TerminalPanel';
import SettingsView from './components/settings/SettingsView';
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

      // In 'plan' and 'ask' modes, the GlobalModal handles user interaction.
      // The store / modal will call approvePermission or denyPermission after
      // the user makes a choice. For now, we auto-deny after timeout.
      const timeout = setTimeout(() => {
        denyPermission(req.id).catch(() => {
          // Permission request may already be handled
        });
      }, 120_000); // 2 minute timeout

      // Store a cleanup ref so the modal can clear the timeout on user action
      const cleanup = () => clearTimeout(timeout);

      // The GlobalModal reads from its own internal queue or from a shared
      // store. For now, we broadcast via a custom event that the modal listens to.
      window.dispatchEvent(
        new CustomEvent('coderix:permission-request', {
          detail: { request: req, cleanup },
        }),
      );
    });

    return unsubscribe;
  }, []);

  // ── Load sessions on mount ──────────────────────────────────────────────
  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

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
  }, [createSession]);

  const handleOpenSettings = useCallback(() => {
    setSettingsOpen((prev) => !prev);
  }, []);

  const handleComposerSubmit = useCallback(
    async (value: string) => {
      if (!value.trim()) return;

      // Add the user message to the chat store (triggers streaming state)
      await sendMessage(value);

      // Submit the query via IPC to the main process
      const currentSid = useChatStore.getState().sessionId;
      if (currentSid) {
        try {
          await submitQuery(value, currentSid);
        } catch (err) {
          console.error('[App] Failed to submit query:', err);
          useChatStore.getState().setError(
            err instanceof Error ? err.message : 'Query submission failed',
          );
        }
      }
    },
    [sendMessage],
  );

  // ── Build chat messages for ChatView ────────────────────────────────────
  const chatViewMessages: ChatViewMessage[] = messages.map((msg) => ({
    id: msg.id,
    role: msg.role,
    blocks: msg.blocks,
    timestamp: msg.timestamp,
  }));

  // If there's a currently streaming message, append it
  if (streamCurrentMessage) {
    chatViewMessages.push({
      id: streamCurrentMessage.id,
      role: 'assistant',
      blocks: streamCurrentMessage.blocks,
      timestamp: Date.now(),
      isStreaming: true,
    });
  }

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
          <ChatView
            messages={chatViewMessages}
            isEmpty={isEmpty}
            isStreaming={isStreaming}
          />

          {/* Composer — fixed at bottom of chat */}
          <Composer
            onSubmit={handleComposerSubmit}
            disabled={isStreaming}
            model="DeepSeek V4 Pro"
          />

          {/* Terminal — collapsible */}
          <TerminalPanel isOpen={terminalOpen} onToggle={toggleTerminal} />
        </div>
      </AppLayout>

      {/* DEBUG: Direct settings toggle button — bypasses all component props */}
      <button
        onClick={() => { console.log('DEBUG settings button clicked'); setSettingsOpen(true); }}
        style={{
          position: 'fixed',
          bottom: '50px',
          right: '20px',
          zIndex: 2147483646,
          background: '#ff0000',
          color: '#ffffff',
          border: 'none',
          borderRadius: '50%',
          width: '50px',
          height: '50px',
          fontSize: '20px',
          fontWeight: 'bold',
          cursor: 'pointer',
          boxShadow: '0 4px 12px rgba(255,0,0,0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
        title="OPEN SETTINGS (DEBUG)"
      >
        ⚙
      </button>

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
            background: 'rgba(255,0,0,0.5)',
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
              boxShadow: '0 0 0 4px red, 0 8px 32px rgba(0,0,0,0.25)',
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
              background: '#ff0000',
              color: '#ffffff',
            }}>
              <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>
                SETTINGS DEBUG
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
                  background: '#ffffff',
                  color: '#ff0000',
                  cursor: 'pointer',
                  fontWeight: 'bold',
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
