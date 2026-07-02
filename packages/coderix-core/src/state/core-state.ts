/**
 * CoreState — Minimal engine-level state.
 *
 * Only fields the engine needs to function. Frontends extend this
 * with their own UI-specific state (ChatState, zustand stores, etc.).
 */

export interface CoreConfig {
  cwd: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  provider?: string;
  inputPrice: number;
  outputPrice: number;
  cacheReadPrice: number;
  maxContext: number;
}

export interface CoreState {
  sessionId: string;
  permissionMode: 'plan' | 'ask' | 'auto';
  model: string;
  config: CoreConfig;
}
