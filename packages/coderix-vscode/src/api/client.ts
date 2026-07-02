/**
 * Minimal Anthropic client factory for the VSCode extension.
 * Mirrors @coderix/cli/src/api/client.ts but standalone.
 */
import Anthropic from '@anthropic-ai/sdk';

export interface VSCodeAppConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  provider?: string;
  inputPrice?: number;
  outputPrice?: number;
  cacheReadPrice?: number;
  maxContext?: number;
  currency?: string;
}

export function createClient(config: VSCodeAppConfig): Anthropic {
  return new Anthropic({
    baseURL: config.baseUrl,
    apiKey: config.apiKey,
  });
}
