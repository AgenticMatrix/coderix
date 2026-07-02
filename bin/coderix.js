#!/usr/bin/env node
/**
 * Coderix CLI wrapper.
 *
 * Launches the TypeScript entry point via tsx so TypeScript compilation
 * is not required at runtime.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mainPath = resolve(__dirname, '..', 'src', 'cli', 'main.tsx');
const tsxPath = resolve(__dirname, '..', 'node_modules', '.bin', 'tsx');
const tsconfigPath = resolve(__dirname, '..', 'tsconfig.json');

const child = spawn(tsxPath, [
  '--tsconfig',
  tsconfigPath,
  mainPath,
  ...process.argv.slice(2),
], {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code) => {
  process.exit(code ?? 1);
});
