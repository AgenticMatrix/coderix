/**
 * Centralized runtime feature gate for agent teams / teammate features.
 *
 * Enabled by default. Can be disabled via:
 *   CODERIX_EXPERIMENTAL_AGENT_TEAMS_DISABLED=1
 */

function isEnvTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return value === '1' || value.toLowerCase() === 'true';
}

export function isAgentSwarmsEnabled(): boolean {
  if (isEnvTruthy(process.env.CODERIX_EXPERIMENTAL_AGENT_TEAMS_DISABLED)) {
    return false;
  }
  return true;
}
