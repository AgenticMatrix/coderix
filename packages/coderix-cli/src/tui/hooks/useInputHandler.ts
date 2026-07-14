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
  isStreaming: boolean;
  messages: Message[];
  dispatch: React.Dispatch<ChatAction>;
  onSend: (text: string) => void;
  /** Interrupt the running main agent. */
  onInterrupt: () => void;
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
 *   Ctrl+E      — toggle expand / collapse tool blocks
   Ctrl+D      — toggle expand / collapse block content (thinking, etc.)
   Ctrl+T      — view sub-agent transcript
   Ctrl+P      — toggle task panel
   Ctrl+K      — toggle team picker
   Esc         — close sub-agent view / clear input
 *   ← → Home End — cursor movement
 *   Backspace/Del — deletion
 *   Printable   — insert at cursor
 */
export function useInputHandler({
  inputText,
  cursorPosition: _cp,
  isStreaming,
  messages,
  dispatch,
  onSend,
  onInterrupt,
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

  useInput(
    (input, key) => {
      // ── Ctrl+C: smart 3-tier exit ──────────────────────────
      if ((key.ctrl && (input === 'c' || input === '\x03')) || input === '\x03') {
        // Tier 1: main agent running → interrupt it
        if (isStreaming) {
          onInterrupt();
          dispatch({ type: 'INTERRUPT' });
          return;
        }
        // Tier 2: input has text → clear it
        if (inputRef.current.length > 0) {
          dispatch({ type: 'SET_INPUT', text: '' });
          dispatch({ type: 'SET_HISTORY_INDEX', index: -1 });
          return;
        }
        // Tier 3: agent not running, input empty → exit
        onExit();
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
        if (blocked) return;
        dispatch({ type: 'SET_INPUT', text: '' });
        dispatch({ type: 'SET_HISTORY_INDEX', index: -1 });
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

      // Ctrl+P toggles task panel
      if (key.ctrl && input === 'p') {
        dispatch({ type: 'TOGGLE_TASK_PANEL' });
        return;
      }

      // Ctrl+O toggles todo panel
      if (key.ctrl && input === 'o') {
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

      // ── Display freeze (scroll-away) controls ─────────────────
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

      // Ctrl+E toggles expand / collapse of tool blocks
      if (key.ctrl && input === 'e') {
        dispatch({ type: 'TOGGLE_ALL_EXPAND' });
        return;
      }

      // Ctrl+D toggles expand / collapse of block content (thinking, etc.)
      if (key.ctrl && input === 'd') {
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
          // Show Team Picker only when there are agents to pick from
          if (agentCount > 0) {
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

      // Prevent typing while streaming
      if (isStreaming) return;

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
