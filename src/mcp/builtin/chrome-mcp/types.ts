/**
 * chrome-mcp types — CDP configuration, tab info, tool parameter types.
 */

// ── CDP Configuration ─────────────────────────────────────────────────

export interface CdpConfig {
  /** CDP debug port (default 9222) */
  port?: number;
  /** Path to Chrome/Edge executable */
  browserPath?: string;
  /** Run browser in headless mode */
  headless?: boolean;
  /** Browser user data directory for persistent profiles */
  userDataDir?: string;
}

// ── Tab Info ───────────────────────────────────────────────────────────

export interface TabInfo {
  id: string;
  url: string;
  title: string;
  active: boolean;
}

// ── Tool Parameter Types ──────────────────────────────────────────────

export interface NavigateParams {
  url: string;
  tabId?: number;
}

export interface ScreenshotParams {
  full_page?: boolean;
  selector?: string;
  tabId?: number;
}

export interface ClickParams {
  selector: string;
  tabId?: number;
}

export interface MouseClickParams {
  coordinate: [number, number];
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
  tabId?: number;
}

export interface TypeTextParams {
  text: string;
  selector?: string;
  tabId?: number;
}

export interface SendKeysParams {
  keys: string;
  tabId?: number;
}

export interface ScrollParams {
  amount?: number;
  scroll_direction?: 'up' | 'down' | 'left' | 'right';
  coordinate?: [number, number];
  tabId?: number;
}

export interface ExtractParams {
  selector?: string;
  tabId?: number;
}

export interface EvaluateParams {
  script: string;
  tabId?: number;
}

export interface FillParams {
  selector: string;
  value: string | number | boolean;
  tabId?: number;
}

export interface ResizeWindowParams {
  width: number;
  height: number;
  tabId?: number;
}

export interface ConsoleMessagesParams {
  tabId?: number;
  onlyErrors?: boolean;
  clear?: boolean;
  pattern?: string;
  limit?: number;
}

export interface NetworkRequestsParams {
  tabId?: number;
  urlPattern?: string;
  clear?: boolean;
  limit?: number;
}

export interface SnapshotParams {
  tabId?: number;
  filter?: 'interactive' | 'all';
  depth?: number;
  ref_id?: string;
  max_chars?: number;
}

export interface FindParams {
  query: string;
  tabId?: number;
}

export interface FormInputParams {
  ref: string;
  value: string | number | boolean;
  tabId?: number;
}

export interface UploadImageParams {
  imageId?: string;
  ref?: string;
  coordinate?: [number, number];
  tabId?: number;
  filename?: string;
}

export interface GifCreatorParams {
  action: 'start_recording' | 'stop_recording' | 'export' | 'clear';
  tabId?: number;
  download?: boolean;
  filename?: string;
  options?: {
    showClickIndicators?: boolean;
    showDragPaths?: boolean;
    showActionLabels?: boolean;
    showProgressBar?: boolean;
    showWatermark?: boolean;
    quality?: number;
  };
}

export interface SavePdfParams {
  tabId?: number;
  paper_size?: 'letter' | 'legal' | 'a4' | 'a3' | 'tabloid';
}

export interface PlanParams {
  domains: string[];
  approach: string[];
}

/** The combined computer tool — 13 actions within browser viewport */
export type ComputerAction =
  | 'left_click'
  | 'right_click'
  | 'type'
  | 'screenshot'
  | 'wait'
  | 'scroll'
  | 'key'
  | 'left_click_drag'
  | 'double_click'
  | 'triple_click'
  | 'zoom'
  | 'scroll_to'
  | 'hover';

export interface ComputerParams {
  action: ComputerAction;
  coordinate?: [number, number];
  start_coordinate?: [number, number];
  text?: string;
  duration?: number;
  scroll_direction?: 'up' | 'down' | 'left' | 'right';
  scroll_amount?: number;
  region?: [number, number, number, number];
  repeat?: number;
  ref?: string;
  modifiers?: string;
  tabId?: number;
}

export interface ShortcutsListParams {
  tabId?: number;
}

export interface ShortcutsExecuteParams {
  tabId?: number;
  shortcutId?: string;
  command?: string;
}

// ── Result types ──────────────────────────────────────────────────────

export interface ScreenshotResult {
  data: string; // base64 PNG
  width: number;
  height: number;
  format: 'png';
}

export interface AccessibilityNode {
  role: string;
  name: string;
  ref?: string;
  children?: AccessibilityNode[];
  value?: string;
  description?: string;
  properties?: Record<string, unknown>;
  backendNodeId?: number;
}

export interface ConsoleMessage {
  level: string;
  text: string;
  timestamp: number;
  source?: string;
  url?: string;
}

export interface NetworkRequest {
  requestId: string;
  url: string;
  method: string;
  status?: number;
  mimeType?: string;
  completed?: boolean;
  timestamp: number;
}

export interface NetworkDetail extends NetworkRequest {
  body?: string;
  base64Encoded?: boolean;
}
