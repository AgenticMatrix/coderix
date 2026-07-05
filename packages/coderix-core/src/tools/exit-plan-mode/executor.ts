import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ToolExecutor } from '../types.js';
import { getPlan } from '../../core/plan-files.js';

export const execute: ToolExecutor = async (input, options) => {
  const allowedPrompts = input.allowedPrompts as
    | Array<{ tool: string; prompt: string }>
    | undefined;

  // Always read plan from the plan file on disk
  let filePath = options.planModeState?.planFilePath ?? '';

  if (!filePath) {
    const plansDir = join(homedir(), '.coderix', 'plans');
    if (!existsSync(plansDir)) {
      mkdirSync(plansDir, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    filePath = join(plansDir, `plan-${timestamp}.md`);
  }

  const plan = getPlan(filePath);

  if (!plan) {
    return {
      content:
        'No plan file found. Please write your plan to the plan file first, then call ExitPlanMode.',
      isError: true,
    };
  }

  // Restore the pre-plan permission mode and mark plan mode as exited
  const restoreMode = options.planModeState?.prePlanMode ?? 'auto';

  if (options.setPermissionMode) {
    options.setPermissionMode(restoreMode);
  }

  if (options.planModeState) {
    options.planModeState.hasExitedPlanMode = true;
  }

  return {
    content:
      `Plan written to ${filePath}\n\n` +
      `Switched to ${restoreMode} mode — implementation can now begin.`,
    isError: false,
    metadata: {
      planFile: filePath,
      plan,
      allowedPrompts: allowedPrompts ?? null,
      restoreMode,
    },
  };
};
