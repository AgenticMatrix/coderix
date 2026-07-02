/**
 * Computer Use MCP — Types
 *
 * Types for the Computer Use MCP server tools and configuration.
 */

// ── Configuration ────────────────────────────────────────────────────

export interface ComputerUseConfig {
  /** Coordinate mode: only 'pixels' for Phase 1 */
  coordinateMode: 'pixels';
  /** Whether to save screenshots to disk by default */
  saveToDisk?: boolean;
}

// ── Coordinate ───────────────────────────────────────────────────────

export type Coordinate = [number, number];

// ── Scroll ───────────────────────────────────────────────────────────

export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

// ── Application ──────────────────────────────────────────────────────

export interface AllowedApp {
  name: string;
  bundleId?: string;
  granted: boolean;
}

// ── Grant Flags ──────────────────────────────────────────────────────

export interface GrantFlags {
  clipboardRead: boolean;
  clipboardWrite: boolean;
  systemKeyCombos: boolean;
}

// ── Tool Parameter Types ─────────────────────────────────────────────

export interface RequestAccessParams {
  apps: string[];
  reason: string;
  clipboardRead?: boolean;
  clipboardWrite?: boolean;
  systemKeyCombos?: boolean;
}

export interface ScreenshotParams {
  save_to_disk?: boolean;
}

export interface ZoomParams {
  region: [number, number, number, number]; // [x0, y0, x1, y1]
  save_to_disk?: boolean;
}

export interface ClickParams {
  coordinate: Coordinate;
  text?: string; // modifier keys
}

export interface TypeParams {
  text: string;
}

export interface KeyParams {
  text: string; // key chord e.g. "cmd+c"
  repeat?: number;
}

export interface ScrollParams {
  coordinate: Coordinate;
  scroll_direction: ScrollDirection;
  scroll_amount: number; // 0-100
}

export interface DragParams {
  coordinate: Coordinate; // end coordinate
  start_coordinate?: Coordinate; // start coordinate
}

export interface MouseMoveParams {
  coordinate: Coordinate;
}

export interface OpenAppParams {
  app: string; // name or bundle ID
}

export interface SwitchDisplayParams {
  display: string; // display identifier or "auto"
}

export interface WriteClipboardParams {
  text: string;
}

export interface WaitParams {
  duration: number; // 0-100 seconds
}

export interface HoldKeyParams {
  text: string; // chord
  duration: number; // 0-100 seconds
}

export interface BatchAction {
  action: string;
  coordinate?: Coordinate;
  text?: string;
  start_coordinate?: Coordinate;
  scroll_direction?: ScrollDirection;
  scroll_amount?: number;
  duration?: number;
  repeat?: number;
}

export interface ComputerBatchParams {
  actions: BatchAction[];
}

// ── Result Types ─────────────────────────────────────────────────────

export interface ScreenshotResult {
  data: string;      // base64 PNG
  width: number;
  height: number;
  format: 'png';
  note?: string;     // display info
}

export interface AccessResult {
  granted: string[];
  denied?: string[];
  grantFlags?: GrantFlags;
}

export interface CursorPosition {
  x: number;
  y: number;
  coordinateMode: 'pixels';
}
