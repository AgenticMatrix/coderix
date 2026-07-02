/**
 * Chrome Use MCP — Tool Handlers
 *
 * Dispatches MCP tool calls to CdpClient methods.
 * Each handler receives parsed arguments and the CdpClient instance.
 */

import { CdpClient } from './cdp-client.js';
import type {
  NavigateParams,
  ScreenshotParams,
  ClickParams,
  MouseClickParams,
  TypeTextParams,
  SendKeysParams,
  ScrollParams,
  ExtractParams,
  EvaluateParams,
  FillParams,
  ResizeWindowParams,
  ConsoleMessagesParams,
  NetworkRequestsParams,
  SnapshotParams,
  FindParams,
  FormInputParams,
  UploadImageParams,
  GifCreatorParams,
  SavePdfParams,
  PlanParams,
  ComputerParams,
  ShortcutsListParams,
  ShortcutsExecuteParams,
} from './types.js';

/**
 * Handle a browser tool call. Returns MCP-formatted content.
 */
export async function handleBrowserToolCall(
  name: string,
  args: Record<string, unknown>,
  cdp: CdpClient,
): Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
  switch (name) {
    // ── Tab Management ──────────────────────────────────────────────
    case 'tabs_context_mcp':
      return handleGetTabs(args, cdp);

    case 'tabs_create_mcp':
      return handleNewTab(args, cdp);

    // ── Navigation & Page ───────────────────────────────────────────
    case 'navigate':
      return handleNavigate(args as unknown as NavigateParams, cdp);

    case 'resize_window':
      return handleResizeWindow(args as unknown as ResizeWindowParams, cdp);

    case 'get_page_text':
      return handleGetPageText(args, cdp);

    // ── Screenshot ──────────────────────────────────────────────────
    case 'computer': {
      const params = args as unknown as ComputerParams;
      if (params.action === 'screenshot') {
        return handleScreenshot(args, cdp);
      }
      return handleComputerAction(args as unknown as ComputerParams, cdp);
    }

    // ── Interaction ─────────────────────────────────────────────────
    case 'javascript_tool':
      return handleJavascript(args, cdp);

    case 'form_input':
      return handleFormInput(args as unknown as FormInputParams, cdp);

    case 'find':
      return handleFind(args as unknown as FindParams, cdp);

    case 'read_page':
      return handleSnapshot(args as unknown as SnapshotParams, cdp);

    // ── Console & Network ───────────────────────────────────────────
    case 'read_console_messages':
      return handleConsoleMessages(args as unknown as ConsoleMessagesParams, cdp);

    case 'read_network_requests':
      return handleNetworkRequests(args as unknown as NetworkRequestsParams, cdp);

    // ── Recording ───────────────────────────────────────────────────
    case 'gif_creator':
      return handleGifCreator(args as unknown as GifCreatorParams, cdp);

    // ── Upload ──────────────────────────────────────────────────────
    case 'upload_image':
      return handleUploadImage(args as unknown as UploadImageParams, cdp);

    // ── Plan ────────────────────────────────────────────────────────
    case 'update_plan':
      return handleUpdatePlan(args as unknown as PlanParams);

    // ── Extension-specific (stubs in CDP mode) ──────────────────────
    case 'shortcuts_list':
    case 'shortcuts_execute':
      return [{ type: 'text', text: 'Shortcuts are an extension-only feature. Not available in direct CDP mode.' }];

    case 'switch_browser':
      return [{ type: 'text', text: 'Browser switching is an extension-only feature. Use cdpPort config to connect to a different Chrome instance.' }];

    default:
      return [{ type: 'text', text: `Unknown tool: ${name}`, }];
  }
}

// ── Individual Handlers ──────────────────────────────────────────────────

async function handleGetTabs(
  args: Record<string, unknown>,
  cdp: CdpClient,
): Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
  const createIfEmpty = args.createIfEmpty as boolean | undefined;
  let tabs = await cdp.getTabs();

  if (tabs.length === 0 && createIfEmpty) {
    const newTab = await cdp.newTab('about:blank');
    tabs = [newTab];
  }

  return [{
    type: 'text',
    text: JSON.stringify({
      tabs: tabs.map((t) => ({
        id: t.id,
        url: t.url,
        title: t.title,
        active: t.active,
      })),
      count: tabs.length,
    }, null, 2),
  }];
}

async function handleNewTab(
  args: Record<string, unknown>,
  cdp: CdpClient,
): Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
  const url = (args.url as string) || 'about:blank';
  const tab = await cdp.newTab(url);
  return [{
    type: 'text',
    text: JSON.stringify({ created: true, tab }, null, 2),
  }];
}

async function handleNavigate(
  args: NavigateParams,
  cdp: CdpClient,
): Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
  const tabId = args.tabId ? String(args.tabId) : undefined;
  const result = await cdp.navigate(args.url, tabId);
  return [{
    type: 'text',
    text: JSON.stringify(result, null, 2),
  }];
}

async function handleScreenshot(
  args: Record<string, unknown>,
  cdp: CdpClient,
): Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
  const tabId = args.tabId ? String(args.tabId as number) : undefined;
  const fullPage = (args.full_page as boolean) ?? false;
  const selector = args.selector as string | undefined;

  const result = await cdp.screenshot(tabId, fullPage, selector);

  return [
    {
      type: 'image',
      data: result.data,
      mimeType: 'image/png',
    },
    {
      type: 'text',
      text: `Screenshot captured: ${result.width}x${result.height}px (PNG, base64)`,
    },
  ];
}

async function handleJavascript(
  args: Record<string, unknown>,
  cdp: CdpClient,
): Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
  const script = args.text as string;
  if (!script) throw new Error('text (JavaScript code) is required');

  const tabId = args.tabId ? String(args.tabId as number) : undefined;
  const result = await cdp.evaluate(script, tabId);

  return [{
    type: 'text',
    text: JSON.stringify(result, null, 2),
  }];
}

async function handleFormInput(
  args: FormInputParams,
  cdp: CdpClient,
): Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
  const tabId = args.tabId ? String(args.tabId) : undefined;

  // form_input uses ref from accessibility tree — try to click it first
  // Then set value via JS
  const refNum = args.ref.replace(/^e/, '');
  const script = `
    (function(){
      const el = document.querySelector('[data-ref="e${refNum}"]') ||
        (function find(n){for(const c of document.querySelectorAll('*')){if(c.getAttribute('data-backend-node-id')==='${refNum}'||c.getAttribute('data-ref')==='e${refNum}')return c;}return null;})();
      if (!el) return JSON.stringify({error: 'Element with ref ${args.ref} not found'});
      el.focus();
      const ns = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set ||
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
      try { ns.call(el, ${JSON.stringify(args.value)}); } catch(e) { el.value = ${JSON.stringify(args.value)}; }
      el.dispatchEvent(new Event('input',{bubbles:true}));
      el.dispatchEvent(new Event('change',{bubbles:true}));
      return JSON.stringify({filled:true, ref:${JSON.stringify(args.ref)}});
    })()
  `;

  const result = await cdp.evaluate(script, tabId);

  let parsed = result;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { /* keep as string */ }
  }

  return [{
    type: 'text',
    text: JSON.stringify(parsed, null, 2),
  }];
}

async function handleFind(
  args: FindParams,
  cdp: CdpClient,
): Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
  const tabId = args.tabId ? String(args.tabId) : undefined;
  const results = await cdp.find(args.query, tabId);

  return [{
    type: 'text',
    text: JSON.stringify({
      query: args.query,
      results: results.slice(0, 20).map((r) => ({
        role: r.role,
        name: r.name,
        ref: r.ref,
        description: r.description,
      })),
      count: results.length,
    }, null, 2),
  }];
}

async function handleSnapshot(
  args: SnapshotParams,
  cdp: CdpClient,
): Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
  const tabId = args.tabId ? String(args.tabId) : undefined;
  const filter = args.filter ?? 'interactive';
  const depth = args.depth ?? 15;
  const maxChars = args.max_chars ?? 50000;

  const nodes = await cdp.snapshot(tabId, filter, depth, maxChars);

  const text = JSON.stringify({
    elements: nodes,
    count: countNodes(nodes),
  }, null, 2);

  // Truncate if too long
  const truncated = text.length > maxChars ? text.slice(0, maxChars) + '\n\n... (truncated)' : text;

  return [{
    type: 'text',
    text: truncated,
  }];
}

function countNodes(nodes: any[]): number {
  let count = 0;
  for (const node of nodes) {
    count++;
    if (node.children) count += countNodes(node.children);
  }
  return count;
}

async function handleComputerAction(
  args: ComputerParams,
  cdp: CdpClient,
): Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
  const result = await cdp.computerAction(args.action, {
    coordinate: args.coordinate,
    start_coordinate: args.start_coordinate,
    text: args.text,
    duration: args.duration,
    scroll_direction: args.scroll_direction,
    scroll_amount: args.scroll_amount,
    region: args.region,
    repeat: args.repeat,
    ref: args.ref,
    modifiers: args.modifiers,
    tabId: args.tabId,
  });

  // If the result has image data, return it as image content
  if (result && typeof result === 'object' && 'data' in result && 'format' in result) {
    return [
      {
        type: 'image',
        data: result.data as string,
        mimeType: 'image/png',
      },
      {
        type: 'text',
        text: `${result.width}x${result.height}px PNG screenshot`,
      },
    ];
  }

  return [{
    type: 'text',
    text: JSON.stringify(result, null, 2),
  }];
}

async function handleGetPageText(
  args: Record<string, unknown>,
  cdp: CdpClient,
): Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
  const tabId = args.tabId ? String(args.tabId as number) : undefined;
  const content = await cdp.getPageText(tabId);

  return [{
    type: 'text',
    text: content || '(Empty page)',
  }];
}

async function handleResizeWindow(
  args: ResizeWindowParams,
  cdp: CdpClient,
): Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
  const tabId = args.tabId ? String(args.tabId) : undefined;
  const result = await cdp.resizeWindow(args.width, args.height, tabId);
  return [{
    type: 'text',
    text: JSON.stringify(result, null, 2),
  }];
}

async function handleConsoleMessages(
  args: ConsoleMessagesParams,
  cdp: CdpClient,
): Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
  const tabId = args.tabId ? String(args.tabId) : undefined;
  const messages = await cdp.getConsoleMessages(tabId, {
    onlyErrors: args.onlyErrors,
    clear: args.clear,
    pattern: args.pattern,
    limit: args.limit,
  });

  return [{
    type: 'text',
    text: JSON.stringify({
      messages,
      count: messages.length,
    }, null, 2),
  }];
}

async function handleNetworkRequests(
  args: NetworkRequestsParams,
  cdp: CdpClient,
): Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
  const tabId = args.tabId ? String(args.tabId) : undefined;
  const result = await cdp.networkList(tabId, args.urlPattern, args.limit);

  return [{
    type: 'text',
    text: JSON.stringify({
      requests: result.requests.map((r) => ({
        requestId: r.requestId,
        url: r.url,
        method: r.method,
        status: r.status,
        mimeType: r.mimeType,
        completed: r.completed,
      })),
      count: result.count,
    }, null, 2),
  }];
}

async function handleGifCreator(
  args: GifCreatorParams,
  cdp: CdpClient,
): Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
  switch (args.action) {
    case 'start_recording':
      return [{
        type: 'text',
        text: JSON.stringify(await cdp.gifStart(args.tabId ? String(args.tabId) : undefined), null, 2),
      }];
    case 'stop_recording':
      return [{
        type: 'text',
        text: JSON.stringify(await cdp.gifStop(), null, 2),
      }];
    case 'export':
      return [{
        type: 'text',
        text: JSON.stringify(await cdp.gifExport(args.filename), null, 2) +
          '\nNote: GIF encoding requires ffmpeg. Only frame count is reported here.',
      }];
    case 'clear':
      return [{
        type: 'text',
        text: JSON.stringify(await cdp.gifClear(), null, 2),
      }];
    default:
      throw new Error(`Unknown gif action: ${args.action}`);
  }
}

async function handleUploadImage(
  args: UploadImageParams,
  cdp: CdpClient,
): Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
  if (!args.ref && !args.coordinate) {
    throw new Error('Either ref (element reference) or coordinate is required for upload');
  }

  // If coordinate provided, click there first
  if (args.coordinate) {
    await cdp.mouseClick(args.coordinate[0]!, args.coordinate[1]!, 'left', 1,
      args.tabId ? String(args.tabId) : undefined);
    await new Promise((r) => setTimeout(r, 500));
  }

  return [{
    type: 'text',
    text: JSON.stringify({
      uploaded: true,
      imageId: args.imageId,
      note: 'In direct CDP mode, file selection dialog must be handled by the OS. Provide file paths via a separate mechanism.',
    }, null, 2),
  }];
}

async function handleUpdatePlan(
  args: PlanParams,
): Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
  return [{
    type: 'text',
    text: JSON.stringify({
      plan_recorded: true,
      domains: args.domains,
      approach: args.approach,
      message: 'Plan has been recorded. Proceed with your implementation.',
    }, null, 2),
  }];
}

// ── Network Control (called directly, not as tool name) ─────────────────

// These are helper functions for network capture that can be exposed as additional tools
export async function handleNetworkStart(
  args: { tabId?: number },
  cdp: CdpClient,
): Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
  const tabId = args.tabId ? String(args.tabId) : undefined;
  const result = await cdp.networkStart(tabId);
  return [{ type: 'text', text: JSON.stringify(result, null, 2) }];
}

export async function handleNetworkStop(
  args: { tabId?: number },
  cdp: CdpClient,
): Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
  const tabId = args.tabId ? String(args.tabId) : undefined;
  const result = await cdp.networkStop(tabId);
  return [{ type: 'text', text: JSON.stringify(result, null, 2) }];
}
