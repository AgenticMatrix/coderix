/**
 * Skill tool executor — loads a skill by name from ~/.coder/skills/
 * and returns its full body as tool output so the LLM can follow
 * the skill's instructions.
 *
 * When a skill declares tools in its frontmatter, those tools are
 * dynamically registered before the skill body is returned, enabling
 * on-demand tool activation.
 */

import { getSkillRegistry } from '../../skills/registry.js';
import type { ToolExecutor } from '../types.js';

export const execute: ToolExecutor = async (input, _opts) => {
  const skillName = (input.skill as string)?.trim();
  if (!skillName) {
    return {
      content:
        'No skill name provided. Use one of the available skills listed in the system prompt.',
      isError: true,
    };
  }

  const registry = getSkillRegistry();

  // Ensure skills are loaded from disk
  if (registry.count === 0) {
    registry.loadFromDisk();
  }

  const skill = registry.get(skillName);
  if (!skill) {
    const available = registry
      .getAll()
      .map((s) => s.metadata.name)
      .join(', ');
    return {
      content: `Skill "${skillName}" not found. Available skills: ${available || '(none)'}`,
      isError: true,
    };
  }

  // Record usage
  registry.recordUsage(skillName);

  // Return the full skill body as instructions for the agent to follow
  return {
    content: `[Skill: **${skill.metadata.name}**]\n_${skill.metadata.description}_\n\n${skill.body}`,
    isError: false,
    metadata: {
      skillName,
      bodyLength: skill.body.length,
    },
  };
};
