/**
 * cad-control MCP — Tool Implementations
 *
 * Each handler drives the cad_harness `cad` skill CLI (or a local filesystem
 * scan) and returns an MCP `content` array. Subprocess calls use the resolved
 * CAD_PYTHON interpreter and run with `cwd` = the requested workspace dir, so
 * cwd-relative targets resolve exactly as the `cad` skill requires.
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  resolveCadSkillDir,
  resolveCadPython,
  hasCadSkill,
  buildViewerUrl,
} from './env.js';

export type CadControlToolResult = CallToolResult;

const CAD_EXTS = ['.step.py', '.step', '.stp', '.glb', '.stl', '.3mf'];

/** Dispatch a `tools/call` to its implementation. Unknown tools error. */
export async function handleCadControlToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<CadControlToolResult> {
  switch (name) {
    case 'list_artifacts':
      return handleListArtifacts(args);
    case 'render':
      return runScript('gen', args, buildGenArgs(args));
    case 'export':
      return runScript('export', args, buildExportArgs(args));
    case 'inspect':
      return runScript('inspect', args, buildInspectArgs(args));
    case 'snapshot':
      return runScript('snapshot', args, buildSnapshotArgs(args));
    case 'artifact_build':
      return runScript('artifact', args, buildArtifactArgs(args));
    case 'focus':
      return handleFocus(args);
    default:
      return text(`Unknown tool: ${name}`, true);
  }
}

function strArg(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

// ── Argument builders ──────────────────────────────────────────────────────

function buildGenArgs(args: Record<string, unknown>): string[] {
  const argv = [strArg(args, 'target') ?? '', '--json'];
  if (args.write === true) argv.push('--write');
  return argv;
}

function buildExportArgs(args: Record<string, unknown>): string[] {
  const format = strArg(args, 'format') ?? 'stl';
  const flag = format === '3mf' ? '--3mf' : `--${format}`;
  return [strArg(args, 'target') ?? '', flag, '--json'];
}

function buildInspectArgs(args: Record<string, unknown>): string[] {
  const command = strArg(args, 'command') ?? 'refs';
  return [command, strArg(args, 'target') ?? ''];
}

function buildSnapshotArgs(args: Record<string, unknown>): string[] {
  const argv = [strArg(args, 'target') ?? '', '--json'];
  const theme = strArg(args, 'theme');
  const display = strArg(args, 'display');
  if (theme) argv.push('--theme', theme);
  if (display) argv.push('--display', display);
  return argv;
}

function buildArtifactArgs(args: Record<string, unknown>): string[] {
  return [strArg(args, 'file') ?? ''];
}

// ── Subprocess runner ──────────────────────────────────────────────────────

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCommand(command: string, args: string[], cwd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let proc;
    try {
      proc = spawn(command, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CAD_PYTHON: command, CAD_SKILL_DIR: resolveCadSkillDir() },
      });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err) });
      return;
    }
    proc.stdout?.on('data', (c: Buffer) => (stdout += c.toString('utf-8')));
    proc.stderr?.on('data', (c: Buffer) => (stderr += c.toString('utf-8')));
    proc.once('error', (err) => resolve({ code: -1, stdout, stderr: String(err) }));
    proc.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function runScript(
  scriptName: string,
  args: Record<string, unknown>,
  argv: string[],
): Promise<CadControlToolResult> {
  const dir = strArg(args, 'dir');
  if (!dir) return text('Missing required argument "dir".', true);
  if (!hasCadSkill()) {
    return text('cad_harness not found — set CAD_HARNESS_PATH to the cad_harness checkout.', true);
  }
  const python = resolveCadPython();
  const scriptPath = path.join(resolveCadSkillDir(), 'scripts', scriptName);
  const { code, stdout, stderr } = await runCommand(python, [scriptPath, ...argv], dir);
  const body = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
  if (code !== 0) {
    return text(`scripts/${scriptName} exited ${code}\n${body || '(no output)'}`, true);
  }
  return text(body || stdout.trim() || 'ok');
}

// ── Handlers without a subprocess ─────────────────────────────────────────

function handleListArtifacts(args: Record<string, unknown>): CadControlToolResult {
  const dir = strArg(args, 'dir');
  if (!dir) return text('Missing required argument "dir".', true);
  if (!existsSync(dir)) return text(`Directory not found: ${dir}`, true);
  const files = collectCadFiles(dir);
  if (files.length === 0) return text('No CAD artifacts found.');
  return text(files.join('\n'));
}

function collectCadFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (CAD_EXTS.some((ext) => entry.name.endsWith(ext))) {
        out.push(path.relative(dir, full).split(path.sep).join('/'));
      }
    }
  };
  walk(dir);
  return out;
}

function handleFocus(args: Record<string, unknown>): CadControlToolResult {
  const dir = strArg(args, 'dir');
  const file = strArg(args, 'file');
  if (!dir || !file) return text('Missing required arguments "dir" and "file".', true);
  const abs = path.join(dir, file);
  if (!existsSync(abs)) return text(`Artifact not found: ${abs}`, true);
  return text(buildViewerUrl(dir, file));
}

function text(value: string, isError = false): CadControlToolResult {
  const result: CadControlToolResult = { content: [{ type: 'text', text: value }] };
  if (isError) result.isError = true;
  return result;
}
