import type { ToolExecutor } from '../types.js';

/**
 * The actual blocking/pausing happens in query.ts BEFORE this executor runs.
 * When query.ts detects an `ask-user-question` tool call, it yields a
 * `question_required` event and awaits the user's answer. The answer is
 * then merged into `input.answers` before this executor is called.
 *
 * So this executor just returns the user's answers as the tool result.
 */
export const execute: ToolExecutor = async (input, _opts) => {
  const answers = (input as any).answers as
    | Record<string, string | string[]>
    | undefined;

  if (!answers || Object.keys(answers).length === 0) {
    return {
      content: 'No answers provided.',
      isError: true,
    };
  }

  const lines = Object.entries(answers).map(
    ([header, value]) => `${header}: ${Array.isArray(value) ? value.join(', ') : value}`,
  );

  return {
    content: lines.join('\n'),
    isError: false,
    metadata: { answers },
  };
};
