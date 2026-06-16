import { useEffect, useRef, useMemo, useCallback } from 'react';
import { Box, Text, Static } from 'ink';

import type { QueryEngine } from '../../core/query-engine.js';
import type { AppConfig, Message } from '../../types.js';
import { PermissionMode } from '../../core/types.js';
import { HeaderLogo } from './HeaderLogo.js';
import { MessageBubble } from './MessageBubble.js';
import { InputBox } from './InputBox.js';
import { StatusBar } from './StatusBar.js';
import { ApprovalPrompt } from './ApprovalPrompt.js';
import { SubAgentTranscriptView } from './SubAgentTranscriptView.js';
import { SubAgentPicker } from './SubAgentPicker.js';
import { TaskPanel } from './TaskPanel.js';
import { TodoPanel } from './TodoPanel.js';
import { TeamPanel } from './TeamPanel.js';
import { TeamAgentPicker } from './TeamAgentPicker.js';
import { OffscreenFreeze } from './OffscreenFreeze.js';
import { CommandHint } from './CommandHint.js';
import { useChatReducer } from '../hooks/useChatReducer.js';
import { useAgentBridge } from '../hooks/useAgentBridge.js';
import { useInputHandler } from '../hooks/useInputHandler.js';
import { useTokenStats } from '../hooks/useTokenStats.js';
import { createSlashHandler } from '../../commands/index.js';
import { loadHistory } from '../../cli/history.js';
import { useAppState, useSetAppState } from '../../state/AppStateContext.js';
import type { Store } from '../../state/store.js';
import type { AppState } from '../../state/AppState.js';

interface AppProps {
  config: AppConfig;
  engine: QueryEngine;
  store: Store<AppState>;
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
 * so expandable blocks (Edit/Write diffs, thinking) reflect the new
 * expand/collapse state. Only the current round has collapsed content,
 * so older messages render identically after remount.
 */
export function App({ config, engine, store }: AppProps) {
  const [state, dispatch] = useChatReducer(config.model, config.inputPrice, config.outputPrice, config.cacheReadPrice);

  const setAppState = useSetAppState();

  // Sync ChatState → AppState.ui so components reading via useAppState see the latest
  useEffect(() => {
    store.setState(state);
  }, [state]);

  const messagesRef = useRef(state.messages);
  messagesRef.current = state.messages;

  const { runAgentTurn } = useAgentBridge({ engine, dispatch, setAppState });

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
    blocked: state.approvalReq !== null || state.agentPicker,
    teamPicker: state.teamPicker,
    subAgentView: state.subAgentView,
    lastAgentViewId: state.lastAgentViewId,
    commandPickerIndex: state.commandPickerIndex,
    history: state.history,
    historyIndex: state.historyIndex,
    historyScratch: state.historyScratch,
    pasteBlocks: state.pasteBlocks,
    onSlashCommand: createSlashHandler({
      dispatch,
      send: runAgentTurn,
      model: config.model,
      isStreaming: state.isStreaming,
      inputText: state.inputText,
      onExit: () => {
        process.exit(0);
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

  const stats = useTokenStats(state.messages, state.tokenUsage, state.accumulatedCost);

  const messages = state.messages;

  // When display is frozen (user scrolled up), keep showing the snapshot.
  // The reducer continues updating state.messages in the background.
  const frozenRef = useRef(state.messages);
  if (!state.isFrozen) frozenRef.current = state.messages;
  const displayMessages = state.isFrozen ? frozenRef.current : state.messages;

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
  // Only the current round has expandable blocks (Edit/Write diffs),
  // so older messages render identically — no visual difference.

  const live = displayMessages.slice(liveStart);

  // Count new messages arrived while frozen
  const frozenNewCount = state.isFrozen && state.isStreaming
    ? state.messages.length - frozenRef.current.length
    : 0;

  return (
    <Box flexDirection="column" height="100%" padding={1}>
      {/* ── Static zone: re-renders on Ctrl+D / Ctrl+E ────────────── */}
      <Static key={`static-${state.contentExpanded}`} items={staticItems}>
        {(item) => {
          if (item._type === 'header') return <HeaderLogo key="header" />;
          return <MessageBubble key={item.msg.id} message={item.msg} contentExpanded={state.contentExpanded} />;
        }}
      </Static>

      {/* ── Freeze indicator (pre-allocated to avoid layout shift) ── */}
      {state.isFrozen && (
        <Box flexShrink={0} height={1}>
          <Text color="yellow" dimColor>
            ⏸ Paused — {frozenNewCount > 0 ? `${frozenNewCount} new message(s) — ` : ''}PageDown / End to follow
          </Text>
        </Box>
      )}
      {!state.isFrozen && <Box flexShrink={0} height={0} />}

      {/* ── Live zone: only the current streaming message ──────── */}
      <Box flexDirection="column" flexGrow={1} flexShrink={1} paddingX={1}>
        {state.subAgentView ? (
          <SubAgentTranscriptView
            agentId={state.subAgentView.agentId}
            onBack={() => dispatch({ type: 'CLOSE_SUBAGENT_VIEW' })}
            onSendMessage={(agentId, message) => {
              engine.sendSubAgentMessage(agentId, message).then(() => {
                dispatch({ type: 'CLOSE_SUBAGENT_VIEW' });
              });
            }}
          />
        ) : (
          <>
            {displayMessages.length === 0 && !state.isStreaming && (
              <Box marginY={1}>
                <Text dimColor>
                  Welcome to Coder Chat TUI! Type a message and press Enter to start.
                </Text>
              </Box>
            )}

            <OffscreenFreeze frozen={state.isFrozen}>
              {live.map((message) => (
                <MessageBubble key={message.id} message={message} contentExpanded={state.contentExpanded} />
              ))}
            </OffscreenFreeze>

            {state.approvalReq && (
              <Box flexDirection="column" flexShrink={0} paddingX={1} paddingY={1}>
                <ApprovalPrompt
                  req={state.approvalReq}
                  onChoice={handleApprovalChoice}
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

            {state.teamPicker && (
              <Box flexDirection="column" flexShrink={0} paddingX={1} paddingY={1}>
                <TeamAgentPicker
                  onSelect={(agentId) => {
                    dispatch({ type: 'HIDE_TEAM_PICKER' });
                    dispatch({ type: 'OPEN_SUBAGENT_VIEW', agentId });
                  }}
                  onCancel={() => dispatch({ type: 'HIDE_TEAM_PICKER' })}
                />
              </Box>
            )}
          </>
        )}
      </Box>

      <TaskPanel
        dismissed={state.taskPanelDismissed}
        onDismissReset={handleTaskDismissReset}
      />

      <TodoPanel
        dismissed={state.todoPanelDismissed}
        onDismissReset={handleTodoDismissReset}
      />

      <TeamPanel
        dismissed={state.teamPanelDismissed}
        onDismissReset={handleTeamDismissReset}
      />

      <CommandHint inputText={state.inputText} selectedIndex={state.commandPickerIndex} />
      <InputBox
        inputText={state.inputText}
        cursorPosition={state.cursorPosition}
        isStreaming={state.isStreaming}
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
        />
      </Box>
    </Box>
  );
}
