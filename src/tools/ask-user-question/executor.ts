import type { ToolExecutor } from '../types.js';

export const execute: ToolExecutor = async (input, options) => {
  const answers = (input as any).answers as
    | Record<string, string | string[]>
    | undefined;

  if (!answers || Object.keys(answers).length === 0) {
    return {
      content: 'No answers provided.',
      isError: true,
    };
  }

  // Apply permission level
  const level = ((input as any).permissionLevel as string) ?? 'low';
  if (options.setPermissionMode) {
    options.setPermissionMode(level);
  }

  const lines = Object.entries(answers).map(
    ([header, value]) => `${header}: ${Array.isArray(value) ? value.join(', ') : value}`,
  );

  const modeLabel = level === 'high' ? 'all tools blocked' : 'write/edit blocked';

  return {
    content: `${lines.join('\n')}\n\n[Permission: ${modeLabel}]`,
    isError: false,
    metadata: { answers, permissionLevel: level },
  };
};
