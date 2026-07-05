import { h } from 'preact';
import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { ChatList } from './components/ChatList';
import { InputBox } from './components/InputBox';
import { StatusBar } from './components/StatusBar';
import { ToolApprovalCard } from './components/ToolApprovalCard';
import { SessionPicker } from './components/SessionPicker';
import { useVsCodeApi } from './hooks/useVsCodeApi';
import type { WebviewOutboundMessage, WebviewInboundMessage, UsageInfo, SessionSummary } from '../types/webviewProtocol';

export interface ChatMessage {
  id: string;
  role: 'assistant' | 'user' | 'system' | 'tool';
  text: string;
  isStreaming?: boolean;
}

export interface ToolState {
  toolId: string;
  name: string;
  status: 'running' | 'completed' | 'error';
  error?: string;
  resultText?: string;
}

export interface ApprovalState {
  requestId: string;
  command: string;
  description: string;
  pending: boolean;
}

export interface SubagentState {
  agentId: string;
  goal: string;
  status: 'running' | 'completed' | 'error' | 'interrupted';
  taskIndex?: number;
  taskCount?: number;
  currentTool?: string;
  filesRead?: string[];
  filesWritten?: string[];
  durationSeconds?: number;
  tokensUsed?: number;
  summary?: string;
}

let nextId = 1;

const COMMANDS = [
  { name: 'agent', help: 'view sub-agent transcript' },
  { name: 'clear', help: 'start a new conversation' },
  { name: 'commit', help: 'auto-generate commit message and commit staged changes' },
  { name: 'config', help: 'read or modify settings in ~/.coderix/settings.json' },
  { name: 'compact', help: 'compact the conversation context' },
  { name: 'doctor', help: 'diagnose your development environment' },
  { name: 'help', help: 'list available commands' },
  { name: 'init', help: 'initialize a CODER.md file in the project root' },
  { name: 'model', help: 'show or change the current model' },
  { name: 'pr', help: 'create a pull request for the current branch (uses gh CLI)' },
  { name: 'quit', help: 'exit the application' },
  { name: 'retry', help: 'retry the last user message' },
  { name: 'resume', help: 'list previous sessions or resume one by ID' },
  { name: 'review', help: 'review current branch changes' },
  { name: 'status', help: 'show session status' },
  { name: 'statusbar', help: 'toggle status bar' },
  { name: 'tasks', help: 'list all tasks or show task details' },
  { name: 'undo', help: 'undo the last exchange' },
  { name: 'verbose', help: 'cycle verbose tool output mode' },
];

export function App(): h.JSX.Element {
  const vscode = useVsCodeApi();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isBusy, setIsBusy] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const streamingRef = useRef('');
  const [statusText, setStatusText] = useState('Ready');
  const [tools, setTools] = useState<ToolState[]>([]);
  const [approval, setApproval] = useState<ApprovalState | null>(null);
  const [model, setModel] = useState('');
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const busyRef = useRef(false);
  const [connected, setConnected] = useState(false);
  const [sessionId, setSessionId] = useState('');
  const [sessionTitle, setSessionTitle] = useState('');
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [thinkingText, setThinkingText] = useState('');
  const thinkingRef = useRef('');
  const [subagents, setSubagents] = useState<Map<string, SubagentState>>(new Map());
  const [contextWindow, setContextWindow] = useState<number | undefined>();
  const [question, setQuestion] = useState<{ requestId: string; toolName: string; questions: Array<{ question: string; header: string; options: Array<{ label: string; description: string }> }> } | null>(null);
  const [permissionMode, setPermissionMode] = useState<'plan' | 'ask' | 'auto'>('ask');
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'disconnected'>('connected');
  const [reconnectMsg, setReconnectMsg] = useState('');

  // Notify extension that webview is ready
  useEffect(() => {
    vscode.postMessage({ type: 'webviewReady' } as WebviewInboundMessage);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Check connection timeout
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!connected) {
        setStatusText('Gateway starting...');
      }
    }, 10000);
    return () => clearTimeout(timer);
  }, [connected]);

  // Incoming messages from extension host
  useEffect(() => {
    const handler = (event: MessageEvent<WebviewOutboundMessage>): void => {
      const msg = event.data;
      setConnected(true);

      switch (msg.type) {
        case 'webviewReady':
          break;

        case 'messageDelta': {
          const updated = streamingRef.current + msg.text;
          streamingRef.current = updated;
          setStreamingText(updated);
          break;
        }

        case 'messageComplete': {
          const finalText = msg.text || streamingRef.current;
          if (finalText) {
            setMessages((prev) => [
              ...prev,
              { id: `msg-${nextId++}`, role: 'assistant', text: finalText },
            ]);
          }
          streamingRef.current = '';
          setStreamingText('');
          thinkingRef.current = '';
          setThinkingText('');
          if (msg.usage) setUsage(msg.usage);
          break;
        }

        case 'toolStart':
          setTools((prev) => [
            ...prev,
            { toolId: msg.toolId, name: msg.name, status: 'running' },
          ]);
          break;

        case 'toolComplete':
          setTools((prev) =>
            prev.map((t) =>
              t.toolId === msg.toolId
                ? { ...t, status: msg.error ? 'error' : 'completed', error: msg.error, resultText: msg.resultText }
                : t,
            ),
          );
          break;

        case 'approvalRequest':
          setApproval({
            requestId: msg.requestId,
            command: msg.command,
            description: msg.description,
            pending: true,
          });
          break;

        case 'statusUpdate': {
          const wasBusy = busyRef.current;
          const nowBusy = msg.status !== 'ready' && msg.status !== 'error';
          busyRef.current = nowBusy;
          setIsBusy(nowBusy);
          if (msg.message) setStatusText(msg.message);
          if (wasBusy && !nowBusy && msg.status === 'ready') {
            document.documentElement.classList.add('flash-done');
            setTimeout(() => document.documentElement.classList.remove('flash-done'), 1500);
          }
          break;
        }

        case 'errorMessage':
          setMessages((prev) => [
            ...prev,
            { id: `err-${nextId++}`, role: 'system', text: `Error: ${msg.message}` },
          ]);
          if (msg.message.includes('Engine init failed') || msg.message.includes('Gateway error')) {
            setConnectionStatus('disconnected');
            setReconnectMsg(msg.message);
          }
          break;

        case 'configUpdate':
          if (msg.config.model) setModel(msg.config.model);
          if (msg.config.permissionMode) setPermissionMode(msg.config.permissionMode);
          break;

        case 'themeChange':
          document.documentElement.setAttribute('data-theme', msg.kind);
          break;

        case 'sessionHistory':
          setMessages(
            msg.messages.map((m, i) => ({
              id: `hist-${i}`,
              role: m.role,
              text: m.text,
            })),
          );
          break;

        case 'sessionSwitched':
          setSessionId(msg.sessionId);
          setSessionTitle(msg.title);
          break;

        case 'sessionList':
          setSessions(msg.sessions);
          break;

        case 'thinkingDelta': {
          const tUpdated = thinkingRef.current + msg.text;
          thinkingRef.current = tUpdated;
          setThinkingText(tUpdated);
          break;
        }

        case 'subagentProgress':
          setSubagents((prev) => {
            const next = new Map(prev);
            next.set(msg.agentId, {
              agentId: msg.agentId,
              goal: msg.goal,
              status: msg.status,
              taskIndex: msg.taskIndex,
              taskCount: msg.taskCount,
              currentTool: msg.currentTool,
              filesRead: msg.filesRead,
              filesWritten: msg.filesWritten,
              durationSeconds: msg.durationSeconds,
              tokensUsed: msg.tokensUsed,
              summary: msg.summary,
            });
            return next;
          });
          break;

        case 'usageUpdate':
          if (msg.usage) setUsage(msg.usage);
          if (msg.contextWindow) setContextWindow(msg.contextWindow);
          break;

        case 'questionRequest':
          setQuestion({
            requestId: msg.requestId,
            toolName: msg.toolName,
            questions: msg.questions,
          });
          break;
      }
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  // Submit prompt to extension
  const handleSubmit = useCallback(
    (text: string) => {
      setMessages((prev) => [
        ...prev,
        { id: `msg-${nextId++}`, role: 'user', text },
      ]);
      streamingRef.current = '';
      setStreamingText('');
      thinkingRef.current = '';
      setThinkingText('');
      setTools([]);
      setSubagents(new Map());
      setApproval(null);
      setQuestion(null);
      vscode.postMessage({ type: 'submitPrompt', text } as WebviewInboundMessage);
    },
    [vscode],
  );

  // Request session list
  const handleListSessions = useCallback(() => {
    vscode.postMessage({ type: 'listSessions' } as WebviewInboundMessage);
  }, [vscode]);

  // Session picker
  const handleOpenPicker = useCallback(() => {
    setPickerOpen(true);
    vscode.postMessage({ type: 'listSessions' } as WebviewInboundMessage);
  }, [vscode]);

  const handleSelectSession = useCallback(
    (id: string) => {
      vscode.postMessage({ type: 'selectSession', sessionId: id } as WebviewInboundMessage);
    },
    [vscode],
  );

  // Permission mode cycle
  const handleModeToggle = useCallback(() => {
    const modes: Array<'plan' | 'ask' | 'auto'> = ['plan', 'ask', 'auto'];
    const next = modes[(modes.indexOf(permissionMode) + 1) % modes.length];
    setPermissionMode(next);
    vscode.postMessage({ type: 'setPermissionMode', mode: next } as WebviewInboundMessage);
  }, [vscode, permissionMode]);

  // Question answer
  const handleQuestionAnswer = useCallback(
    (answers: Record<string, string>) => {
      if (!question) return;
      vscode.postMessage({
        type: 'questionAnswer',
        requestId: question.requestId,
        answers,
      } as WebviewInboundMessage);
      setQuestion(null);
    },
    [vscode, question],
  );

  // Approval response
  const handleApproval = useCallback(
    (allowed: boolean) => {
      if (!approval) return;
      vscode.postMessage({
        type: 'approvalRespond',
        requestId: approval.requestId,
        allowed,
      } as WebviewInboundMessage);
      setApproval((prev) => (prev ? { ...prev, pending: false } : null));
    },
    [vscode, approval],
  );

  return (
    <div class="coder-app">
      {connectionStatus === 'disconnected' && (
        <div class="connection-banner connection-banner--disconnected">
          <span>{reconnectMsg || 'Connection lost'}</span>
          <button
            class="connection-retry-btn"
            onClick={() => { setConnectionStatus('connected'); vscode.postMessage({ type: 'newSession' } as WebviewInboundMessage); }}
          >
            Retry
          </button>
        </div>
      )}
      <ChatList
        messages={messages}
        streamingText={streamingText}
        thinkingText={thinkingText}
        tools={tools}
        subagents={subagents}
        onFileClick={(path) => vscode.postMessage({ type: 'openFile', path } as WebviewInboundMessage)}
      />
      {approval?.pending && (
        <ToolApprovalCard
          command={approval.command}
          description={approval.description}
          onApprove={() => handleApproval(true)}
          onDeny={() => handleApproval(false)}
        />
      )}
      {question && (
        <div class="approval-card">
          <div class="approval-header">
            <span class="approval-title">{question.toolName}</span>
          </div>
          <div class="approval-body">
            {question.questions.map((q, qi) => (
              <div key={qi} class="question-group">
                <div class="question-text">{q.question}</div>
                <div class="question-options">
                  {q.options.map((opt, oi) => (
                    <button
                      key={oi}
                      class="approval-approve"
                      onClick={() => handleQuestionAnswer({ [q.header]: opt.label })}
                    >
                      {opt.label}: {opt.description}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      <StatusBar
        status={statusText}
        model={model}
        usage={usage}
        contextWindow={contextWindow}
        isBusy={isBusy}
        sessionId={sessionId}
        sessionTitle={sessionTitle}
        permissionMode={permissionMode}
        onNewSession={() => vscode.postMessage({ type: 'newSession' } as WebviewInboundMessage)}
        onSessionClick={handleOpenPicker}
        onPermissionModeToggle={handleModeToggle}
      />
      <SessionPicker
        sessions={sessions}
        currentSessionId={sessionId}
        onSelect={handleSelectSession}
        onRefresh={() => vscode.postMessage({ type: 'listSessions' } as WebviewInboundMessage)}
        isOpen={pickerOpen}
        onClose={() => setPickerOpen(false)}
      />
      <InputBox
        onSubmit={handleSubmit}
        onInterrupt={() => vscode.postMessage({ type: 'interrupt' } as WebviewInboundMessage)}
        isBusy={isBusy}
        commands={COMMANDS}
      />
    </div>
  );
}
