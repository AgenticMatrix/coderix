/**
 * Teammate model fallback — provides a default model for teammate agents.
 */

const DEFAULT_MODEL = 'claude-opus-4-7';

export function getHardcodedTeammateModelFallback(): string {
  return process.env.CODERIX_TEAMMATE_DEFAULT_MODEL || DEFAULT_MODEL;
}
