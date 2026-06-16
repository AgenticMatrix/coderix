import type { SlashCommand } from './types.js';
import { configCommands } from './commands/config.js';
import { coreCommands } from './commands/core.js';
import { doctorCommands } from './commands/doctor.js';
import { gitCommands } from './commands/git.js';
import { initCommands } from './commands/init.js';
import { skillCommands } from './commands/skill.js';
import { tasksCommand } from './commands/tasks.js';

export const SLASH_COMMANDS: SlashCommand[] = [
  ...configCommands,
  ...coreCommands,
  ...doctorCommands,
  ...gitCommands,
  ...initCommands,
  ...skillCommands,
  tasksCommand,
];

const byName = new Map<string, SlashCommand>(
  SLASH_COMMANDS.flatMap(
    (cmd) => [cmd.name, ...(cmd.aliases ?? [])].map((name) => [name.toLowerCase(), cmd] as const),
  ),
);

/** Look up a slash command by name. Returns undefined if not found. */
export function findSlashCommand(name: string): SlashCommand | undefined {
  return byName.get(name.toLowerCase());
}

/** All registered command names (for help display). */
export function listCommandNames(): string[] {
  return [...new Set(SLASH_COMMANDS.map((c) => c.name))].sort();
}
