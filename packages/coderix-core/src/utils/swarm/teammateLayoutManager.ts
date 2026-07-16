/**
 * Teammate layout manager — color assignment and pane creation for
 * teammate visual layout in tmux/iTerm2.
 */

import type { PaneBackend } from './backends/types.js';
import { isInsideTmux } from './backends/detection.js';

const AGENT_COLORS = [
  'red', 'blue', 'green', 'yellow', 'magenta', 'cyan', 'white',
] as const;

type AgentColorName = typeof AGENT_COLORS[number];

const teammateColorAssignments = new Map<string, AgentColorName>();
let colorIndex = 0;

export function assignTeammateColor(teammateId: string): AgentColorName {
  const existing = teammateColorAssignments.get(teammateId);
  if (existing) return existing;
  const color = AGENT_COLORS[colorIndex % AGENT_COLORS.length]!;
  teammateColorAssignments.set(teammateId, color);
  colorIndex++;
  return color;
}

export function getTeammateColor(teammateId: string): AgentColorName | undefined {
  return teammateColorAssignments.get(teammateId);
}

export function clearTeammateColors(): void {
  teammateColorAssignments.clear();
  colorIndex = 0;
}

/**
 * Create a pane for a teammate using the given PaneBackend.
 * Returns the pane ID and whether this is the first teammate pane.
 */
export async function createTeammatePaneInSwarmView(
  backend: PaneBackend,
  teammateName: string,
  teammateColor?: string,
): Promise<{ paneId: string; isFirstTeammate: boolean }> {
  const result = await backend.createTeammatePane(teammateName, teammateColor);
  return {
    paneId: result.paneId,
    isFirstTeammate: !result.insideCurrentSession,
  };
}

/**
 * Enable pane border status display (tmux-only).
 * Delegates to the backend's setPaneBorderColor for the given pane.
 */
export async function enablePaneBorderStatus(
  backend: PaneBackend,
  paneId: string,
  color: string,
): Promise<void> {
  await backend.setPaneBorderColor(paneId, color);
}

/**
 * Send a shell command to a specific pane.
 */
export async function sendCommandToPane(
  backend: PaneBackend,
  paneId: string,
  command: string,
): Promise<void> {
  await backend.sendCommandToPane(paneId, command);
}

export { isInsideTmux };
