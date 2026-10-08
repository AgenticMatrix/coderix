import type { SlashCommand } from './types.js';
import { configCommands } from './commands/config.js';
import { coreCommands } from './commands/core.js';
import { doctorCommands } from './commands/doctor.js';
import { gitCommands } from './commands/git.js';
import { initCommands } from './commands/init.js';
import { sessionCommands } from './commands/session.js';
import { skillCommands } from './commands/skill.js';
import { tasksCommand } from './commands/tasks.js';
import { mcpCommand } from './commands/mcp.js';
import { memoryCommand } from './commands/memory.js';
import { addDirCommand } from './commands/add-dir.js';

export const SLASH_COMMANDS: SlashCommand[] = [
  ...configCommands,
  ...coreCommands,
  ...doctorCommands,
  ...gitCommands,
  ...initCommands,
  ...sessionCommands,
  ...skillCommands,
  tasksCommand,
  mcpCommand,
  memoryCommand,
  addDirCommand,
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

/**
 * Register commands discovered at runtime (e.g. MCP prompt templates).
 * A command with an existing name is replaced in place; new ones are appended.
 * Safe to call repeatedly — the lookup map and list are read live.
 */
export function registerDynamicCommands(commands: SlashCommand[]): void {
  for (const cmd of commands) {
    const idx = SLASH_COMMANDS.findIndex(
      (c) => c.name.toLowerCase() === cmd.name.toLowerCase(),
    );
    if (idx >= 0) SLASH_COMMANDS[idx] = cmd;
    else SLASH_COMMANDS.push(cmd);

    for (const name of [cmd.name, ...(cmd.aliases ?? [])]) {
      byName.set(name.toLowerCase(), cmd);
    }
  }
}

/** Remove runtime-registered commands whose name starts with `prefix`. */
export function unregisterDynamicCommands(prefix: string): void {
  const lower = prefix.toLowerCase();
  for (let i = SLASH_COMMANDS.length - 1; i >= 0; i--) {
    if (SLASH_COMMANDS[i]!.name.toLowerCase().startsWith(lower)) {
      SLASH_COMMANDS.splice(i, 1);
    }
  }
  for (const [name, cmd] of [...byName.entries()]) {
    if (cmd.name.toLowerCase().startsWith(lower)) byName.delete(name);
  }
}
