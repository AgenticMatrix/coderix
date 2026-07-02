import { schema } from './schema.js';
import { execute } from './executor.js';
import type { ToolPlugin } from '../types.js';

const askUserQuestionPlugin: ToolPlugin = {
  name: 'AskUserQuestion',
  schema,
  executor: execute,
  paramSummary(input: Record<string, unknown>) {
    const questions = input.questions as
      | Array<{ header: string }>
      | undefined;
    return questions?.map((q) => q.header).join(', ') ?? 'ask';
  },
};

export default askUserQuestionPlugin;
