import { useEffect } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { useAgentBridge } from './hooks/useAgentBridge';
import { useChatStore } from './stores/chatStore';
import { ChatView } from './components/chat/ChatView';
import { StatusBar } from './components/chat/StatusBar';
import { ApprovalPrompt } from './components/chat/ApprovalPrompt';
import { QuestionPrompt } from './components/chat/QuestionPrompt';

export function App() {
  const { onEvent, sendRpc, isConnected } = useWebSocket();
  const connectionStatus = useChatStore((s) => s.connectionStatus);

  const {
    runAgentTurn,
    approvePermission,
    answerQuestion,
    interruptAgent,
    createSession,
    listSessions,
    resumeSession,
    deleteSession,
    renameSession,
  } = useAgentBridge(onEvent, sendRpc);

  // Expose bridge methods globally so child components can access them
  useEffect(() => {
    (window as any).__agentBridge = {
      runAgentTurn,
      approvePermission,
      answerQuestion,
      interruptAgent,
      createSession,
      listSessions,
      resumeSession,
      deleteSession,
      renameSession,
    };
  }, [
    runAgentTurn,
    approvePermission,
    answerQuestion,
    interruptAgent,
    createSession,
    listSessions,
    resumeSession,
    deleteSession,
    renameSession,
  ]);

  return (
    <div className="app-container">
      <div className="app-main">
        <ChatView
          onSendMessage={runAgentTurn}
          onInterrupt={interruptAgent}
        />
        {connectionStatus === 'connecting' && (
          <div className="app-overlay">
            <div className="app-overlay-content">
              <div className="spinner" />
              <span>Connecting to Coderix backend...</span>
            </div>
          </div>
        )}
        {connectionStatus === 'reconnecting' && (
          <div className="app-overlay app-overlay-warning">
            <div className="app-overlay-content">
              <div className="spinner" />
              <span>Reconnecting...</span>
            </div>
          </div>
        )}
      </div>
      <StatusBar />
      <ApprovalPrompt
        onApprove={(requestId) => approvePermission(requestId, true)}
        onDeny={(requestId) => approvePermission(requestId, false)}
      />
      <QuestionPrompt
        onSubmit={(requestId, answers) => answerQuestion(requestId, answers)}
      />
    </div>
  );
}

// ── Helper: get bridge from window ──

export function getAgentBridge() {
  return (window as any).__agentBridge as ReturnType<typeof useAgentBridge> | undefined;
}
