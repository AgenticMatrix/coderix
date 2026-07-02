import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ToolExecutor } from '../types.js';

export const execute: ToolExecutor = async (input, options) => {
  const plan = (input.plan as string)?.trim();
  if (!plan) {
    return { content: 'No plan content provided.', isError: true };
  }

  // Ensure plan directory exists
  const plansDir = join(homedir(), '.claude', 'plans');
  if (!existsSync(plansDir)) {
    mkdirSync(plansDir, { recursive: true });
  }

  // Generate a unique plan filename
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `plan-${timestamp}.md`;
  const filePath = join(plansDir, filename);

  writeFileSync(filePath, plan, 'utf-8');

  // Switch out of plan mode
  if (options.setPermissionMode) {
    options.setPermissionMode('auto');
  }

  return {
    content: `Plan written to ${filePath}\n\nSwitched to auto mode — implementation can now begin.`,
    isError: false,
    metadata: { planFile: filePath },
  };
};
