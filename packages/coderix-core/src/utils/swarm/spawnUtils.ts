/**
 * Spawn utilities — CLI argument and environment variable propagation.
 *
 * When spawning a teammate in a new tmux/iTerm2 pane, the new process
 * needs the same CLI flags and environment as the leader.
 */

// ---------------------------------------------------------------------------
// Environment variables to forward
// ---------------------------------------------------------------------------

const FORWARD_ENV_VARS = new Set([
  'HOME',
  'PATH',
  'USER',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TZ',
  'NODE_PATH',
  // Provider selection
  'CODERIX_USE_BEDROCK',
  'CODERIX_USE_VERTEX',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY',
  // Proxy
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  // SSL certs
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  // Config
  'CODERIX_CONFIG_DIR',
  'XDG_CONFIG_HOME',
  // Debug
  'DEBUG',
  'NODE_DEBUG',
  // Telemetry
  'CODERIX_TELEMETRY_DISABLED',
]);

/** Build a forward env string from the leader's environment. */
export function buildForwardEnv(extra: Record<string, string> = {}): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of FORWARD_ENV_VARS) {
    const val = process.env[key];
    if (val !== undefined) {
      result[key] = val;
    }
  }
  Object.assign(result, extra);
  return result;
}

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------

/** CLI args to propagate to spawned teammates. */
export function buildTeammateCliArgs(config: {
  agentId: string;
  agentName: string;
  teamName: string;
  agentColor?: string;
  agentType?: string;
  model?: string;
  settings?: string;
}): string[] {
  const args: string[] = [
    `--agent-id=${config.agentId}`,
    `--agent-name=${config.agentName}`,
    `--team-name=${config.teamName}`,
  ];
  if (config.agentColor) args.push(`--agent-color=${config.agentColor}`);
  if (config.agentType) args.push(`--agent-type=${config.agentType}`);
  if (config.model) args.push(`--model=${config.model}`);
  if (config.settings) args.push(`--settings=${config.settings}`);
  return args;
}

// ---------------------------------------------------------------------------
// Binary path
// ---------------------------------------------------------------------------

/** Resolve the binary path for spawning teammates. */
export function getBinaryPath(): string {
  if (process.env.CODERIX_TEAMMATE_COMMAND) {
    return process.env.CODERIX_TEAMMATE_COMMAND;
  }
  return process.execPath;
}
