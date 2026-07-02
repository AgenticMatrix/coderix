import { useEffect, useState, useCallback } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { useAgentBridge } from './hooks/useAgentBridge';
import { useChatStore } from './stores/chatStore';
import { ChatView } from './components/chat/ChatView';
import { StatusBar } from './components/chat/StatusBar';
import { ApprovalPrompt } from './components/chat/ApprovalPrompt';
import { QuestionPrompt } from './components/chat/QuestionPrompt';

export function App() {
  const { onEvent, sendRpc } = useWebSocket();
  const connectionStatus = useChatStore((s) => s.connectionStatus);
  const sessionId = useChatStore((s) => s.sessionId);
  const [sessions, setSessions] = useState<Array<{ id: string; title: string; turnCount: number; model: string }>>([]);

  const {
    runAgentTurn,
    approvePermission,
    answerQuestion,
    interruptAgent,
    createSession,
    listSessions,
    resumeSession,
  } = useAgentBridge(onEvent, sendRpc);

  // Expose bridge globally
  useEffect(() => {
    (window as any).__agentBridge = {
      runAgentTurn, approvePermission, answerQuestion,
      interruptAgent, createSession, listSessions, resumeSession,
    };
  }, [runAgentTurn, approvePermission, answerQuestion, interruptAgent, createSession, listSessions, resumeSession]);

  // Load sessions on connect
  useEffect(() => {
    if (connectionStatus === 'connected') {
      listSessions().then(setSessions).catch(() => {});
    }
  }, [connectionStatus, listSessions]);

  const handleNewSession = useCallback(async () => {
    try {
      const s = await createSession();
      setSessions(prev => [{ id: s.sessionId, title: s.title, turnCount: 0, model: '' }, ...prev]);
    } catch {}
  }, [createSession]);

  const handleSelectSession = useCallback(async (id: string) => {
    await resumeSession(id);
    listSessions().then(setSessions).catch(() => {});
  }, [resumeSession, listSessions]);

  return (
    <div className="app-container">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-logo">
            <span>◈</span> Coderix
          </div>
          <button className="sidebar-new-btn" onClick={handleNewSession} title="New Session">+</button>
        </div>
        <div className="sidebar-sessions">
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`session-item ${s.id === sessionId ? 'active' : ''}`}
              onClick={() => handleSelectSession(s.id)}
            >
              <div className="session-item-icon" />
              <div className="session-item-info">
                <div className="session-item-title">{s.title}</div>
                <div className="session-item-meta">{s.turnCount} turns</div>
              </div>
            </div>
          ))}
        </div>
        <div className="sidebar-footer">
          <div className="sidebar-user">C</div>
          <div className="sidebar-model">Coderix Desktop</div>
        </div>
      </aside>

      {/* Main */}
      <main className="main-content">
        {/* Top bar */}
        <div className="topbar">
          <div className="topbar-title">Chat</div>
          <div className="topbar-spacer" />
          <div className="topbar-badge">
            {connectionStatus === 'connected' ? 'Connected' : connectionStatus}
          </div>
        </div>

        {/* Chat */}
        <ChatView
          onSendMessage={runAgentTurn}
          onInterrupt={interruptAgent}
        />

        {/* Loading overlay */}
        {(connectionStatus === 'connecting') && (
          <div className="app-overlay">
            <div className="app-overlay-content">
              <div className="spinner" />
              <span>Connecting to Coderix...</span>
            </div>
          </div>
        )}

        <StatusBar />
      </main>

      {/* Dialogs */}
      <ApprovalPrompt
        onApprove={(rid) => approvePermission(rid, true)}
        onDeny={(rid) => approvePermission(rid, false)}
      />
      <QuestionPrompt
        onSubmit={(rid, answers) => answerQuestion(rid, answers)}
      />
    </div>
  );
}

export function getAgentBridge() {
  return (window as any).__agentBridge as ReturnType<typeof useAgentBridge> | undefined;
}
