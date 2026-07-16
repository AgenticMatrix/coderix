/**
 * Leader permission bridge — module-level bridge that connects the leader's
 * permission UI (React ToolUseConfirm dialog) to non-React code such as the
 * in-process teammate runner and the inbox poller.
 *
 * This allows permission requests from pane-based (tmux/iTerm2) teammates
 * to be routed through the same UI dialog that in-process teammates use.
 */

/** Queue setter for ToolUseConfirm — set by the React UI layer. */
let leaderToolUseConfirmQueueSetter:
  | ((updater: (prev: unknown[]) => unknown[]) => void)
  | null = null;

/** ToolPermissionContext setter — set by the React UI layer. */
let leaderSetToolPermissionContextSetter:
  | ((context: unknown, opts?: { preserveMode?: boolean }) => void)
  | null = null;

export function registerLeaderToolUseConfirmQueue(
  setter: (updater: (prev: unknown[]) => unknown[]) => void,
): void {
  leaderToolUseConfirmQueueSetter = setter;
}

export function getLeaderToolUseConfirmQueue():
  | ((updater: (prev: unknown[]) => unknown[]) => void)
  | null {
  return leaderToolUseConfirmQueueSetter;
}

export function registerLeaderSetToolPermissionContext(
  setter: (context: unknown, opts?: { preserveMode?: boolean }) => void,
): void {
  leaderSetToolPermissionContextSetter = setter;
}

export function getLeaderSetToolPermissionContext():
  | ((context: unknown, opts?: { preserveMode?: boolean }) => void)
  | null {
  return leaderSetToolPermissionContextSetter;
}

export function unregisterLeaderToolUseConfirmQueue(): void {
  leaderToolUseConfirmQueueSetter = null;
}

export function unregisterLeaderSetToolPermissionContext(): void {
  leaderSetToolPermissionContextSetter = null;
}
