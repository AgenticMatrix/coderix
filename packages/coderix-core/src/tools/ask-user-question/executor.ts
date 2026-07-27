import type { ToolExecutor } from '../types.js';

const PERMISSION_LEVEL_MAP: Record<string, string> = {
  low: 'low',
  medium: 'ask',
  high: 'ask',
};

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

  // Apply permission level — map to valid PermissionMode values
  const rawLevel = ((input as any).permissionLevel as string) ?? 'low';
  const mode = PERMISSION_LEVEL_MAP[rawLevel] ?? 'ask';
  if (options.setPermissionMode) {
    options.setPermissionMode(mode);
  }

  const lines = Object.entries(answers).map(
    ([header, value]) => `${header}: ${Array.isArray(value) ? value.join(', ') : value}`,
  );

  const modeLabel = mode === 'ask' ? 'all tools require approval' : 'write/update blocked';

  return {
    content: `${lines.join('\n')}\n\n[Permission: ${modeLabel}]`,
    isError: false,
    metadata: { answers, permissionLevel: mode },
  };
};
