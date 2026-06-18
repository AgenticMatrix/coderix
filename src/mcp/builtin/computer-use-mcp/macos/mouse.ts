/**
 * macOS Mouse — cliclick wrapper.
 *
 * cliclick is a command-line tool for mouse control on macOS.
 * Install: brew install cliclick
 *
 * Actions:
 *   c:x,y   — click at point
 *   dc:x,y  — double-click
 *   tc:x,y  — triple-click
 *   rc:x,y  — right-click
 *   mc:x,y  — middle-click
 *   m:x,y   — move to point
 *   dd:x,y  — drag start (press down)
 *   du:x,y  — drag end (release)
 *   p       — get current position
 */

import { execSync } from 'node:child_process';

// ── Helpers ──────────────────────────────────────────────────────────────

function cli(args: string, timeoutMs: number = 5000): string {
  return execSync(`cliclick ${args}`, {
    timeout: timeoutMs,
    stdio: 'pipe',
    encoding: 'utf-8',
  }).trim();
}

// ── Public API ───────────────────────────────────────────────────────────

export function leftClick(x: number, y: number): void {
  cli(`c:${Math.round(x)},${Math.round(y)}`);
}

export function doubleClick(x: number, y: number): void {
  cli(`dc:${Math.round(x)},${Math.round(y)}`);
}

export function tripleClick(x: number, y: number): void {
  cli(`tc:${Math.round(x)},${Math.round(y)}`);
}

export function rightClick(x: number, y: number): void {
  cli(`rc:${Math.round(x)},${Math.round(y)}`);
}

export function middleClick(x: number, y: number): void {
  cli(`mc:${Math.round(x)},${Math.round(y)}`);
}

export function moveTo(x: number, y: number): void {
  cli(`m:${Math.round(x)},${Math.round(y)}`);
}

export function dragStart(x: number, y: number): void {
  cli(`dd:${Math.round(x)},${Math.round(y)}`);
}

export function dragEnd(x: number, y: number): void {
  cli(`du:${Math.round(x)},${Math.round(y)}`);
}

export function getCursorPosition(): { x: number; y: number } {
  const pos = cli('p');
  const match = pos.match(/(\d+),\s*(\d+)/);
  if (match) {
    return { x: parseInt(match[1]!, 10), y: parseInt(match[2]!, 10) };
  }
  throw new Error(`Could not parse cursor position: ${pos}`);
}

/** Click at coordinate, optionally holding modifier keys. */
export function clickWithModifiers(
  x: number,
  y: number,
  modifiers: string[] = [],
  button: 'left' | 'right' | 'middle' = 'left',
): void {
  // cliclick supports modifier keys with kd: (key down) and ku: (key up)
  const modKeys: string[] = [];
  for (const mod of modifiers) {
    const key = mod.toLowerCase();
    if (key === 'cmd' || key === 'meta' || key === 'command') modKeys.push('cmd');
    else if (key === 'ctrl' || key === 'control') modKeys.push('ctrl');
    else if (key === 'alt' || key === 'option') modKeys.push('alt');
    else if (key === 'shift') modKeys.push('shift');
  }

  const actionMap: Record<string, string> = {
    left: 'c',
    right: 'rc',
    middle: 'mc',
  };

  const action = actionMap[button] ?? 'c';
  const clicks: string[] = [];

  // Press modifiers
  for (const mod of modKeys) {
    clicks.push(`kd:${mod}`);
  }

  clicks.push(`${action}:${Math.round(x)},${Math.round(y)}`);

  // Release modifiers (reverse order)
  for (const mod of modKeys.reverse()) {
    clicks.push(`ku:${mod}`);
  }

  cli(clicks.join(' '));
}
