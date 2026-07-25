import { useRef } from 'react';
import { useInput } from '@coderix/ink';

import type { Message, ChatAction } from '../../types.js';
import { expandPasteMarkers } from './useChatReducer.js';
import { getSubAgentRegistry } from '@coderix/core';
import { listCommandNames } from '../../commands/index.js';

function getCycleGroup(inputName: string, allCmds: string[]): string[] {
  for (let len = inputName.length; len >= 1; len--) {
    const m = allCmds.filter((c) => c.startsWith(inputName.slice(0, len)));
    if (m.length > 1) return m;
  }
  return [];
}

export interface InputHandlerDeps {
  inputText: string;
  cursorPosition: number;
  statusPhase: 'busy' | 'wait' | 'idle';
  messages: Message[];
  dispatch: React.Dispatch<ChatAction>;
  onSend: (text: string) => void;
  /** Interrupt the running main agent (streaming/thinking). */
  onInterrupt: () => void;
  /** Kill all sub-agents and background tools. */
  onKillAll: () => void;
  /** Exit the process. */
  onExit: () => void;
  /** When true, input is suppressed (e.g. during approval prompt). */
  blocked?: boolean;
  /** When true, the team picker overlay is shown. */
  teamPicker?: boolean;
  /** Number of agents in the registry (Down arrow only shows picker when > 0). */
  agentCount?: number;
  /** Optional slash command handler. Returns true if the command was handled. */
  onSlashCommand?: (input: string) => boolean;
  /** Input history lines (newest last). */
  history: string[];
  /** Current position in history (-1 = not browsing). */
  historyIndex: number;
  /** Saved input before entering history browse mode. */
  historyScratch: string;
  /** Paste block contents for expanding markers before send. */
  pasteBlocks: Record<number, string>;
  /** Current sub-agent view state (null = main chat). */
  subAgentView?: { agentId: string } | null;
  /** Last viewed sub-agent ID — Ctrl+T defaults to this. */
  lastAgentViewId?: string | null;
  /** Current command picker selected index (-1 = hidden). */
  commandPickerIndex: number;
  /** Callback to send a message to a sub-agent (immersive mode). */
  onSubAgentSend?: (agentId: string, text: string) => void;
}

/**
 * Hook that handles all keyboard input via Ink's useInput.
 *
 * Keys:
 *   Enter       — send message
 *   Escape      — clear input
 *   Ctrl+O      — toggle expand / collapse all blocks (tools + content)
 *   Ctrl+B      — move sub-agent to background (unblocks main agent)
 *   Ctrl+T      — view sub-agent transcript
 *   Ctrl+P      — toggle task & todo panels
 *   Ctrl+K      — toggle team picker
   Esc         — close sub-agent view / clear input
 *   ← → Home End — cursor movement
 *   Backspace/Del — deletion
 *   Printable   — insert at cursor
 */
export function useInputHandler({
  inputText,
  cursorPosition: _cp,
  statusPhase,
  messages,
  dispatch,
  onSend,
  onInterrupt,
  onKillAll,
  onExit,
  onSlashCommand,
  blocked,
  history,
  historyIndex,
  historyScratch,
  pasteBlocks,
  subAgentView,
  lastAgentViewId,
  teamPicker,
  agentCount = 0,
  commandPickerIndex,
  onSubAgentSend,
}: InputHandlerDeps) {
  const slashRef = useRef(onSlashCommand);
  slashRef.current = onSlashCommand;
  const inputRef = useRef(inputText);
  inputRef.current = inputText;
  const statusRef = useRef(statusPhase);
  statusRef.current = statusPhase;
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const killRef = useRef(onKillAll);
  killRef.current = onKillAll;
  const interruptRef = useRef(onInterrupt);
  interruptRef.current = onInterrupt;
  const exitRef = useRef(onExit);
  exitRef.current = onExit;
  const exitPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const DOUBLE_PRESS_MS = 500;
  const agentCountRef = useRef(agentCount);
  agentCountRef.current = agentCount;

  useInput(
    (input, key) => {
      const isCtrlC = (key.ctrl && (input === 'c' || input === '\x03')) || input === '\x03';

      // Clear double-press exit hint on any non-Ctrl+C input
      if (!isCtrlC && exitPressTimerRef.current) {
        clearTimeout(exitPressTimerRef.current);
        exitPressTimerRef.current = null;
        dispatch({ type: 'HIDE_EXIT_HINT' });
      }

      // Ctrl+C: smart 4-tier handler
      if (isCtrlC) {
        // When a modal (ask/approve) is open, let its own useInput
        // handler process Ctrl+C.  Don't also run 4-tier logic here,
        // which would race with the modal's deferred resolution and
        // leave the tool stuck in executing state.
        if (blockedRef.current) return;

        // Tier 1: busy (main agent streaming/thinking) → interrupt it.
        // If no tools have been executed yet, undo the turn and restore
        // the user's input so they can edit and re-submit.
        if (statusRef.current === 'busy') {
          interruptRef.current();
          // Check if any tool_use blocks exist after the last user message
          let hasTools = false;
          let lastUserIdx = -1;
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i]!.role === 'user') { lastUserIdx = i; break; }
          }
          if (lastUserIdx >= 0) {
            for (let i = lastUserIdx + 1; i < messages.length; i++) {
              const m = messages[i]!;
              if (m.role === 'assistant' && m.blocks.some(b => b.type === 'tool_use')) {
                hasTools = true;
                break;
              }
            }
          }
          dispatch({ type: hasTools ? 'INTERRUPT' : 'INTERRUPT_AND_UNDO' });
          return;
        }
        // Tier 2: wait (sub-agents / background tools) → kill them all
        if (statusRef.current === 'wait') {
          killRef.current();
          dispatch({ type: 'INTERRUPT' });
          return;
        }
        // Tier 3: idle, input has text → clear it (and reset double-press)
        if (inputRef.current.length > 0) {
          if (exitPressTimerRef.current) {
            clearTimeout(exitPressTimerRef.current);
            exitPressTimerRef.current = null;
            dispatch({ type: 'HIDE_EXIT_HINT' });
          }
          dispatch({ type: 'SET_INPUT', text: '' });
          dispatch({ type: 'SET_HISTORY_INDEX', index: -1 });
          return;
        }
        // Tier 4: idle, input empty → double-press to exit
        if (exitPressTimerRef.current) {
          // Second press within window → exit
          clearTimeout(exitPressTimerRef.current);
          exitPressTimerRef.current = null;
          dispatch({ type: 'HIDE_EXIT_HINT' });
          exitRef.current();
        } else {
          // First press → show hint, start timer
          dispatch({ type: 'SHOW_EXIT_HINT' });
          exitPressTimerRef.current = setTimeout(() => {
            exitPressTimerRef.current = null;
            dispatch({ type: 'HIDE_EXIT_HINT' });
          }, DOUBLE_PRESS_MS);
        }
        return;
      }
      // Always allow Escape and Ctrl+T (for navigating sub-agent views)
      if (key.escape) {
        if (subAgentView) {
          dispatch({ type: 'CLOSE_SUBAGENT_VIEW' });
          return;
        }
        if (teamPicker) {
          dispatch({ type: 'HIDE_TEAM_PICKER' });
          return;
        }
        if (blockedRef.current) return;
        dispatch({ type: 'SET_INPUT', text: '' });
        dispatch({ type: 'SET_HISTORY_INDEX', index: -1 });
        return;
      }

      // Ctrl+B: send sub-agent to background
      if (key.ctrl && input === 'b') {
        const registry = getSubAgentRegistry();
        if (subAgentView) {
          // Background the currently-viewed agent via registry signal
          registry?.background(subAgentView.agentId);
          dispatch({ type: 'CLOSE_SUBAGENT_VIEW' });
          return;
        }
        if (teamPicker) {
          dispatch({ type: 'HIDE_TEAM_PICKER' });
          return;
        }
        // No sub-agent view open — background all running foreground agents
        if (registry) {
          registry.backgroundAll();
        }
        return;
      }

      // Ctrl+T toggles sub-agent transcript view
      if (key.ctrl && input === 't') {
        if (subAgentView) {
          dispatch({ type: 'CLOSE_SUBAGENT_VIEW' });
          return;
        }
        const registry = getSubAgentRegistry();
        if (registry) {
          const allAgents = registry.list();
          if (allAgents.length === 0) return;

          // Prefer last viewed agent if still in registry
          if (lastAgentViewId && registry.get(lastAgentViewId)) {
            dispatch({ type: 'OPEN_SUBAGENT_VIEW', agentId: lastAgentViewId });
            return;
          }

          // Default: most recently created agent in the full list
          const latest = allAgents.reduce((a, b) =>
            a.createdAt > b.createdAt ? a : b,
          );
          dispatch({ type: 'OPEN_SUBAGENT_VIEW', agentId: latest.id });
        }
        return;
      }

      // Ctrl+P toggles task & todo panels
      if (key.ctrl && input === 'p') {
        dispatch({ type: 'TOGGLE_TASK_PANEL' });
        dispatch({ type: 'TOGGLE_TODO_PANEL' });
        return;
      }

      // Ctrl+K opens team member picker overlay
      if (key.ctrl && input === 'k') {
        if (teamPicker) {
          dispatch({ type: 'HIDE_TEAM_PICKER' });
        } else {
          dispatch({ type: 'SHOW_TEAM_PICKER' });
        }
        return;
      }

      // When team picker is focused, suppress normal input
      // (the TeamPanel component handles arrow keys / Enter / Escape)
      if (teamPicker) return;

      // When an approval overlay is active, suppress normal input.
      if (blocked) return;

      // Display freeze (scroll-away) controls ─────────────────
      // PageUp  → freeze display (enter review mode)
      // PageDown / End → unfreeze (resume following)
      // These work even when not streaming, to be safe.
      if (key.pageUp) {
        dispatch({ type: 'FREEZE_DISPLAY' });
        return;
      }
      if (key.pageDown || key.end) {
        dispatch({ type: 'UNFREEZE_DISPLAY' });
        return;
      }

      // Ctrl+Enter → insert newline (manual multi-line input)
      if (input === '\n') {
        dispatch({ type: 'INSERT_CHAR', char: '\n' });
        return;
      }

      // In sub-agent immersive mode, send to sub-agent via onSubAgentSend
      if (subAgentView && key.return) {
        const cur = inputRef.current;
        if (cur.trim().length > 0 && onSubAgentSend) {
          const expandedText = expandPasteMarkers(cur.trim(), pasteBlocks);
          dispatch({ type: 'ADD_HISTORY', line: expandedText });
          dispatch({ type: 'SET_HISTORY_INDEX', index: -1 });
          onSubAgentSend(subAgentView.agentId, expandedText);
        }
        return;
      }

      // Ctrl+O toggles expand / collapse of all blocks (tools + content)
      if (key.ctrl && input === 'o') {
        dispatch({ type: 'TOGGLE_ALL_EXPAND' });
        dispatch({ type: 'TOGGLE_ALL_CONTENT' });
        return;
      }

      // Tab: fill command from picker
      const curInput = inputRef.current;
      if (key.tab && curInput.startsWith('/')) {
        const inputName = curInput.slice(1).split(' ')[0]!.toLowerCase();
        const allCmds = listCommandNames();
        const group = getCycleGroup(inputName, allCmds);
        const matches = group.length > 0 ? group : allCmds.filter((c) => c.startsWith(inputName));
        if (matches.length > 0) {
          const idx = commandPickerIndex >= 0 && commandPickerIndex < matches.length
            ? commandPickerIndex
            : 0;
          dispatch({ type: 'SET_INPUT', text: '/' + matches[idx]! + ' ' });
          dispatch({ type: 'SET_COMMAND_PICKER_INDEX', index: -1 });
        }
        return;
      }

      // Enter: if exact known command, fall through to execute;
      // otherwise fill AND execute in one step
      if (key.return && curInput.startsWith('/')) {
        const inputName = curInput.slice(1).split(' ')[0]!.toLowerCase();
        const exactMatch = listCommandNames().includes(inputName);
        if (exactMatch) {
          // Known command — hide picker and let normal Enter handler execute it
          dispatch({ type: 'SET_COMMAND_PICKER_INDEX', index: -1 });
          // Do NOT return — let the regular key.return handler below run
        } else {
          // Partial match — fill from picker and execute immediately
          const allCmds = listCommandNames();
          const group = getCycleGroup(inputName, allCmds);
          const matches = group.length > 0 ? group : allCmds.filter((c) => c.startsWith(inputName));
          if (matches.length > 0) {
            const idx = commandPickerIndex >= 0 && commandPickerIndex < matches.length
              ? commandPickerIndex
              : 0;
            const filled = '/' + matches[idx]! + ' ';
            dispatch({ type: 'SET_INPUT', text: filled });
            dispatch({ type: 'SET_COMMAND_PICKER_INDEX', index: -1 });
            if (slashRef.current?.(filled.trimEnd())) {
              dispatch({ type: 'SET_INPUT', text: '' });
            }
          } else {
            dispatch({ type: 'SET_COMMAND_PICKER_INDEX', index: -1 });
          }
          return;
        }
      }

      if (key.return) {
        const cur = inputRef.current;
        if (cur.trim().length > 0) {
          // Auto-resume following when user sends a message
          dispatch({ type: 'UNFREEZE_DISPLAY' });
          // Expand paste markers to full text before sending / saving history
          const expandedText = expandPasteMarkers(cur.trim(), pasteBlocks);
          dispatch({ type: 'ADD_HISTORY', line: expandedText });
          dispatch({ type: 'SET_HISTORY_INDEX', index: -1 });
          // Check for slash commands first
          if (cur.startsWith('/') && slashRef.current?.(cur)) {
            dispatch({ type: 'SET_INPUT', text: '' });
          } else {
            onSend(expandedText);
          }
        }
        return;
      }

      // ── Command picker navigation (up / down arrows) ──────────
      if (curInput.startsWith('/') && (key.upArrow || key.downArrow)) {
        const inputName = curInput.slice(1).split(' ')[0]!.toLowerCase();
        const allCmds = listCommandNames();
        const group = getCycleGroup(inputName, allCmds);
        const matches = group.length > 0 ? group : allCmds.filter((c) => c.startsWith(inputName));
        if (matches.length > 1) {
          const curIdx = commandPickerIndex >= 0 && commandPickerIndex < matches.length
            ? commandPickerIndex
            : 0;
          const delta = key.upArrow ? -1 : 1;
          const newIdx = ((curIdx + delta) % matches.length + matches.length) % matches.length;
          dispatch({ type: 'SET_COMMAND_PICKER_INDEX', index: newIdx });
        }
        return;
      }

      // ── History navigation (up / down arrows) ──────────────────
      if (key.upArrow) {
        if (history.length === 0) return;
        if (historyIndex === -1) {
          // Enter history browse mode — save current input as scratch
          const newIdx = history.length - 1;
          dispatch({ type: 'SET_HISTORY_INDEX', index: newIdx, scratch: inputText });
          dispatch({ type: 'SET_INPUT', text: history[newIdx]! });
          dispatch({ type: 'SET_CURSOR', position: history[newIdx]!.length });
          return;
        }
        if (historyIndex > 0) {
          const newIdx = historyIndex - 1;
          dispatch({ type: 'SET_HISTORY_INDEX', index: newIdx });
          dispatch({ type: 'SET_INPUT', text: history[newIdx]! });
          dispatch({ type: 'SET_CURSOR', position: history[newIdx]!.length });
        }
        return;
      }

      if (key.downArrow) {
        if (historyIndex === -1) {
          // Show Team Picker when there are agents in registry OR ref count > 0
          const regCount = getSubAgentRegistry()?.list().length ?? 0;
          if (agentCountRef.current > 0 || regCount > 0) {
            dispatch({ type: 'SHOW_TEAM_PICKER' });
          }
          return;
        }
        if (historyIndex < history.length - 1) {
          const newIdx = historyIndex + 1;
          dispatch({ type: 'SET_HISTORY_INDEX', index: newIdx });
          dispatch({ type: 'SET_INPUT', text: history[newIdx]! });
          dispatch({ type: 'SET_CURSOR', position: history[newIdx]!.length });
        } else {
          // At the last entry — exit history, restore scratch
          dispatch({ type: 'SET_HISTORY_INDEX', index: -1 });
          dispatch({ type: 'SET_INPUT', text: historyScratch });
          dispatch({ type: 'SET_CURSOR', position: historyScratch.length });
        }
        return;
      }

      // Any other key press exits history browse mode
      if (historyIndex >= 0) {
        dispatch({ type: 'SET_HISTORY_INDEX', index: -1 });
      }

      // ── Cursor movement ────────────────────────────────────────
      if (key.leftArrow) {
        dispatch({
          type: 'SET_CURSOR',
          position: _cp - 1,
        });
        return;
      }
      if (key.rightArrow) {
        dispatch({
          type: 'SET_CURSOR',
          position: _cp + 1,
        });
        return;
      }
      if (key.home) {
        dispatch({ type: 'SET_CURSOR', position: 0 });
        return;
      }
      if (key.end) {
        dispatch({ type: 'SET_CURSOR', position: inputText.length });
        return;
      }

      // ── Deletion ───────────────────────────────────────────────
      if (key.backspace) {
        dispatch({ type: 'DELETE_CHAR', position: 'before' });
        return;
      }
      if (key.delete) {
        dispatch({ type: 'DELETE_CHAR', position: 'after' });
        return;
      }

      // Ignore non-printable characters
      if (!input || input.length === 0) return;

      // Multi-line input → paste block, or toggle preview if blocks exist
      if (input.includes('\n') || input.includes('\r')) {
        if (Object.keys(pasteBlocks).length > 0) {
          dispatch({ type: 'TOGGLE_PASTE_PREVIEW' });
        } else {
          dispatch({ type: 'ADD_PASTE_BLOCK', text: input });
        }
        return;
      }

      // Insert character at cursor position
      dispatch({ type: 'INSERT_CHAR', char: input });
    },
    { isActive: true },
  );
}
