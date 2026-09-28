/**
 * Skill tool executor — loads a skill by name from ~/.coderix/skills/
 * and returns its full body as tool output so the LLM can follow
 * the skill's instructions.
 *
 * When a skill declares tools in its frontmatter, those tools are
 * dynamically registered before the skill body is returned, enabling
 * on-demand tool activation.
 */

import { getSkillRegistry } from '../../skills/registry.js';
import type { ToolExecutor } from '../types.js';
import { dirname } from 'node:path';

/**
 * Toolchain env vars surfaced to the model when a skill is loaded, so skills
 * whose launchers shell out to external toolchains (e.g. the `cad` skill's
 * `scripts/gen` → build123d/OCP) can reference the right interpreter/paths.
 * Only vars that are actually set are reported.
 */
const TOOLCHAIN_ENV_VARS = ['CAD_PYTHON', 'CAD_SKILL_DIR', 'CAD_VIEWER_DIR', 'STEP_PARTS_DIR'] as const;

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

  // Return the full skill body as instructions for the agent to follow.
  // Include the skill's directory so the model can resolve relative paths in
  // the body (e.g. a skill's own `scripts/...` launchers), plus any toolchain
  // env vars the skill's scripts depend on.
  const skillDir = dirname(skill.path);
  const envHints = TOOLCHAIN_ENV_VARS.filter((k) => process.env[k]).map(
    (k) => `${k}=${process.env[k]}`,
  );
  const envLine = envHints.length > 0 ? `\n_Environment: ${envHints.join(', ')}_\n` : '';

  return {
    content: `[Skill: **${skill.metadata.name}**]\n_${skill.metadata.description}_\n\n_Skill directory: \`${skillDir}\`_${envLine}\n${skill.body}`,
    isError: false,
    metadata: {
      skillName,
      bodyLength: skill.body.length,
    },
  };
};
