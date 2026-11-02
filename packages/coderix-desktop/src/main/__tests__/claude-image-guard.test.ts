import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildImageReadValidationHook } from '../claude-image-guard.js';

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TRUNCATED_PNG = Buffer.from(PNG_1X1, 'base64').subarray(0, 40);

let dir: string;
let hook: ReturnType<typeof buildImageReadValidationHook>;

function run(filePath: string, toolName = 'Read'): Promise<any> {
  return hook(
    {
      hook_event_name: 'PreToolUse',
      session_id: 's1',
      transcript_path: join(dir, 'transcript.jsonl'),
      cwd: dir,
      tool_name: toolName,
      tool_input: { file_path: filePath },
      tool_use_id: 't1',
    } as any,
    't1',
    { signal: new AbortController().signal },
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coderix-image-guard-'));
  hook = buildImageReadValidationHook(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('buildImageReadValidationHook', () => {
  it('allows a valid image on every read', async () => {
    writeFileSync(join(dir, 'ok.png'), Buffer.from(PNG_1X1, 'base64'));
    expect(await run('ok.png')).toEqual({});
    expect(await run(join(dir, 'ok.png'))).toEqual({});
  });

  it('denies a truncated image with an actionable reason', async () => {
    writeFileSync(join(dir, 'bad.png'), TRUNCATED_PNG);
    const result = await run('bad.png');
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput?.permissionDecisionReason).toContain('not a valid image/png');
    expect(result.hookSpecificOutput?.permissionDecisionReason).toContain('re-download');
  });

  it('reports a truncated JPEG as its declared media type', async () => {
    writeFileSync(
      join(dir, 'bad.jpg'),
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
    );
    const result = await run('bad.jpg');
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput?.permissionDecisionReason).toContain('image/jpeg');
  });

  it('leaves non-image files and other tools alone', async () => {
    writeFileSync(join(dir, 'notes.txt'), 'hello');
    expect(await run('notes.txt')).toEqual({});
    expect(await run('bad.png', 'Bash')).toEqual({});
    expect(await run('')).toEqual({});
  });

  it('defers to the Read tool when the file is missing', async () => {
    expect(await run('missing.png')).toEqual({});
  });
});
