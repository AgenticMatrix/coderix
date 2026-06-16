/**
 * Skill tool plugin — loads skills from ~/.coder/skills/.
 */

import { schema } from './schema.js';
import { execute } from './executor.js';
import { SkillRenderer } from './renderer.js';
import { SkillResultRenderer } from './result-renderer.js';
import type { ToolPlugin } from '../types.js';

const skillPlugin: ToolPlugin = {
  name: 'skill',
  schema,
  executor: execute,
  useRenderer: SkillRenderer,
  resultRenderer: SkillResultRenderer,
  paramSummary(input: Record<string, unknown>) {
    const name = input.skill as string | undefined;
    return name ? `/${name}` : 'skill';
  },
};

export default skillPlugin;
