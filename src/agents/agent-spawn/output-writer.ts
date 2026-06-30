import { homedir } from 'os';
import { join } from 'path';
import { mkdir, writeFile } from 'fs/promises';
import type { Message } from '../../core/types.js';

const OUTPUT_BASE = join(homedir(), '.coderix', 'agent-outputs');

export interface AgentOutputData {
  status: string;
  agentType: string;
  prompt: string;
  turnCount: number;
  toolCount: number;
  elapsed: number;
  result?: string;
  error?: string;
  transcript?: Message[];
}

export async function writeAgentOutput(
  sessionId: string,
  agentId: string,
  data: AgentOutputData,
): Promise<string> {
  const dir = join(OUTPUT_BASE, sessionId);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `${agentId}.json`);
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  return filePath;
}
