import { schema } from './schema.js';
import { execute } from './executor.js';
import { AskUserQuestionRenderer } from './renderer.js';
import type { ToolPlugin } from '../types.js';

const askUserQuestionPlugin: ToolPlugin = {
  name: 'ask-user-question',
  schema,
  executor: execute,
  useRenderer: AskUserQuestionRenderer,
  paramSummary(input: Record<string, unknown>) {
    const questions = input.questions as
      | Array<{ header: string }>
      | undefined;
    return questions?.map((q) => q.header).join(', ') ?? 'ask';
  },
};

export default askUserQuestionPlugin;
