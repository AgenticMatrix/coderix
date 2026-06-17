import type { ToolExecutor } from '../types.js';

export const execute: ToolExecutor = async (_input, options) => {
  if (options.setPermissionMode) {
    options.setPermissionMode('plan');
    return {
      content:
        'Switched to plan mode. Only safe (read-only) tools are now available. ' +
        'Use read/glob/grep/web-fetch/web-search to explore the codebase and design your approach. ' +
        'When ready to implement, use exit-plan-mode to write your plan and request approval.',
      isError: false,
    };
  }

  return {
    content: 'Plan mode switch not available in this context.',
    isError: true,
  };
};
