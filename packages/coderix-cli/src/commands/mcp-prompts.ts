/**
 * MCP prompts → slash commands.
 *
 * After the McpManager has connected and discovered prompts, expose each one as
 * a `/mcp__<server>__<prompt>` slash command that renders the template via
 * `prompts/get` and sends the result as a user message.
 */

import type { McpManager } from '@coderix/core';
import {
  buildMcpPromptName,
  renderMcpPromptMessages,
  parsePromptArgs,
} from '@coderix/core';
import { registerDynamicCommands, unregisterDynamicCommands } from './registry.js';
import type { SlashCommand } from './types.js';

export const MCP_PROMPT_COMMAND_PREFIX = 'mcp__';

/**
 * Register one slash command per discovered MCP prompt.
 * Returns the command names that were registered.
 */
export function registerMcpPromptCommands(manager: McpManager): string[] {
  // Drop previous MCP-prompt commands so reconnect/reload doesn't leave stale ones.
  unregisterDynamicCommands(MCP_PROMPT_COMMAND_PREFIX);

  const commands: SlashCommand[] = manager.getAllPrompts().map((prompt) => {
    const fullName = buildMcpPromptName(prompt.serverName, prompt.name);
    const positionalKeys = (prompt.arguments ?? []).map((a) => a.name);
    const usageArgs = (prompt.arguments ?? [])
      .map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`))
      .join(' ');

    return {
      name: fullName,
      help: `MCP prompt (${prompt.serverName}): ${prompt.description ?? prompt.name}`,
      usage: usageArgs ? `/${fullName} ${usageArgs}` : `/${fullName}`,
      run(arg, ctx) {
        void (async () => {
          try {
            const args = parsePromptArgs(arg, positionalKeys);
            const result = await manager.getPrompt(prompt.serverName, prompt.name, args);
            if (!result) {
              ctx.sys(`Failed to render MCP prompt "${fullName}".`);
              return;
            }
            const text = renderMcpPromptMessages(result.messages);
            if (text) ctx.send(text);
            else ctx.sys(`MCP prompt "${fullName}" produced no content.`);
          } catch (err) {
            ctx.sys(`MCP prompt "${fullName}" error: ${(err as Error).message}`);
          }
        })();
      },
    };
  });

  registerDynamicCommands(commands);
  return commands.map((c) => c.name);
}
