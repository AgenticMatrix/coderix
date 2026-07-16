import { useEffect, useRef, useMemo, useCallback, useState } from 'react';
import { Box, Text, ScrollBox, Divider } from '@coderix/ink';
import type { ScrollBoxHandle } from '@coderix/ink';
import { useTerminalSize } from '@coderix/ink';

import type { QueryEngine } from '@coderix/core';
import type { AppConfig, Message, ContentBlock, ThinkingBlock } from '../../types.js';
import { PermissionMode, getSubAgentRegistry } from '@coderix/core';
import type { SubAgentRecord } from '@coderix/core';
import { HeaderLogo } from './HeaderLogo.js';
import { MessageBubble } from './MessageBubble.js';
import { ThinkingBlockRenderer, ActivityLine, type ActivityPhase } from './ThinkingBlockRenderer.js';
import { InputBox } from './InputBox.js';
import { StatusBar } from './StatusBar.js';
import { ApprovalPrompt } from './ApprovalPrompt.js';
import { QuestionPrompt } from './QuestionPrompt.js';
import { SubAgentPicker } from './SubAgentPicker.js';
import { SessionPicker } from './SessionPicker.js';
import { TaskPanel } from './TaskPanel.js';
import { TodoPanel } from './TodoPanel.js';
import { TeamPanel } from './TeamPanel.js';
import { MemoryPicker } from './MemoryPicker.js';
import { OffscreenFreeze } from './OffscreenFreeze.js';
import { CommandHint } from './CommandHint.js';
import { VirtualMessageList } from './VirtualMessageList.js';
import { useChatReducer, convertTranscriptToMessages } from '../hooks/useChatReducer.js';;
import { useAgentBridge } from '../hooks/useAgentBridge.js';;
import { useSubAgentBridge } from '../hooks/useSubAgentBridge.js';;
import { useInputHandler } from '../hooks/useInputHandler.js';;
import { useTokenStats } from '../hooks/useTokenStats.js';;
import { useProcessStats } from '../hooks/useProcessStats.js';
import { createSlashHandler } from '../../commands/index.js';
import { loadHistory } from '../../cli/history.js';
import { useAppState, useSetAppState } from '../../state/AppStateContext.js';;
import type { Store, SessionManager } from '@coderix/core';
import type { AppState } from '../../state/AppState.js';

interface AppProps {
  config: AppConfig;
  engine: QueryEngine;
  store: Store<AppState>;
  sessionManager: SessionManager;
  /** Pre-loaded messages from a resumed session (--resume / --continue). */
  initialMessages?: Message[] | null;
  /** When true, show the session picker on mount (--resume with no value). */
  showSessionPicker?: boolean;
  /** Called when the user exits (double Ctrl+C). Uses Ink unmount for clean teardown. */
  onExit?: () => void;
}

/** Find the most recent thinking block across all messages. */
function findLatestThinking(messages: Message[]): { block: ThinkingBlock; duration?: number; tokens?: number } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'assistant') {
      const thinkingBlock = msg.blocks.find((b): b is ThinkingBlock => b.type === 'thinking');
      if (thinkingBlock) {
        return { block: thinkingBlock, duration: msg.thinkingDuration, tokens: msg.thinkingTokens ?? Math.round(thinkingBlock.content.length / 4) };
      }
    }
  }
  return null;
}

export function App({ config, engine, store, sessionManager, initialMessages, showSessionPicker, onExit: onExitProp }: AppProps) {
  const [state, dispatch] = useChatReducer(config.model, config.inputPrice, config.outputPrice, config.cacheReadPrice);

  const setAppState = useSetAppState();

  // Clean exit: prefer parent-provided unmount (Ink restores terminal),
  // fall back to raw process.exit.
  const handleExit = useCallback(() => {
    if (onExitProp) {
      onExitProp();
    } else {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.exit(0);
    }
  }, [onExitProp]);

  // ── Terminal size & layout measurement ──────────────────────
  const { rows: termRows, columns: termCols } = useTerminalSize();
  const rows = termRows ?? process.stdout.rows ?? 24;
  const columns = termCols ?? process.stdout.columns ?? 80;

  // Sync ChatState → AppState.ui so components reading via useAppState see the latest
  useEffect(() => {
    store.setState(state);
  }, [state]);

  // ── Resume: load pre-loaded session messages on mount ──────────
  const hasLoadedInitialRef = useRef(false);
  useEffect(() => {
    if (initialMessages && initialMessages.length > 0 && !hasLoadedInitialRef.current) {
      hasLoadedInitialRef.current = true;
      dispatch({ type: 'LOAD_CHAT', messages: initialMessages, turns: [], isStreaming: false });
    }
  }, [initialMessages]);

  // ── Resume: show session picker on mount (--resume with no value)
  useEffect(() => {
    if (showSessionPicker) {
      dispatch({ type: 'SHOW_SESSION_PICKER' });
    }
  }, [showSessionPicker]);

  // Sync briefMode → QueryEngine (rebuilds system prompt on toggle)
  useEffect(() => {
    engine.setBriefMode(state.briefMode);
  }, [state.briefMode, engine]);

  // ── Agent state via manual subscription (avoids full App re-render) ──
  // useAppState(s => s.agents) would cause the entire App to re-render on
  // every agent_update event (1-5/sec during sub-agent execution), which
  // cascades through expensive useMemo/useEffect blocks and makes the TUI
  // unresponsive during sub-agent activity.
  //
  // Instead, we subscribe directly to the store and keep agent state in a
  // ref. Token deltas dispatch UPDATE_TOKEN_USAGE without triggering React
  // re-renders. Only meaningful status transitions (start/stop) cause a
  // lightweight re-render via agentTick.
  const agentsRef = useRef<Record<string, SubAgentRecord>>({});
  const [agentTick, setAgentTick] = useState(0);
  const subAgentViewIdRef = useRef(state.subAgentView?.agentId ?? null);
  subAgentViewIdRef.current = state.subAgentView?.agentId ?? null;
  const prevAgentStatusesRef = useRef<Record<string, string>>({});
  const agentTokensRef = useRef<Record<string, { input: number; output: number; cacheCreation: number; cacheRead: number }>>({});

  useEffect(() => {
    const unsub = store.subscribe(() => {
      const next = store.getState().agents;
      const prev = agentsRef.current;

      // Detect status transitions for cache eviction and tick updates
      let needsTick = false;
      for (const [id, agent] of Object.entries(next)) {
        const prevStatus = prevAgentStatusesRef.current[id];
        const curStatus = agent.status;
        if (prevStatus === 'running' && curStatus !== 'running') {
          if (subAgentViewIdRef.current !== id) {
            dispatch({ type: 'EVICT_AGENT_CACHE', agentId: id });
          }
          needsTick = true;
        } else if (prevStatus !== 'running' && curStatus === 'running') {
          needsTick = true;
        }
        prevAgentStatusesRef.current[id] = curStatus;
      }
      // Clean up stale entries from prevAgentStatusesRef
      for (const id of Object.keys(prevAgentStatusesRef.current)) {
        if (!next[id]) delete prevAgentStatusesRef.current[id];
      }

      // Token delta tracking — dispatch only the incremental cost
      for (const [id, agent] of Object.entries(next)) {
        if (agent.status !== 'running') continue;
        const tu = agent.tokenUsage;
        if (!tu) continue;
        const prevTokens = agentTokensRef.current[id] || { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
        const curr = {
          input: tu.inputTokens,
          output: tu.outputTokens,
          cacheCreation: tu.cacheCreationInputTokens ?? 0,
          cacheRead: tu.cacheReadInputTokens ?? 0,
        };
        const deltaInput = curr.input - prevTokens.input;
        const deltaOutput = curr.output - prevTokens.output;
        const deltaCacheCreation = curr.cacheCreation - prevTokens.cacheCreation;
        const deltaCacheRead = curr.cacheRead - prevTokens.cacheRead;
        if (deltaInput > 0 || deltaOutput > 0 || deltaCacheCreation > 0 || deltaCacheRead > 0) {
          dispatch({
            type: 'UPDATE_TOKEN_USAGE',
            usage: { inputTokens: deltaInput, outputTokens: deltaOutput, cacheCreationInputTokens: deltaCacheCreation, cacheReadInputTokens: deltaCacheRead },
          });
        }
        agentTokensRef.current[id] = curr;
      }

      agentsRef.current = next;
      if (needsTick) setAgentTick(t => t + 1);
    });

    return unsub;
  }, [store, dispatch]);

  const messagesRef = useRef(state.messages);
  const currentSessionRef = useRef<string>('');
  messagesRef.current = state.messages;

  // Ref so useAgentBridge can route dispatches to savedMainMessages
  // when the user is viewing a sub-agent, keeping the main agent's work
  // intact while the sub-agent view remains uncontaminated.
  const subAgentViewRef = useRef(state.subAgentView);
  subAgentViewRef.current = state.subAgentView;

  const { runAgentTurn } = useAgentBridge({ engine, dispatch, setAppState, subAgentViewRef });
  const { sendToSubAgent } = useSubAgentBridge({ engine, dispatch, setAppState });

  // Load sub-agent transcript when entering immersive mode.
  // Polls every 400ms while the agent is running, progressively loading
  // new messages as the transcript grows in the registry.
  useEffect(() => {
    if (!state.subAgentView) return;
    const agentId = state.subAgentView.agentId;
    const initialCount = state.subAgentMessageCache[agentId]?.length ?? 0;
    let lastCount = initialCount;
    let missingCount = 0;
    let interval: ReturnType<typeof setInterval> | null = null;

    const pollTranscript = () => {
      const registry = getSubAgentRegistry();
      if (!registry) return;
      const agent = registry.get(agentId);
      if (!agent) {
        // Agent not in registry yet — keep polling up to 30s
        missingCount++;
        if (missingCount > 75) {
          clearInterval(interval!);
        }
        return;
      }

      const transcriptLen = agent.transcript?.length ?? 0;
      if (transcriptLen > lastCount) {
        lastCount = transcriptLen;
        const messages = convertTranscriptToMessages(agent.transcript!);
        dispatch({ type: 'LOAD_SUBAGENT_TRANSCRIPT', agentId, messages });
      }

      // Stop polling once the agent is done and we've loaded all messages
      if (agent.status !== 'running' && lastCount > 0) {
        clearInterval(interval!);
      }
    };

    pollTranscript();
    interval = setInterval(pollTranscript, 400);
    return () => { if (interval) clearInterval(interval); };
  }, [state.subAgentView?.agentId]);

  const handleTaskDismissReset = useCallback(() => dispatch({ type: 'TOGGLE_TASK_PANEL' }), [dispatch]);
  const handleTodoDismissReset = useCallback(() => dispatch({ type: 'TOGGLE_TODO_PANEL' }), [dispatch]);
  const handleTeamDismissReset = useCallback(() => dispatch({ type: 'TOGGLE_TEAM_PANEL' }), [dispatch]);

  // Load history on mount
  useEffect(() => {
    dispatch({ type: 'LOAD_HISTORY', history: loadHistory() });
  }, [dispatch]);

  // ── Status bar phase ──────────────────────────────────────────
  // busy: main agent is active (streaming / thinking / sync tool execution)
  // wait: sub-agents or background tools are running
  // idle: nothing active
  const statusPhase = useMemo<'busy' | 'wait' | 'idle'>(() => {
    if (state.error) return 'idle';
    // Busy: ONLY when main agent API is actively streaming.
    // Use mainStreaming when in sub-agent view (isStreaming conflates both agents).
    const mainActive = state.subAgentView ? state.mainStreaming : state.isStreaming;
    if (mainActive) return 'busy';
    // Wait: check MAIN agent's messages for pending tools
    // Use savedMainMessages when in sub-agent view since state.messages is the sub-agent's
    const mainMessages = state.subAgentView
      ? (state.savedMainMessages ?? [])
      : state.messages;
    const lastMsg = mainMessages[mainMessages.length - 1];
    const hasActiveTools =
      lastMsg?.blocks.some(
        (b) => b.type === 'tool_use' && (b.state === 'pending' || b.state === 'executing'),
      ) ?? false;
    if (hasActiveTools) return 'wait';
    // Wait: sub-agents running
    for (const agent of Object.values(agentsRef.current)) {
      if (agent.status === 'running') return 'wait';
    }
    return 'idle';
  }, [state.error, state.isStreaming, state.mainStreaming, state.subAgentView, state.messages, state.savedMainMessages, agentTick]);

  useInputHandler({
    inputText: state.inputText,
    cursorPosition: state.cursorPosition,
    statusPhase,
    messages: state.messages,
    dispatch,
    onSend: runAgentTurn,
    onInterrupt: () => engine.interrupt(),
    onKillAll: () => {
      engine.interrupt();
      getSubAgentRegistry()?.abortAll();
    },
    onExit: handleExit,
    blocked: state.approvalReq !== null || state.questionReq !== null || state.agentPicker || state.sessionPicker,
    teamPicker: state.teamPicker,
    agentCount: Object.keys(agentsRef.current).length,
    subAgentView: state.subAgentView,
    lastAgentViewId: state.lastAgentViewId,
    commandPickerIndex: state.commandPickerIndex,
    history: state.history,
    historyIndex: state.historyIndex,
    historyScratch: state.historyScratch,
    pasteBlocks: state.pasteBlocks,
    onSubAgentSend: sendToSubAgent,
    onSlashCommand: createSlashHandler({
      dispatch,
      send: runAgentTurn,
      model: config.model,
      isStreaming: state.isStreaming,
      inputText: state.inputText,
      onExit: handleExit,
      listSessions: () =>
        sessionManager.list().map((s) => ({
          id: s.id,
          title: s.title,
          turnCount: s.turnCount,
          model: s.model,
          updatedAt: s.updatedAt,
        })),
      resumeSession: (id: string) => {
        // __last__: find most recent non-empty session, skipping current
        if (id === '__last__') {
          const list = sessionManager.list();
          const target = list.find(
            (s) => s.turnCount > 0 && s.id !== currentSessionRef.current,
          );
          if (!target) {
            dispatch({
              type: 'ADD_USER_MESSAGE',
              message: {
                id: Date.now(),
                role: 'system',
                content: 'No other sessions with content found.',
                blocks: [{ type: 'text' as const, content: 'No other sessions with content found.' }],
                timestamp: Date.now(),
              },
            });
            return;
          }
          id = target.id;
        }
        // Skip if already viewing this session
        if (id === currentSessionRef.current) {
          dispatch({
            type: 'ADD_USER_MESSAGE',
            message: {
              id: Date.now(),
              role: 'system',
              content: 'Already viewing this session.',
              blocks: [{ type: 'text' as const, content: 'Already viewing this session.' }],
              timestamp: Date.now(),
            },
          });
          return;
        }
        currentSessionRef.current = id;
        let session;
        try {
          session = sessionManager.resume(id);
        } catch (e) {
          dispatch({
            type: 'ADD_USER_MESSAGE',
            message: {
              id: Date.now(),
              role: 'system',
              content: `Failed to resume session: ${(e as Error).message}`,
              blocks: [{ type: 'text' as const, content: `Failed to resume session: ${(e as Error).message}` }],
              timestamp: Date.now(),
            },
          });
          return;
        }
        if (!session) return;
        const base = Date.now();
        const msgs: Message[] = [];
        for (let i = 0; i < session.messages.length; i++) {
          const raw: any = session.messages[i];
          // Build visible text content even for non-text messages
          let content: string;
          let blocks: ContentBlock[];
          if (typeof raw.content === 'string') {
            content = raw.content;
            blocks = [{ type: 'text' as const, content }];
          } else if (Array.isArray(raw.content)) {
            const textBlocks = raw.content.filter((b: any) => b.type === 'text');
            content = textBlocks.map((b: any) => b.text ?? '').join('\n');
            // If no text blocks, show a summary of block types
            if (!content) {
              const types = raw.content.map((b: any) => b.type).join(', ');
              content = `[${types}]`;
            }
            blocks = raw.content as ContentBlock[];
          } else {
            content = '(empty)';
            blocks = [{ type: 'text' as const, content }];
          }
          msgs.push({
            id: base * 1000 + i,
            role: raw.role,
            content,
            blocks,
            timestamp: base + i,
          });
        }
        msgs.push({
          id: base * 1000 + msgs.length,
          role: 'system' as const,
          content: msgs.length === 0
            ? `Resumed empty session: ${session.title}`
            : `Resumed session: ${session.title}`,
          blocks: [{
            type: 'text' as const,
            content: msgs.length === 0
              ? `Resumed empty session: ${session.title}`
              : `Resumed session: ${session.title}`,
          }],
          timestamp: base + msgs.length,
        });
        dispatch({ type: 'LOAD_CHAT', messages: msgs, turns: [], isStreaming: false });
      },
    }),
  });

  const pendingApproval = useAppState(s => s.pendingApproval);

  const handleApprovalChoice = (choice: string) => {
    const pending = pendingApproval;
    if (!pending) return;

    if (choice === 'deny') {
      pending.deferred.resolve(false);
      engine.interrupt();
      dispatch({ type: 'INTERRUPT' });
    } else {
      pending.deferred.resolve(true);
      if (choice === 'session' || choice === 'always') {
        engine.setPermissionMode(PermissionMode.AUTO);
        dispatch({ type: 'SET_MODE', mode: 'auto' });
      }
    }
  };

  const pendingQuestion = useAppState(s => s.pendingQuestion);

  const handleQuestionAnswer = (answers: Record<string, string | string[]>) => {
    const pending = pendingQuestion;
    if (!pending) return;
    pending.deferred.resolve(answers);
  };

  const stats = useTokenStats(state.messages, state.tokenUsage, state.accumulatedCost);

  // OS-level process tree stats (main + sub-agents + tool subprocesses)
  const { memory: processMemory, osProcessCount } = useProcessStats();

  // Count running sub-agents (in-process, not visible to ps)
  const runningAgentCount = useMemo(() => {
    let count = 0;
    for (const agent of Object.values(agentsRef.current)) {
      if (agent.status === 'running') count++;
    }
    return count;
  }, [agentTick]);

  // Total: main process + OS child processes + in-process sub-agents
  const totalProcs = 1 + osProcessCount + runningAgentCount;

  const messages = state.messages;

  // When display is frozen (user scrolled up), keep showing the snapshot.
  // The reducer continues updating state.messages in the background.
  const frozenRef = useRef(state.messages);
  if (!state.isFrozen) frozenRef.current = state.messages;
  const displayMessages = state.isFrozen ? frozenRef.current : state.messages;

  // ── Turn-level phase detection ────────────────────────────────
  // thinking: latest thinking block is still in progress (no duration)
  // executing: last message has active tools or running sub-agents
  // streaming: assistant text is arriving
  // idle: no activity
  const latestThinking = useMemo(() => findLatestThinking(displayMessages), [displayMessages]);

  const currentPhase = useMemo<ActivityPhase>(() => {
    if (state.error) return 'idle';
    if (latestThinking && latestThinking.duration == null) return 'thinking';
    const lastMsg = state.messages[state.messages.length - 1];
    const hasActive =
      lastMsg?.blocks.some(
        (b) => b.type === 'tool_use' && (b.state === 'pending' || b.state === 'executing'),
      ) ?? false;
    if (hasActive) return 'executing';
    for (const agent of Object.values(agentsRef.current)) {
      if (agent.status === 'running') return 'executing';
    }
    if (state.isStreaming) return 'streaming';
    return 'idle';
  }, [state.error, latestThinking, state.messages, state.isStreaming, agentTick]);

  // Turn elapsed timer — starts on new user message, runs continuously until next user message
  const userMsgCount = useMemo(
    () => state.messages.filter((m) => m.role === 'user').length,
    [state.messages],
  );
  const prevUserMsgCountRef = useRef(userMsgCount);
  const turnStartRef = useRef<number>(Date.now());
  const [turnElapsed, setTurnElapsed] = useState(0);
  const turnElapsedRef = useRef(0);
  const [completedTurn, setCompletedTurn] = useState<{
    elapsed: number;
    tokens: number;
  } | null>(null);

  // Reset timer only when a new user message arrives (new turn)
  if (userMsgCount !== prevUserMsgCountRef.current) {
    prevUserMsgCountRef.current = userMsgCount;
    turnStartRef.current = Date.now();
    turnElapsedRef.current = 0;
    setTurnElapsed(0);
    setCompletedTurn(null);
  }

  // Show "Done" line when idle, clear it when activity resumes
  useEffect(() => {
    if (currentPhase === 'idle') {
      if (turnElapsedRef.current > 0) {
        setCompletedTurn({
          elapsed: turnElapsedRef.current,
          tokens: state.turnOutputTokens,
        });
      }
    } else {
      setCompletedTurn(null);
    }
  }, [currentPhase === 'idle', state.turnOutputTokens]);

  // Elapsed timer runs continuously from turn start
  useEffect(() => {
    const id = setInterval(() => {
      const elapsed = Date.now() - turnStartRef.current;
      turnElapsedRef.current = elapsed;
      setTurnElapsed(elapsed);
    }, 100);
    return () => clearInterval(id);
  }, []);

  // Count new messages arrived while frozen
  const frozenNewCount = state.isFrozen && state.isStreaming
    ? state.messages.length - frozenRef.current.length
    : 0;

  // ── ScrollBox ref for virtual scrolling ─────────────────────────
  const scrollRef = useRef<ScrollBoxHandle | null>(null);

  // Track the last assistant message ID during streaming for
  // LRU-cached markdown rendering.
  const streamingMsgIdRef = useRef<number | null>(null);
  if (state.isStreaming) {
    const lastMsg = state.messages[state.messages.length - 1];
    streamingMsgIdRef.current = lastMsg?.role === 'assistant' ? lastMsg.id : null;
  } else {
    streamingMsgIdRef.current = null;
  }

  // ── Message renderer for VirtualMessageList ─────────────────────
  const renderMessage = useCallback(
    (msg: Message, _idx: number) => (
      <MessageBubble
        key={msg.id}
        message={msg}
        contentExpanded={state.contentExpanded}
        theme={config.theme}
        hideThinking
        streaming={state.isStreaming && msg.id === streamingMsgIdRef.current}
      />
    ),
    [state.contentExpanded, config.theme, state.isStreaming],
  );

  return (
    <Box flexDirection="column" height="100%" padding={1}>
      {/* ── Header ─────────────────────────────────────────────── */}
      <HeaderLogo key="header" />

      {/* ── Scrollable message area with virtual scrolling ─────── */}
      <ScrollBox
        ref={scrollRef}
        flexGrow={1}
        flexShrink={1}
        stickyScroll
        paddingX={1}
      >
        {/* ── Freeze indicator ───────────────────────────────── */}
        {state.isFrozen && (
          <Box flexShrink={0} height={1} flexDirection="row">
            <Box width={2} flexShrink={0} />
            <Box flexGrow={1}>
              <Text color="ansi:yellow" dimColor>
                ⏸ Paused — {frozenNewCount > 0 ? `${frozenNewCount} new message(s) — ` : ''}PageDown / End to follow
              </Text>
            </Box>
          </Box>
        )}
        {!state.isFrozen && <Box flexShrink={0} height={0} />}

        {/* ── Sub-agent indicator header ──────────────────────── */}
        {state.subAgentView && (
          <Box flexShrink={0} marginBottom={1} flexDirection="row">
            <Box width={2} flexShrink={0} />
            <Box flexDirection="column" flexGrow={1}>
              <Text dimColor>--- {state.subAgentView.agentId} ---</Text>
              <Text dimColor> Esc or Ctrl+T to return to main</Text>
            </Box>
          </Box>
        )}

        {/* ── Empty state ─────────────────────────────────────── */}
        {displayMessages.length === 0 && !state.isStreaming && (
          <Box marginY={1} flexDirection="row">
            <Box width={2} flexShrink={0} />
            <Box flexGrow={1}>
              <Text dimColor>
                {state.subAgentView
                  ? 'Send a message to continue the conversation with this agent.'
                  : 'Welcome to Coder Chat TUI! Type a message and press Enter to start.'}
              </Text>
            </Box>
          </Box>
        )}

        {/* ── Virtual-scrolled message list ───────────────────── */}
        {displayMessages.length > 0 && (
          <VirtualMessageList
            messages={displayMessages}
            scrollRef={scrollRef}
            columns={columns}
            renderMessage={renderMessage}
          />
        )}

        {/* ── Ask / Task panels (above activity line) ──────── */}
        {state.questionReq && (
          <Box flexDirection="column" flexShrink={0} paddingX={1} paddingY={1}>
            <QuestionPrompt
              questions={state.questionReq.questions}
              onAnswer={handleQuestionAnswer}
            />
          </Box>
        )}

        {state.approvalReq && (
          <Box flexDirection="column" flexShrink={0} paddingX={1} paddingY={1}>
            <ApprovalPrompt
              req={state.approvalReq}
              onChoice={handleApprovalChoice}
            />
          </Box>
        )}

        {/* ── Activity & thinking (during streaming/execution) ── */}
        <OffscreenFreeze frozen={state.isFrozen}>
          {latestThinking && !state.isFrozen && (
            <ThinkingBlockRenderer
              content={latestThinking.block.content}
              thinkingExpanded={latestThinking.block.expanded}
              thinkingDuration={latestThinking.duration}
              thinkingTokens={latestThinking.tokens}
            />
          )}
          {!state.isFrozen && (
            <ActivityLine
              phase={currentPhase}
              turnElapsed={turnElapsed}
              turnOutputTokens={state.turnOutputTokens}
              completed={completedTurn}
            />
          )}
        </OffscreenFreeze>

        <TaskPanel
          dismissed={state.taskPanelDismissed}
          onDismissReset={handleTaskDismissReset}
        />

        <TodoPanel
          dismissed={state.todoPanelDismissed}
          onDismissReset={handleTodoDismissReset}
        />

        {/* ── Picker modals ─────────────── */}
        {state.agentPicker && (
          <Box flexDirection="column" flexShrink={0} paddingX={1} paddingY={1}>
            <SubAgentPicker
              onSelect={(agentId) => {
                dispatch({ type: 'HIDE_AGENT_PICKER' });
                dispatch({ type: 'OPEN_SUBAGENT_VIEW', agentId });
              }}
              onCancel={() => dispatch({ type: 'HIDE_AGENT_PICKER' })}
            />
          </Box>
        )}

        {state.memoryPicker && (
          <Box flexDirection="column" flexShrink={0} paddingX={1} paddingY={1}>
            <MemoryPicker
              cwd={process.cwd()}
              onSelect={(target) => {
                dispatch({ type: 'HIDE_MEMORY_PICKER' });
                const prompts: Record<string, string> = {
                  user: 'Read and display the contents of ~/.coderix/CODER.md (the user-level memory file).',
                  project: 'Read and display the contents of ./CODERIX.md (the project-level memory file).',
                  auto: 'List all files in the auto-memory directory and show the MEMORY.md index contents.',
                };
                const prompt = prompts[target];
                if (prompt) {
                  runAgentTurn(prompt);
                }
              }}
              onCancel={() => dispatch({ type: 'HIDE_MEMORY_PICKER' })}
            />
          </Box>
        )}

        {state.sessionPicker && (
          <Box flexDirection="column" flexShrink={0} paddingX={1} paddingY={1}>
            <SessionPicker
              sessions={sessionManager.list().map((s) => ({
                id: s.id,
                title: s.title,
                turnCount: s.turnCount,
                model: s.model,
                updatedAt: s.updatedAt,
              }))}
              onSelect={(sessionId) => {
                dispatch({ type: 'HIDE_SESSION_PICKER' });
                const session = sessionManager.resume(sessionId);
                if (session && session.messages.length > 0) {
                  const msgs = convertTranscriptToMessages(session.messages);
                  dispatch({ type: 'LOAD_CHAT', messages: msgs, turns: [], isStreaming: false });
                }
              }}
              onCancel={() => dispatch({ type: 'HIDE_SESSION_PICKER' })}
            />
          </Box>
        )}
      </ScrollBox>

      <Box flexDirection="column" flexShrink={0}>
        <CommandHint inputText={state.inputText} selectedIndex={state.commandPickerIndex} />
        <Divider />
        <InputBox
          inputText={state.inputText}
          cursorPosition={state.cursorPosition}
          isStreaming={state.isStreaming}
          pasteBlocks={state.pasteBlocks}
          pastePreviewVisible={state.pastePreviewVisible}
          theme={config.theme}
        />
        <Divider />

        <Box marginTop={1}>
          <StatusBar
            model={state.model}
            statusPhase={statusPhase}
            isFrozen={state.isFrozen}
            error={state.error}
            totalChars={stats.totalChars}
            inputTokens={stats.inputTokens}
            outputTokens={stats.outputTokens}
            realUsage={stats.realUsage}
            accumulatedCost={stats.accumulatedCost}
            currency={config.currency}
            maxContext={config.maxContext}
            compactThreshold={config.compactThreshold}
            exitHint={state.exitHint}
            processMemory={processMemory}
            processCount={totalProcs}
          />
        </Box>

        <TeamPanel
          dismissed={state.teamPanelDismissed}
          onDismissReset={handleTeamDismissReset}
          focused={state.teamPicker}
          onFocusRequest={() => dispatch({ type: 'HIDE_TEAM_PICKER' })}
          viewedAgentId={state.subAgentView?.agentId ?? null}
          onSelect={(agentId) => {
            if (agentId === '__main__') {
              dispatch({ type: 'HIDE_TEAM_PICKER' });
              dispatch({ type: 'CLOSE_SUBAGENT_VIEW' });
            } else {
              dispatch({ type: 'OPEN_SUBAGENT_VIEW', agentId });
            }
          }}
        />
      </Box>
    </Box>
  );
}
