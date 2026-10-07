/**
 * Global test setup — deterministic runtime environment.
 *
 * 1. No credential env vars — prevents accidentall local key leaks.
 * 2. Deterministic runtime: TZ=UTC, NODE_ENV=test.
 * 3. Restored env + cleared mocks after each test.
 */

import { afterAll, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Task lists default to `~/.coderix/tasks`. Redirect every test file at a
 * throwaway directory so a test run never reads or writes the developer's real
 * task store — previously the task-store tests created tasks in the shared
 * `default` list, which the CLI's Task panel then surfaced at startup.
 */
const testTasksDir = mkdtempSync(join(tmpdir(), 'coderix-tasks-'));
process.env.CODERIX_TASKS_DIR = testTasksDir;

afterAll(() => {
  rmSync(testTasksDir, { recursive: true, force: true });
});

const CREDENTIAL_SUFFIXES = [
  '_API_KEY', '_TOKEN', '_SECRET', '_PASSWORD', '_CREDENTIALS',
  '_ACCESS_KEY', '_SECRET_ACCESS_KEY', '_PRIVATE_KEY',
  '_OAUTH_TOKEN', '_ENCRYPT_KEY', '_APP_SECRET', '_CLIENT_SECRET',
];

const CREDENTIAL_NAMES = new Set([
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'DEEPSEEK_API_KEY',
  'GITHUB_TOKEN', 'GH_TOKEN',
]);

function looksLikeCredential(name: string): boolean {
  if (CREDENTIAL_NAMES.has(name)) return true;
  return CREDENTIAL_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

const BEHAVIORAL_VARS = new Set(['NODE_ENV']);

const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const [name, value] of Object.entries(process.env)) {
    if (looksLikeCredential(name) || BEHAVIORAL_VARS.has(name)) {
      if (!(name in originalEnv)) originalEnv[name] = value;
      delete process.env[name];
    }
  }

  process.env.TZ = 'UTC';
  if (!('NODE_ENV' in originalEnv)) originalEnv['NODE_ENV'] = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';

  vi.useRealTimers();
});

afterEach(() => {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const key of Object.keys(originalEnv)) delete originalEnv[key];

  vi.clearAllMocks();
  vi.restoreAllMocks();
});
