/**
 * Spawn utilities — environment variable propagation for teammates.
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
