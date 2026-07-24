/**
 * Centralized runtime feature gate for agent teams / teammate features.
 *
 * Team agent functionality is now always enabled.
 * The TeamAgent tool replaces the old team_name + name path on the Agent tool.
 */

export function isAgentSwarmsEnabled(): boolean {
  return true;
}
