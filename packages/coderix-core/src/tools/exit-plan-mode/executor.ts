import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ToolExecutor } from '../types.js';
import { getPlan } from '../../core/plan-files.js';

export const execute: ToolExecutor = async (input, options) => {
  const inputPlan = (input.plan as string)?.trim();
  const allowedPrompts = input.allowedPrompts as
    | Array<{ tool: string; prompt: string }>
    | undefined;

  // Resolve plan content — parameter takes priority, fall back to plan file
  let plan = inputPlan || null;
  let filePath = options.planModeState?.planFilePath ?? '';

  if (!plan) {
    // Read from the plan file on disk
    if (filePath) {
      plan = getPlan(filePath);
    }
    if (!plan) {
      return {
        content:
          'No plan content found. Please write your plan to the plan file first, ' +
          'or pass the plan content as a parameter.',
        isError: true,
      };
    }
  } else {
    // Plan was passed as parameter — write it to disk
    if (!filePath) {
      const plansDir = join(homedir(), '.coderix', 'plans');
      if (!existsSync(plansDir)) {
        mkdirSync(plansDir, { recursive: true });
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      filePath = join(plansDir, `plan-${timestamp}.md`);
    }
    writeFileSync(filePath, plan, 'utf-8');
  }

  // Restore the pre-plan permission mode, not hardcoded 'auto'
  const restoreMode = options.planModeState?.prePlanMode ?? 'auto';

  if (options.setPermissionMode) {
    options.setPermissionMode(restoreMode);
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
