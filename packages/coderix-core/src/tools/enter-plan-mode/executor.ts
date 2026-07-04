import type { ToolExecutor } from '../types.js';

export const execute: ToolExecutor = async (_input, options) => {
  if (options.setPermissionMode) {
    options.setPermissionMode('plan');

    const planFilePath = options.planModeState?.planFilePath ?? '~/.coderix/plans/';
    return {
      content:
        'Entered plan mode. You should now focus on exploring the codebase and designing an implementation approach.\n\n' +
        'In plan mode, you can:\n' +
        '1. Explore the codebase with read-only tools (read, glob, grep, bash)\n' +
        '2. Launch Explore agents to search the codebase in parallel\n' +
        '3. Launch Plan agents to design implementation strategies\n' +
        '4. Use AskUserQuestion to clarify the approach with the user\n' +
        '5. Write and edit the plan file at ' + planFilePath + '\n\n' +
        'Remember: DO NOT write or edit any files except the plan file. Detailed workflow instructions will follow.',
      isError: false,
      metadata: { planFilePath },
    };
  }

  return {
    content: 'Plan mode switch not available in this context.',
    isError: true,
  };
};
