#!/usr/bin/env node
/**
 * Coderix CLI wrapper.
 *
 * Launches the TypeScript entry point via tsx so TypeScript compilation
 * is not required at runtime. The entry point lives in @coderix/cli.
 *
 * Uses Node module resolution to find the tsx CLI entry point and spawns
 * it via `node` directly — avoids .bin shell-script / .cmd platform issues.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const mainPath = resolve(repoRoot, 'packages', 'coderix-cli', 'src', 'cli', 'main.tsx');
const tsconfigPath = resolve(repoRoot, 'packages', 'coderix-cli', 'tsconfig.json');

// Resolve tsx via Node module resolution (cross-platform, no .cmd / shell:true needed)
const repoRequire = createRequire(resolve(repoRoot, 'package.json'));
const tsxLoader = repoRequire.resolve('tsx');               // e.g. tsx/dist/loader.mjs
const tsxCli = resolve(tsxLoader, '..', 'cli.mjs');         // tsx/dist/cli.mjs

const child = spawn(process.execPath, [
  tsxCli,
  '--tsconfig',
  tsconfigPath,
  mainPath,
  ...process.argv.slice(2),
], {
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'production' },
});

child.on('exit', (code) => {
  process.exit(code ?? 1);
});
