import type { SlashCommand } from '../types.js';

const streamingBusy = 'Agent is currently streaming. Wait for it to finish, then try again.';

export const initCommands: SlashCommand[] = [
  {
    name: 'init',
    help: 'initialize a CODER.md file in the project root',
    usage: '/init',
    run: (_arg, ctx) => {
      if (ctx.isStreaming) {
        ctx.sys(streamingBusy);
        return;
      }

      ctx.send(
        [
          'Initialize a CODER.md file in the current project root directory. Follow these steps:',
          '',
          '--- STEP 1: Explore project structure ---',
          '- Read package.json to extract: project name, description, scripts (build, test, start, lint), dependencies',
          '- Read tsconfig.json (if present) to understand TypeScript configuration',
          '- Read README.md (if present) to understand the project purpose',
          '- List the top-level directory structure (src/, tests/, config/, etc.)',
          '- List key files in src/ to understand the module layout',
          '',
          '--- STEP 2: Analyze coding conventions ---',
          '- Check the main entry point (often src/index.ts or src/main.ts)',
          '- Observe import style: does the project use ESM (import/export) or CJS?',
          '- Check for linting/formatting configs: .eslintrc, .prettierrc, .editorconfig',
          '- Note how modules are organized: by feature? by layer?',
          '- Identify the testing framework (jest, vitest, mocha) from package.json devDependencies',
          '- Note any existing documentation patterns (JSDoc, comments)',
          '',
          '--- STEP 3: Generate CODER.md ---',
          'Create the file at ./CODER.md (project root) with the following sections. Use the exact headers shown:',
          '',
          '# Project Overview',
          '- 2-3 sentence description of what this project does, derived from package.json and README',
          '',
          '# Build Commands',
          '- List each npm script from package.json with its command and a 1-line description',
          '- Example: `npm run build` — Compile TypeScript to dist/',
          '- Example: `npm test` — Run the test suite',
          '',
          '# Project Structure',
          '- List key directories and their purpose',
          '- Example: `src/commands/` — Slash command definitions and registry',
          '',
          '# Coding Conventions',
          '- TypeScript strictness level and module system (ESM/CJS)',
          '- Import conventions (path aliases, relative paths)',
          '- Naming: functions (camelCase), types/interfaces (PascalCase), files (kebab-case or PascalCase)',
          '- Error handling patterns observed',
          '- Any other observable conventions',
          '',
          '# Testing',
          '- How to run tests: the exact command',
          '- Where test files live',
          '- Test framework and any conventions (describe/it blocks, naming)',
          '',
          '# Architecture Notes',
          '- Key design patterns used in the project',
          '- Important modules and their responsibilities',
          '- Any notable abstractions or utilities',
          '',
          '--- STEP 4: Confirm ---',
          '- After writing CODER.md, show a brief summary of what was generated (section list and file path)',
          '- If CODER.md already exists, ask whether to overwrite or merge before proceeding',
        ].join('\n'),
      );
    },
  },
];
