/**
 * /skill — list available skills from ~/.coder/skills/
 *
 * Usage:
 *   /skill          List all installed skills
 *   /skill <name>   Show detail for a specific skill
 */

import { getSkillRegistry } from '../../skills/registry.js';
import type { SlashCommand } from '../types.js';

export const skillCommands: SlashCommand[] = [
  {
    name: 'skill',
    aliases: ['skills'],
    help: 'List available skills or show skill detail',
    usage: '/skill [name]',

    run(arg, ctx) {
      if (ctx.isStreaming) {
        ctx.sys('⚠  Wait for the current response to finish first.');
        return;
      }

      const registry = getSkillRegistry();
      if (registry.count === 0) {
        registry.loadFromDisk();
      }

      const skillName = arg.trim();

      // Detail mode: /skill <name>
      if (skillName) {
        const skill = registry.get(skillName);
        if (!skill) {
          const names = registry.getAll().map(s => s.metadata.name).join(', ');
          ctx.sys(
            `Skill "${skillName}" not found.\n\n` +
            `Installed skills: ${names || '(none)'}\n\n` +
            `Skills are stored in ~/.coder/skills/<name>/SKILL.md`,
          );
          return;
        }

        const meta = skill.metadata;
        const lines = [
          `── Skill: ${meta.name} ──`,
          '',
          `Description: ${meta.description}`,
          meta.version ? `Version:     ${meta.version}` : null,
          meta.author ? `Author:      ${meta.author}` : null,
          meta.triggers?.length
            ? `Triggers:    ${meta.triggers.join(', ')}`
            : null,
          meta.tools?.length
            ? `Tools:       ${meta.tools.join(', ')}`
            : null,
          meta.tags?.length
            ? `Tags:        ${meta.tags.join(', ')}`
            : null,
          `Used:        ${skill.usageCount} time(s)`,
          `Path:        ${skill.path}`,
          '',
          '── Body ──',
          skill.body,
          '',
          `Use "/skill" to see all skills. The agent loads a skill via the "skill" tool.`,
        ];
        ctx.sys(lines.filter(Boolean).join('\n'));
        return;
      }

      // List mode: /skill (no arg)
      const all = registry.getAll();

      if (all.length === 0) {
        ctx.sys(
          'No skills installed.\n\n' +
          'Skills are stored in ~/.coder/skills/<name>/SKILL.md\n' +
          'Bundled skills are copied on first run (see resources/skills/).\n' +
          'Run install.sh or restart CoderAgent to install bundled skills.',
        );
        return;
      }

      const lines: string[] = [
        `── Skills (${all.length}) ──`,
        '',
      ];

      for (const s of all) {
        const meta = s.metadata;
        lines.push(`  /${meta.name}`);
        lines.push(`      ${meta.description}`);
        if (meta.triggers?.length) {
          lines.push(`      triggers: ${meta.triggers.join(', ')}`);
        }
        lines.push('');
      }

      lines.push(`Use "/skill <name>" for details.`);
      lines.push(`Skills directory: ${registry.getSkillsDir()}`);

      ctx.sys(lines.join('\n'));
    },
  },
];
