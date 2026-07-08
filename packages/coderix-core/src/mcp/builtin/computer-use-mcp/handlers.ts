/**
 * Computer Use MCP — Tool Handlers
 *
 * Dispatches MCP tool calls to macOS native functions.
 * Manages session state: last screenshot, allowed apps, grant flags.
 */

import { execSync } from 'node:child_process';
import {
  takeScreenshot,
  cropScreenshot,
  saveScreenshot as saveScreenshotToDisk,
} from './macos/screenshot.js';
import {
  leftClick,
  doubleClick,
  tripleClick,
  rightClick,
  middleClick,
  moveTo,
  dragStart,
  dragEnd,
  getCursorPosition,
  clickWithModifiers,
} from './macos/mouse.js';
import {
  typeText,
  sendKeyChord,
  keyDown,
  keyUp,
} from './macos/keyboard.js';
import {
  readClipboard as readPasteboard,
  writeClipboard as writePasteboard,
} from './macos/clipboard.js';
import type {
  RequestAccessParams,
  ScreenshotParams,
  ZoomParams,
  ClickParams,
  TypeParams,
  KeyParams,
  ScrollParams,
  DragParams,
  MouseMoveParams,
  OpenAppParams,
  SwitchDisplayParams,
  WriteClipboardParams,
  WaitParams,
  HoldKeyParams,
  ComputerBatchParams,
  BatchAction,
  AllowedApp,
  GrantFlags,
  ScreenshotResult,
} from './types.js';

// ── Session State ──────────────────────────────────────────────────────

interface SessionState {
  allowedApps: AllowedApp[];
  grantFlags: GrantFlags;
  lastScreenshot: ScreenshotResult | null;
  selectedDisplay: string | null;
  accessRequested: boolean;
}

const state: SessionState = {
  allowedApps: [],
  grantFlags: {
    clipboardRead: false,
    clipboardWrite: false,
    systemKeyCombos: false,
  },
  lastScreenshot: null,
  selectedDisplay: null,
  accessRequested: false,
};

function resetState(): void {
  state.allowedApps = [];
  state.grantFlags = { clipboardRead: false, clipboardWrite: false, systemKeyCombos: false };
  state.lastScreenshot = null;
  state.selectedDisplay = null;
  state.accessRequested = false;
}

// ── Main Handler ────────────────────────────────────────────────────────

export async function handleComputerToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
  // Computer Use tools are macOS-only for now
  if (process.platform !== 'darwin') {
    return [{
      type: 'text',
      text: 'Error: Computer Use tools are currently only supported on macOS. Windows and Linux support is planned for a future release.',
    }];
  }

  // Most tools require access first
  const requiresAccess = !['request_access', 'list_granted_applications'].includes(name);
  if (requiresAccess && !state.accessRequested) {
    return [{
      type: 'text',
      text: 'Access not yet requested. Call request_access first with the list of apps you plan to use.',
    }];
  }

  switch (name) {
    case 'request_access':
      return handleRequestAccess(args as unknown as RequestAccessParams);

    case 'screenshot':
      return handleScreenshot(args as unknown as ScreenshotParams);

    case 'zoom':
      return handleZoom(args as unknown as ZoomParams);

    case 'left_click':
      return handleLeftClick(args as unknown as ClickParams);

    case 'double_click':
      return handleDoubleClick(args as unknown as ClickParams);

    case 'triple_click':
      return handleTripleClick(args as unknown as ClickParams);

    case 'right_click':
      return handleRightClick(args as unknown as ClickParams);

    case 'middle_click':
      return handleMiddleClick(args as unknown as ClickParams);

    case 'type':
      return handleType(args as unknown as TypeParams);

    case 'key':
      return handleKey(args as unknown as KeyParams);

    case 'scroll':
      return handleScroll(args as unknown as ScrollParams);

    case 'left_click_drag':
      return handleDrag(args as unknown as DragParams);

    case 'mouse_move':
      return handleMouseMove(args as unknown as MouseMoveParams);

    case 'open_application':
      return handleOpenApp(args as unknown as OpenAppParams);

    case 'switch_display':
      return handleSwitchDisplay(args as unknown as SwitchDisplayParams);

    case 'list_granted_applications':
      return handleListGranted();

    case 'read_clipboard':
      return handleReadClipboard();

    case 'write_clipboard':
      return handleWriteClipboard(args as unknown as WriteClipboardParams);

    case 'wait':
      return handleWait(args as unknown as WaitParams);

    case 'cursor_position':
      return handleCursorPosition();

    case 'hold_key':
      return handleHoldKey(args as unknown as HoldKeyParams);

    case 'left_mouse_down':
      return handleMouseDown();

    case 'left_mouse_up':
      return handleMouseUp();

    case 'computer_batch':
      return handleBatch(args as unknown as ComputerBatchParams);

    default:
      return [{ type: 'text', text: `Unknown Computer Use tool: ${name}` }];
  }
}

// ── Individual Handlers ─────────────────────────────────────────────────

async function handleRequestAccess(args: RequestAccessParams):
  Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
  state.allowedApps = args.apps.map((name) => ({
    name,
    granted: true, // Phase 1: always grant
  }));

  if (args.clipboardRead) state.grantFlags.clipboardRead = true;
  if (args.clipboardWrite) state.grantFlags.clipboardWrite = true;
  if (args.systemKeyCombos) state.grantFlags.systemKeyCombos = true;

  state.accessRequested = true;

  const result = {
    granted: args.apps,
    denied: [] as string[],
    reason: args.reason,
    grantFlags: state.grantFlags,
    message: 'Access granted. You can now use Computer Use tools.',
  };

  return [{ type: 'text', text: JSON.stringify(result, null, 2) }];
}

async function handleScreenshot(args: ScreenshotParams):
  Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
  const result = takeScreenshot();
  state.lastScreenshot = result;

  // Get display info
  let displayNote = '';
  try {
    const displays = execSync('system_profiler SPDisplaysDataType 2>/dev/null | grep "Resolution"', {
      timeout: 5000, stdio: 'pipe', encoding: 'utf-8',
    }).trim();
    if (displays) displayNote = `\nDisplays: ${displays}`;
  } catch { /* ignore */ }

  if (args.save_to_disk) {
    const path = saveScreenshotToDisk(result.data);
    displayNote += `\nSaved to: ${path}`;
  }

  return [
    {
      type: 'image',
      data: result.data,
      mimeType: 'image/png',
    },
    {
      type: 'text',
      text: `Screenshot: ${result.width}x${result.height}px (PNG base64, pixels coordinate mode)${displayNote}`,
    },
  ];
}

async function handleZoom(args: ZoomParams):
  Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
  if (!state.lastScreenshot) {
    throw new Error('No screenshot available for zoom. Take a screenshot first.');
  }

  const [x0, y0, x1, y1] = args.region;
  const region = {
    x: Math.round(x0!),
    y: Math.round(y0!),
    width: Math.round(x1! - x0!),
    height: Math.round(y1! - y0!),
  };

  if (region.width <= 0 || region.height <= 0) {
    throw new Error(`Invalid region: width=${region.width}, height=${region.height}`);
  }

  const result = cropScreenshot(state.lastScreenshot.data, region);

  if (args.save_to_disk) {
    saveScreenshotToDisk(result.data);
  }

  return [
    {
      type: 'image',
      data: result.data,
      mimeType: 'image/png',
    },
    {
      type: 'text',
      text: `Zoomed region [${region.x}, ${region.y}, ${region.x + region.width}, ${region.y + region.height}]: ${result.width}x${result.height}px. ` +
        `Coordinates in this image are relative to the region (x=${region.x}, y=${region.y} in screen pixels).`,
    },
  ];
}

async function handleLeftClick(args: ClickParams):
  Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
  const [x, y] = args.coordinate;

  if (args.text) {
    const modifiers = args.text.split('+').map((s) => s.trim()).filter(Boolean);
    clickWithModifiers(x!, y!, modifiers, 'left');
  } else {
    leftClick(x!, y!);
  }

  return [{ type: 'text', text: `Left-clicked at [${x}, ${y}]` }];
}

async function handleDoubleClick(args: ClickParams):
  Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
  const [x, y] = args.coordinate;
  doubleClick(x!, y!);
  return [{ type: 'text', text: `Double-clicked at [${x}, ${y}]` }];
}

async function handleTripleClick(args: ClickParams):
  Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
  const [x, y] = args.coordinate;
  tripleClick(x!, y!);
  return [{ type: 'text', text: `Triple-clicked at [${x}, ${y}]` }];
}

async function handleRightClick(args: ClickParams):
  Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
  const [x, y] = args.coordinate;
  rightClick(x!, y!);
  return [{ type: 'text', text: `Right-clicked at [${x}, ${y}]` }];
}

async function handleMiddleClick(args: ClickParams):
  Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
  const [x, y] = args.coordinate;
  middleClick(x!, y!);
  return [{ type: 'text', text: `Middle-clicked at [${x}, ${y}]` }];
}

async function handleType(args: TypeParams):
  Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
  typeText(args.text);
  return [{ type: 'text', text: `Typed: "${args.text.slice(0, 100)}${args.text.length > 100 ? '...' : ''}"` }];
}

async function handleKey(args: KeyParams):
  Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
  const repeat = args.repeat ?? 1;

  // Check system key combo restrictions
  if (!state.grantFlags.systemKeyCombos) {
    const lowerChord = args.text.toLowerCase();
    const systemCombos = ['cmd+q', 'cmd+tab', 'cmd+space', 'ctrl+alt+delete', 'ctrl+alt+esc'];
    if (systemCombos.some((c) => lowerChord.includes(c))) {
      return [{
        type: 'text',
        text: `System key combo "${args.text}" is blocked. ` +
          `Set systemKeyCombos: true in request_access to enable system-level shortcuts.`,
      }];
    }
  }

  sendKeyChord(args.text, repeat);
  return [{ type: 'text', text: `Sent key chord: "${args.text}"${repeat > 1 ? ` x${repeat}` : ''}` }];
}

async function handleScroll(args: ScrollParams):
  Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
  const [x, y] = args.coordinate;

  // Move mouse to position first
  moveTo(x!, y!);

  // cliclick doesn't have native scroll, use osascript
  const direction = args.scroll_direction;
  const amount = Math.round(args.scroll_amount);

  if (direction === 'up' || direction === 'down') {
    const sign = direction === 'up' ? '' : '-';
    for (let i = 0; i < amount; i++) {
      execSync(
        `osascript -e 'tell application "System Events" to key code ${direction === 'up' ? 126 : 125}'`,
        { timeout: 1000, stdio: 'pipe' },
      );
    }
  } else {
    // Horizontal scroll — use Shift + arrow keys
    for (let i = 0; i < amount; i++) {
      execSync(
        `osascript -e 'tell application "System Events" to key code ${direction === 'left' ? 123 : 124} using shift down'`,
        { timeout: 1000, stdio: 'pipe' },
      );
    }
  }

  return [{ type: 'text', text: `Scrolled ${direction} at [${x}, ${y}], amount: ${amount}` }];
}

async function handleDrag(args: DragParams):
  Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
  const [endX, endY] = args.coordinate;

  if (args.start_coordinate) {
    const [startX, startY] = args.start_coordinate;
    dragStart(startX!, startY!);
  } else {
    // Use current cursor position
    dragStart(0, 0); // placeholder — cliclick dd uses current position if coordinates are not relevant
    // Actually cliclick dd requires coordinates. Get current position.
    const pos = getCursorPosition();
    dragStart(pos.x, pos.y);
  }

  // Small delay for drag
  await new Promise((r) => setTimeout(r, 100));

  dragEnd(endX!, endY!);

  return [{ type: 'text', text: `Dragged to [${endX}, ${endY}]` }];
}

async function handleMouseMove(args: MouseMoveParams):
  Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
  const [x, y] = args.coordinate;
  moveTo(x!, y!);
  return [{ type: 'text', text: `Mouse moved to [${x}, ${y}]` }];
}

async function handleOpenApp(args: OpenAppParams):
  Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
  const appName = args.app;

  // Try opening by name first
  try {
    execSync(`open -a "${appName}"`, { timeout: 10_000, stdio: 'pipe' });
  } catch {
    // Try by bundle ID
    try {
      execSync(`open -b "${appName}"`, { timeout: 10_000, stdio: 'pipe' });
    } catch (err) {
      throw new Error(`Could not open application: "${appName}". Check the name or bundle ID. Error: ${(err as Error).message}`);
    }
  }

  return [{ type: 'text', text: `Opened application: ${appName}` }];
}

async function handleSwitchDisplay(args: SwitchDisplayParams):
  Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
  state.selectedDisplay = args.display === 'auto' ? null : args.display;
  return [{ type: 'text', text: `Display switched to: ${args.display}` }];
}

async function handleListGranted():
  Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
  return [{
    type: 'text',
    text: JSON.stringify({
      allowedApps: state.allowedApps,
      grantFlags: state.grantFlags,
      accessRequested: state.accessRequested,
    }, null, 2),
  }];
}

async function handleReadClipboard():
  Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
  if (!state.grantFlags.clipboardRead) {
    return [{
      type: 'text',
      text: 'Clipboard read permission not granted. Set clipboardRead: true in request_access.',
    }];
  }

  const content = readPasteboard();
  return [{
    type: 'text',
    text: content || '(clipboard is empty)',
  }];
}

async function handleWriteClipboard(args: WriteClipboardParams):
  Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
  if (!state.grantFlags.clipboardWrite) {
    return [{
      type: 'text',
      text: 'Clipboard write permission not granted. Set clipboardWrite: true in request_access.',
    }];
  }

  writePasteboard(args.text);
  return [{ type: 'text', text: `Written to clipboard: "${args.text.slice(0, 100)}${args.text.length > 100 ? '...' : ''}"` }];
}

async function handleWait(args: WaitParams):
  Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
  const duration = Math.min(Math.max(args.duration, 0), 100) * 1000;
  await new Promise((r) => setTimeout(r, duration));
  return [{ type: 'text', text: `Waited ${args.duration}s` }];
}

async function handleCursorPosition():
  Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
  const pos = getCursorPosition();
  return [{
    type: 'text',
    text: JSON.stringify({ x: pos.x, y: pos.y, coordinateMode: 'pixels' }, null, 2),
  }];
}

async function handleHoldKey(args: HoldKeyParams):
  Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
  const chord = args.text;
  const durationMs = Math.min(Math.max(args.duration, 0), 100) * 1000;

  keyDown(chord);

  // Hold for the specified duration
  await new Promise((r) => setTimeout(r, durationMs));

  keyUp(chord);

  return [{ type: 'text', text: `Held "${chord}" for ${args.duration}s` }];
}

async function handleMouseDown():
  Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
  const pos = getCursorPosition();
  dragStart(pos.x, pos.y);
  return [{ type: 'text', text: `Left mouse down at [${pos.x}, ${pos.y}]` }];
}

async function handleMouseUp():
  Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
  const pos = getCursorPosition();
  dragEnd(pos.x, pos.y);
  return [{ type: 'text', text: `Left mouse up at [${pos.x}, ${pos.y}]` }];
}

// ── Batch Handler ───────────────────────────────────────────────────────

async function handleBatch(args: ComputerBatchParams):
  Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
  const results: string[] = [];
  let lastImage: ScreenshotResult | null = null;

  for (let i = 0; i < args.actions.length; i++) {
    const action = args.actions[i]!;
    try {
      const actionResult = await executeBatchAction(action);
      results.push(`[${i}] ${action.action}: ${actionResult}`);
      if (action.action === 'screenshot' && state.lastScreenshot) {
        lastImage = state.lastScreenshot;
      }
    } catch (err) {
      results.push(`[${i}] ${action.action}: ERROR — ${(err as Error).message}`);
    }
  }

  const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [];

  if (lastImage) {
    content.push({
      type: 'image',
      data: lastImage.data,
      mimeType: 'image/png',
    });
  }

  content.push({
    type: 'text',
    text: `Batch executed ${args.actions.length} actions:\n${results.join('\n')}`,
  });

  return content;
}

async function executeBatchAction(action: BatchAction): Promise<string> {
  switch (action.action) {
    case 'screenshot': {
      const result = takeScreenshot();
      state.lastScreenshot = result;
      return `Screenshot ${result.width}x${result.height}px`;
    }
    case 'left_click': {
      if (!action.coordinate) throw new Error('coordinate required');
      leftClick(action.coordinate[0]!, action.coordinate[1]!);
      return `Clicked [${action.coordinate[0]}, ${action.coordinate[1]}]`;
    }
    case 'double_click': {
      if (!action.coordinate) throw new Error('coordinate required');
      doubleClick(action.coordinate[0]!, action.coordinate[1]!);
      return `Double-clicked`;
    }
    case 'right_click': {
      if (!action.coordinate) throw new Error('coordinate required');
      rightClick(action.coordinate[0]!, action.coordinate[1]!);
      return `Right-clicked`;
    }
    case 'type': {
      if (!action.text) throw new Error('text required');
      typeText(action.text);
      return `Typed ${action.text.length} chars`;
    }
    case 'key': {
      if (!action.text) throw new Error('text required');
      sendKeyChord(action.text, action.repeat ?? 1);
      return `Key: ${action.text}`;
    }
    case 'scroll': {
      if (!action.coordinate) throw new Error('coordinate required');
      moveTo(action.coordinate[0]!, action.coordinate[1]!);
      const dir = action.scroll_direction ?? 'down';
      for (let i = 0; i < (action.scroll_amount ?? 1); i++) {
        execSync(
          `osascript -e 'tell application "System Events" to key code ${dir === 'up' ? 126 : dir === 'down' ? 125 : dir === 'left' ? 123 : 124}'`,
          { timeout: 1000, stdio: 'pipe' },
        );
      }
      return `Scrolled ${dir} x${action.scroll_amount ?? 1}`;
    }
    case 'mouse_move': {
      if (!action.coordinate) throw new Error('coordinate required');
      moveTo(action.coordinate[0]!, action.coordinate[1]!);
      return `Moved to [${action.coordinate[0]}, ${action.coordinate[1]}]`;
    }
    case 'wait': {
      const dur = (action.duration ?? 1) * 1000;
      await new Promise((r) => setTimeout(r, dur));
      return `Waited ${action.duration ?? 1}s`;
    }
    case 'cursor_position': {
      const pos = getCursorPosition();
      return `Cursor at [${pos.x}, ${pos.y}]`;
    }
    default:
      throw new Error(`Unknown batch action: ${action.action}`);
  }
}

// ── Reset (for testing) ─────────────────────────────────────────────────

export { resetState };
