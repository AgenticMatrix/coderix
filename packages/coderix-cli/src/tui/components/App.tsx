import { useEffect, useRef, useMemo, useCallback, useLayoutEffect, useState } from 'react';
import { Box, Text, Static, measureElement, useStdout } from 'ink';

import type { QueryEngine } from '@coderix/core';
import type { AppConfig, Message, ContentBlock, ThinkingBlock } from '../../types.js';
import { PermissionMode, getSubAgentRegistry } from '@coderix/core';
import type { SubAgentRecord } from '@coderix/core';
import { HeaderLogo } from './HeaderLogo.js';
import { MessageBubble } from './MessageBubble.js';
import { ThinkingBlockRenderer } from './ThinkingBlockRenderer.js';
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
}

/** True when a user message contains only tool_result blocks. */
function isToolResultOnly(m: Message): boolean {
  return m.role === 'user' && m.blocks.length > 0 && m.blocks.every((b) => b.type === 'tool_result');
}

/** Check whether a message contains any tool_use blocks that are still
 *  pending or executing.  When true, the message must stay in the Live
 *  zone so that tool timers, blinking indicators, and inline progress
 *  update correctly. */
function hasActiveTools(msg: Message): boolean {
  return msg.blocks.some(
    (b) => b.type === 'tool_use' && (b.state === 'pending' || b.state === 'executing'),
  );
}

/** Find the most recent thinking block across all messages. */
function findLatestThinking(messages: Message[]): { block: ThinkingBlock; duration?: number; tokens?: number } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'assistant') {
      const thinkingBlock = msg.blocks.find((b): b is ThinkingBlock => b.type === 'thinking');
      if (thinkingBlock) {
        return { block: thinkingBlock, duration: msg.thinkingDuration, tokens: msg.thinkingTokens };
      }
    }
  }
  return null;
}

/** Find the index where the live zone begins.
 *
 *  During streaming we keep only the LAST message live (the currently-
 *  streaming assistant). Everything else is promoted to <Static>,
 *  minimizing the Ink output area that rewrites on every text delta.
 *
 *  When streaming ends while tools are still running, any message that
 *  contains pending / executing tool_use blocks stays in the Live zone
 *  until every tool settles (done / error).  Once all tools are settled
 *  the entire conversation moves into <Static> and the terminal output
 *  is frozen — scrollback, text selection, and Cmd+F all work normally
 *  on the history. */
function getLiveStart(messages: Message[], isStreaming: boolean): number {
  if (isStreaming) {
    // Streaming: keep only the last message (streaming assistant) live
    return Math.max(0, messages.length - 1);
  }
  // Not streaming: find the first message that still has active tools.
  // It and everything after it stays live until all tools settle.
  for (let i = 0; i < messages.length; i++) {
    if (hasActiveTools(messages[i]!)) {
      return i;
    }
  }
  // All tools settled — everything goes to Static.
  return messages.length;
}

type StaticItem = { _type: 'header' } | { _type: 'message'; msg: Message };

/**
 * App shell with zone-separated rendering:
 *
 *  Static zone  (<Static>)       — HeaderLogo + all past turns
 *  Live zone                     — only the currently-streaming message
 *
 * During streaming, only 1 message is in the Live zone. This means Ink
 * rewrites at most a few terminal rows on each text delta, eliminating
 * flickering and preserving terminal-native text selection on everything
 * above the current line.
 *
 * Static is re-mounted (via dynamic key) on Ctrl+D / Ctrl+E toggles
 * so expandable blocks (Update/Write diffs, thinking) reflect the new
 * expand/collapse state. Only the current round has collapsed content,
 * so older messages render identically after remount.
 */
export function App({ config, engine, store, sessionManager, initialMessages, showSessionPicker }: AppProps) {
  const [state, dispatch] = useChatReducer(config.model, config.inputPrice, config.outputPrice, config.cacheReadPrice);

  const setAppState = useSetAppState();

  // ── Terminal size & layout measurement ──────────────────────
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? process.stdout.rows ?? 24;
  const columns = stdout?.columns ?? process.stdout.columns ?? 80;

  const controlsRef = useRef<any>(null);
  const [controlsHeight, setControlsHeight] = useState(0);
  const lastMeasureKeyRef = useRef('');

  useLayoutEffect(() => {
    if (!controlsRef.current || rows <= 0) return;

    const measureKey = [
      rows, columns,
      state.taskPanelDismissed ? 1 : 0,
      state.todoPanelDismissed ? 1 : 0,
      state.teamPanelDismissed ? 1 : 0,
      state.teamPicker ? 1 : 0,
      state.inputText.includes('\n') ? 1 : 0,
      state.pastePreviewVisible ? 1 : 0,
      Object.keys(state.pasteBlocks ?? {}).length,
    ].join(':');

    if (measureKey === lastMeasureKeyRef.current) return;
    lastMeasureKeyRef.current = measureKey;

    const measured = measureElement(controlsRef.current);
    setControlsHeight(prev => (prev === measured.height ? prev : measured.height));
  });

  const outerPadding = 2; // padding={1} top + bottom
  const freezeHeight = state.isFrozen ? 1 : 0;
  const liveMaxHeight = controlsHeight > 0
    ? Math.max(1, rows - outerPadding - freezeHeight - controlsHeight)
    : undefined;

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

  useInputHandler({
    inputText: state.inputText,
    cursorPosition: state.cursorPosition,
    isStreaming: state.isStreaming,
    messages: state.messages,
    dispatch,
    onSend: runAgentTurn,
    onInterrupt: () => engine.interrupt(),
    onExit: () => process.exit(0),
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
      onExit: () => {
        process.exit(0);
      },
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

  // Extract the most recent thinking block to render in the live zone.
  // Only the latest thinking is shown; once a new thinking session starts,
  // the previous one is replaced.
  const latestThinking = useMemo(() => findLatestThinking(displayMessages), [displayMessages]);

  // During streaming, keep only the LAST message live.
  // Everything else goes to <Static> and is never redrawn —
  // except on Ctrl+D / Ctrl+E, where the Static key bumps to remount
  // and re-render with the toggled expand/collapse state.
  const liveStart = getLiveStart(displayMessages, state.isStreaming);

  const staticItems = useMemo<StaticItem[]>(() => {
    const historical = displayMessages.slice(0, liveStart);
    return [
      { _type: 'header' as const },
      ...historical.map((msg): StaticItem => ({ _type: 'message' as const, msg })),
    ];
  }, [displayMessages, liveStart]);

  // Bump on contentExpanded toggle so <Static> remounts with new state.
  // Only the current round has expandable blocks (Update/Write diffs),
  // so older messages render identically — no visual difference.

  const live = displayMessages.slice(liveStart);

  // Count new messages arrived while frozen
  const frozenNewCount = state.isFrozen && state.isStreaming
    ? state.messages.length - frozenRef.current.length
    : 0;

  return (
    <Box flexDirection="column" height="100%" padding={1}>
      {/* ── Static zone: re-renders on Ctrl+D / Ctrl+E ────────────── */}
      <Static key={`static-${state.contentExpanded}-${state.subAgentView?.agentId ?? 'main'}`} items={staticItems}>
        {(item) => {
          if (item._type === 'header') return <HeaderLogo key="header" />;
          return <MessageBubble key={item.msg.id} message={item.msg} contentExpanded={state.contentExpanded} theme={config.theme} hideThinking />;
        }}
      </Static>

      {/* ── Freeze indicator (pre-allocated to avoid layout shift) ── */}
      {state.isFrozen && (
        <Box flexShrink={0} height={1} flexDirection="row">
          <Box width={2} flexShrink={0} />
          <Box flexGrow={1}>
            <Text color="yellow" dimColor>
              ⏸ Paused — {frozenNewCount > 0 ? `${frozenNewCount} new message(s) — ` : ''}PageDown / End to follow
            </Text>
          </Box>
        </Box>
      )}
      {!state.isFrozen && <Box flexShrink={0} height={0} />}

      {/* ── Live zone: max-height capped to prevent pushing controls ── */}
      <Box
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        maxHeight={liveMaxHeight}
        paddingX={1}
      >
        {/* Sub-agent indicator header */}
        {state.subAgentView && (
          <Box flexShrink={0} marginBottom={1} flexDirection="row">
            <Box width={2} flexShrink={0} />
            <Box flexDirection="column" flexGrow={1}>
              <Text dimColor>--- {state.subAgentView.agentId} ---</Text>
              <Text dimColor> Esc or Ctrl+T to return to main</Text>
            </Box>
          </Box>
        )}

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

        <OffscreenFreeze frozen={state.isFrozen}>

          {live.map((message) => (
            <MessageBubble key={message.id} message={message} contentExpanded={state.contentExpanded} theme={config.theme} hideThinking maxLines={liveMaxHeight} />
          ))}

          {/* Latest thinking block — always live, below tools/output, closest to input */}
          {latestThinking && !state.isFrozen && (
            <ThinkingBlockRenderer
              content={latestThinking.block.content}
              thinkingExpanded={latestThinking.block.expanded}
              thinkingDuration={latestThinking.duration}
              thinkingTokens={latestThinking.tokens}
            />
          )}

        </OffscreenFreeze>

        {state.approvalReq && (
          <Box flexDirection="column" flexShrink={0} paddingX={1} paddingY={1}>
            <ApprovalPrompt
              req={state.approvalReq}
              onChoice={handleApprovalChoice}
            />
          </Box>
        )}

        {state.questionReq && (
          <Box flexDirection="column" flexShrink={0} paddingX={1} paddingY={1}>
            <QuestionPrompt
              questions={state.questionReq.questions}
              onAnswer={handleQuestionAnswer}
            />
          </Box>
        )}

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
      </Box>

      <Box ref={controlsRef} flexDirection="column" flexShrink={0}>
        <TaskPanel
          dismissed={state.taskPanelDismissed}
          onDismissReset={handleTaskDismissReset}
        />

        <TodoPanel
          dismissed={state.todoPanelDismissed}
          onDismissReset={handleTodoDismissReset}
        />

        <CommandHint inputText={state.inputText} selectedIndex={state.commandPickerIndex} />
        <InputBox
          inputText={state.inputText}
          cursorPosition={state.cursorPosition}
          isStreaming={state.isStreaming}
          pasteBlocks={state.pasteBlocks}
          pastePreviewVisible={state.pastePreviewVisible}
          theme={config.theme}
        />

        <Box marginTop={1}>
          <StatusBar
            model={state.model}
            isStreaming={state.isStreaming}
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
