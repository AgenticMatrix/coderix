import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolExecutor } from '../types.js';

const execAsync = promisify(execCb);

export const execute: ToolExecutor = async (input, opts) => {
  const pattern = input.pattern as string;
  const searchPath = (input.path as string) ?? opts.cwd;
  const globPattern = input.glob as string | undefined;
  const outputMode = (input.output_mode as string) ?? 'files_with_matches';

  if (!pattern) return { content: 'Error: pattern is required', isError: true };

  const args: string[] = ['--no-heading', '--line-number', '--color=never'];
  if (globPattern) args.push('--glob', globPattern);
  if (outputMode === 'files_with_matches') args.push('-l');
  else if (outputMode === 'count') args.push('-c');

  const argsStr = args.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(' ');
  const cmd = `rg ${argsStr} "${pattern.replace(/"/g, '\\"')}" "${searchPath}"`;

  try {
    const { stdout, stderr } = await execAsync(cmd, {
      cwd: opts.cwd,
      maxBuffer: opts.maxOutput,
      encoding: 'utf-8',
    });
    const trimmed = (stdout || stderr || '').trim();
    if (trimmed.length > opts.maxOutput) {
      return {
        content: trimmed.slice(0, opts.maxOutput) + '\n... (output truncated)',
        isError: false,
      };
    }
    return { content: trimmed || '(no matches)', isError: false };
  } catch (err) {
    const stderrMsg = (err as { stderr?: string }).stderr ?? '';
    const stdoutMsg = (err as { stdout?: string }).stdout ?? '';
    if (stderrMsg.includes('No such file') || stderrMsg.includes('error')) {
      return { content: `Error: ${stderrMsg}`, isError: true };
    }
    return { content: stdoutMsg.trim() || '(no matches)', isError: false };
  }
};
