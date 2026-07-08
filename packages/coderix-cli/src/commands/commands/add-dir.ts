/**
 * /add-dir — Add directories to the workspace scope.
 *
 * Usage:
 *   /add-dir           List current workspace directories
 *   /add-dir <path>    Add a directory to the workspace
 */

import type { SlashCommand } from '../types.js';

export const addDirCommand: SlashCommand = {
  name: 'add-dir',
  aliases: ['adddir', 'adir'],
  help: 'Add directories to the workspace scope (/add-dir [path])',
  usage: '/add-dir [path]',

  run(arg, ctx) {
    const trimmed = arg.trim();

    if (!trimmed) {
      // List current workspace directories
      ctx.send(
        [
          'Read .coderix/settings.local.json in the project root.',
          '',
          'Find the key "workspace_directories" (it is a string array of directory paths).',
          'If the key does not exist or is empty, tell the user: "No workspace directories configured." and show the project root (from `process.cwd()`).',
          'If the key exists, list all directories with their absolute paths (resolve relative paths against the project root).',
          '',
          'Also show the project root directory and note that it is always in scope.',
        ].join('\n'),
      );
      return;
    }

    // Add one or more directories
    const paths = trimmed.split(/\s+/);

    ctx.send(
      [
        `Add the following director${paths.length > 1 ? 'ies' : 'y'} to the workspace scope:`,
        paths.map((p) => `  - ${p}`).join('\n'),
        '',
        'Follow these steps:',
        '',
        '1. Read .coderix/settings.local.json in the project root.',
        '   - If the file does not exist, create it with `{}`.',
        '',
        '2. For each directory path:',
        '   - Resolve it to an absolute path (relative paths are relative to the project root).',
        '   - Verify the directory exists (use Bash `ls -d <abs-path>` or `test -d <abs-path>`).',
        '   - If a directory does not exist, tell the user and skip it.',
        '',
        '3. Parse the JSON. Find or create the "workspace_directories" array.',
        '   - It should be an array of absolute path strings.',
        '   - Do NOT add duplicate paths (normalize: resolve symlinks, strip trailing slashes).',
        '',
        '4. For each new directory, add permission rules:',
        '   - Read the "permissions.allow" array from the same file.',
        '   - Add these patterns (use the absolute path):',
        `     Read(<path>/**)`,
        `     Write(<path>/**)`,
        `     Update(<path>/**)`,
        '   - Do NOT add duplicates.',
        '',
        '5. Write the updated JSON back with 2-space indentation.',
        '',
        '6. Confirm to the user: "Added <N> director(ies) to workspace. The agent can now access:"',
        '   - List each added directory.',
        '   - Remind the user: "Use /add-dir (no args) to see all workspace directories."',
      ].join('\n'),
    );
  },
};
