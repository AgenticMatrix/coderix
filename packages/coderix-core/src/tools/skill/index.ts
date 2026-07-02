/**
 * Skill tool plugin — loads skills from ~/.coderix/skills/.
 */

import { schema } from './schema.js';
import { execute } from './executor.js';
import type { ToolPlugin } from '../types.js';

const skillPlugin: ToolPlugin = {
  name: 'skill',
  schema,
  executor: execute,
  paramSummary(input: Record<string, unknown>) {
    const name = input.skill as string | undefined;
    return name ? `/${name}` : 'skill';
  },
};

export default skillPlugin;
