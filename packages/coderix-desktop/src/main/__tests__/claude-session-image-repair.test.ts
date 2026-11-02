import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  encodeClaudeProjectDir,
  findClaudeSessionFile,
  isUnsupportedImageApiError,
  repairInvalidImagesInSessionFile,
} from '../claude-session-image-repair.js';

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TRUNCATED_PNG = Buffer.from(PNG_1X1, 'base64')
  .subarray(0, 40)
  .toString('base64');

let dir: string;

function sessionLine(type: string, content: unknown): string {
  return JSON.stringify({ type, message: { role: type, content } });
}

function imageResult(toolUseId: string, data: string): string {
  return sessionLine('user', [
    {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
      ],
    },
  ]);
}

function parsedLine(raw: string, index: number): any {
  return JSON.parse(raw.split('\n')[index]);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coderix-image-repair-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('claude-session-image-repair', () => {
  it('replaces only corrupt image blocks and keeps tool pairing', () => {
    const file = join(dir, 'session.jsonl');
    const original = [
      sessionLine('assistant', [
        { type: 'tool_use', id: 'good', name: 'Read', input: { file_path: 'a.png' } },
        { type: 'tool_use', id: 'bad', name: 'Read', input: { file_path: 'b.png' } },
      ]),
      imageResult('good', PNG_1X1),
      imageResult('bad', TRUNCATED_PNG),
      JSON.stringify({ type: 'last-prompt', lastPrompt: 'continue' }),
    ].join('\n');
    writeFileSync(file, original, 'utf-8');

    const result = repairInvalidImagesInSessionFile(file);
    expect(result.repaired).toBe(1);
    expect(result.backupPath && existsSync(result.backupPath)).toBe(true);
    expect(readFileSync(result.backupPath!, 'utf-8')).toBe(original);

    const repaired = readFileSync(file, 'utf-8');
    const good = parsedLine(repaired, 1).message.content[0];
    const bad = parsedLine(repaired, 2).message.content[0];

    // The valid image survives untouched.
    expect(good.content[0].type).toBe('image');
    expect(good.tool_use_id).toBe('good');

    // The corrupt one becomes text, but the tool_result/tool_use pairing and id
    // stay intact so the transcript remains replayable.
    expect(bad.tool_use_id).toBe('bad');
    expect(bad.content[0].type).toBe('text');
    expect(bad.content[0].text).toContain('损坏');

    // Idempotent: nothing left to repair.
    expect(repairInvalidImagesInSessionFile(file).repaired).toBe(0);
  });

  it('finds a session under CLAUDE_CONFIG_DIR using the encoded project dir', () => {
    const previous = process.env.CLAUDE_CONFIG_DIR;
    const configDir = join(dir, 'claude');
    const cwd = '/Users/someone/Documents/demo-app';
    const projectDir = join(configDir, 'projects', encodeClaudeProjectDir(cwd));
    mkdirSync(projectDir, { recursive: true });
    const file = join(projectDir, 'abc-123.jsonl');
    writeFileSync(file, '', 'utf-8');
    process.env.CLAUDE_CONFIG_DIR = configDir;
    try {
      expect(encodeClaudeProjectDir(cwd)).toBe('-Users-someone-Documents-demo-app');
      expect(findClaudeSessionFile('abc-123', cwd)).toBe(file);
      expect(findClaudeSessionFile('abc-123')).toBe(file);
      expect(findClaudeSessionFile('../etc/passwd', cwd)).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });

  it('recognises the provider error that means a replayed image is invalid', () => {
    expect(
      isUnsupportedImageApiError(
        'API Error: 400 messages.374.content.1.tool_result.image[0]: You have uploaded an unsupported image. Please make sure your image is valid and has one of the following formats: webp, png, jpeg, and gif. (request_id: 1c3b4170)',
      ),
    ).toBe(true);
    expect(isUnsupportedImageApiError('API Error: 400 max_tokens exceeded')).toBe(false);
    expect(isUnsupportedImageApiError('rate limit exceeded')).toBe(false);
  });
});
