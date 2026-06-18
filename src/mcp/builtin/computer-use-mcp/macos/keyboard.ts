/**
 * macOS Keyboard — osascript / AppleScript wrapper.
 *
 * Uses osascript to send keystrokes and key chords.
 * For complex key combos, falls back to AppleScript System Events.
 *
 * Key codes: https://eastmanreference.com/complete-list-of-applescript-key-codes
 */

import { execSync } from 'node:child_process';

// ── Key Code Map ──────────────────────────────────────────────────────────

const KEY_CODES: Record<string, number> = {
  // Letters
  a: 0, b: 11, c: 8, d: 2, e: 14, f: 3, g: 5, h: 4, i: 34,
  j: 38, k: 40, l: 37, m: 46, n: 45, o: 31, p: 35, q: 12,
  r: 15, s: 1, t: 17, u: 32, v: 9, w: 13, x: 7, y: 16, z: 6,
  // Numbers
  '0': 29, '1': 18, '2': 19, '3': 20, '4': 21, '5': 23,
  '6': 22, '7': 26, '8': 28, '9': 25,
  // Special
  enter: 36, return: 36,
  escape: 53, esc: 53,
  tab: 48,
  space: 49,
  backspace: 51, delete: 51,
  'delete_forward': 117,
  up: 126, down: 125, left: 123, right: 124,
  home: 115, end: 119,
  pageup: 116, pagedown: 121,
  // Function keys
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97,
  f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
  // Symbols
  '-': 27, '=': 24, '[': 33, ']': 30, '\\': 42,
  ';': 41, "'": 39, ',': 43, '.': 47, '/': 44,
  '`': 50,
};

const MODIFIER_MAP: Record<string, string> = {
  cmd: 'command down',
  meta: 'command down',
  command: 'command down',
  ctrl: 'control down',
  control: 'control down',
  alt: 'option down',
  option: 'option down',
  shift: 'shift down',
};

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Type text by simulating keystrokes.
 * Uses AppleScript "keystroke" for text input.
 */
export function typeText(text: string): void {
  // Escape AppleScript special characters
  const escaped = text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');

  const script = `tell application "System Events" to keystroke "${escaped}"`;

  execSync(`osascript -e '${script}'`, {
    timeout: 10_000,
    stdio: 'pipe',
  });
}

/**
 * Send a key combination (chord).
 * Example: "cmd+c", "ctrl+shift+t", "cmd+option+escape"
 */
export function sendKeyChord(chord: string, repeat: number = 1): void {
  for (let i = 0; i < repeat; i++) {
    const parts = chord.split('+').map((s) => s.trim().toLowerCase());
    if (parts.length === 0) return;

    const mainKey = parts.pop()!;
    const modifiers = parts
      .map((m) => MODIFIER_MAP[m])
      .filter(Boolean) as string[];

    const keyCode = KEY_CODES[mainKey];
    if (keyCode === undefined) {
      // Fallback: use keystroke for unknown keys
      const modPart = modifiers.length > 0 ? modifiers.join(', ') + ', ' : '';
      const script = `tell application "System Events" to keystroke "${mainKey}"${modPart ? ` using {${modPart}}` : ''}`;
      execSync(`osascript -e '${script}'`, {
        timeout: 5000,
        stdio: 'pipe',
      });
      continue;
    }

    // Use key code for precise control
    const usingStr = modifiers.length > 0
      ? ` using {${modifiers.join(', ')}}`
      : '';

    const script = `tell application "System Events" to key code ${keyCode}${usingStr}`;

    execSync(`osascript -e '${script}'`, {
      timeout: 5000,
      stdio: 'pipe',
    });
  }
}

/**
 * Press a key down (without releasing).
 */
export function keyDown(chord: string): void {
  const parts = chord.split('+').map((s) => s.trim().toLowerCase());
  const mainKey = parts.pop()!;
  const modifiers = parts
    .map((m) => MODIFIER_MAP[m])
    .filter(Boolean) as string[];

  const keyCode = KEY_CODES[mainKey];
  if (keyCode === undefined) {
    throw new Error(`Unknown key: "${mainKey}"`);
  }

  const usingStr = modifiers.length > 0
    ? ` using {${modifiers.join(', ')}}`
    : '';

  execSync(
    `osascript -e 'tell application "System Events" to key down ${keyCode}${usingStr}'`,
    { timeout: 5000, stdio: 'pipe' },
  );
}

/**
 * Release a previously pressed key.
 */
export function keyUp(chord: string): void {
  const parts = chord.split('+').map((s) => s.trim().toLowerCase());
  const mainKey = parts.pop()!;
  const modifiers = parts
    .map((m) => MODIFIER_MAP[m])
    .filter(Boolean) as string[];

  const keyCode = KEY_CODES[mainKey];
  if (keyCode === undefined) {
    throw new Error(`Unknown key: "${mainKey}"`);
  }

  const usingStr = modifiers.length > 0
    ? ` using {${modifiers.join(', ')}}`
    : '';

  execSync(
    `osascript -e 'tell application "System Events" to key up ${keyCode}${usingStr}'`,
    { timeout: 5000, stdio: 'pipe' },
  );
}
