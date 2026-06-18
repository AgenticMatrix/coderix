/**
 * Chrome Use MCP — Tool Schemas
 *
 * 18 tools matching claude-code-best's @ant/claude-for-chrome-mcp tool set.
 * All tools operate within the browser viewport via CDP.
 */

import type { ComputerAction } from './types.js';

// ── Helpers ─────────────────────────────────────────────────────────────

const COORD_DESC =
  'Coordinates [x, y] in CSS pixels relative to the browser viewport.';

// ── BROWSER TOOLS (18 total) ────────────────────────────────────────────

export const BROWSER_TOOLS = [
  // 1. javascript_tool
  {
    name: 'javascript_tool',
    description:
      'Execute JavaScript code in the browser page context and return the result. ' +
      'Use this to interact with page elements programmatically, read data, or modify the DOM.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Must be set to "javascript_exec".',
        },
        text: {
          type: 'string',
          description: 'JavaScript code to execute in the page context. Can use document, window, etc.',
        },
        tabId: {
          type: 'number',
          description: 'The tab ID to execute in. Get tab IDs from browser_get_tabs.',
        },
      },
      required: ['action', 'text', 'tabId'],
    },
  },

  // 2. read_page
  {
    name: 'read_page',
    description:
      'Read the accessibility tree of the page to understand its structure and interactive elements. ' +
      'Use this to discover what elements are on the page before interacting with them. ' +
      'Each element has a ref (e.g. e123) that can be used with form_input. ' +
      'By default only interactive elements (buttons, links, inputs, etc.) are returned. ' +
      'Use filter: "all" to get all elements including text content.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          enum: ['interactive', 'all'],
          description: 'Filter elements: "interactive" (default) shows only actionable elements, "all" shows everything.',
        },
        tabId: {
          type: 'number',
          description: 'The tab ID to read from.',
        },
        depth: {
          type: 'number',
          default: 15,
          description: 'Maximum depth of the accessibility tree to return.',
        },
        ref_id: {
          type: 'string',
          description: 'If provided, returns only the subtree rooted at this ref element.',
        },
        max_chars: {
          type: 'number',
          default: 50000,
          description: 'Maximum characters to return in the full text content.',
        },
      },
      required: ['tabId'],
    },
  },

  // 3. find
  {
    name: 'find',
    description:
      'Search for elements on the page by their name, role, or description. ' +
      'Returns matching accessibility elements with their refs for use with form_input or browser_click. ' +
      'Use natural language to describe what you are looking for, e.g. "login button" or "search input".',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language description of what to find on the page.',
        },
        tabId: {
          type: 'number',
          description: 'The tab ID to search in.',
        },
      },
      required: ['query', 'tabId'],
    },
  },

  // 4. form_input
  {
    name: 'form_input',
    description:
      'Set the value of a form element identified by its ref (from browser_read_page or browser_find). ' +
      'Works with text inputs, checkboxes, radio buttons, selects, and textareas.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: 'The element reference (e.g. "e123") from the accessibility snapshot.',
        },
        value: {
          description: 'The value to set. String for text inputs, boolean for checkboxes, number for selects.',
        },
        tabId: {
          type: 'number',
          description: 'The tab ID to operate on.',
        },
      },
      required: ['ref', 'value', 'tabId'],
    },
  },

  // 5. computer (combined tool)
  {
    name: 'computer',
    description:
      'Perform mouse, keyboard, and screenshot actions in the browser viewport. ' +
      'Actions operate on browser content, not the desktop. ' +
      'Available actions:\n' +
      '- left_click: Click at coordinates\n' +
      '- right_click: Right-click at coordinates\n' +
      '- double_click: Double-click at coordinates\n' +
      '- triple_click: Triple-click at coordinates\n' +
      '- hover: Move mouse to coordinates without clicking\n' +
      '- scroll: Scroll the page (use scroll_direction and scroll_amount)\n' +
      '- scroll_to: Scroll to specific coordinates\n' +
      '- left_click_drag: Click and drag from start_coordinate to coordinate\n' +
      '- type: Insert text at the current focus\n' +
      '- key: Send keyboard shortcut (e.g. "ctrl+c", "cmd+v")\n' +
      '- screenshot: Take a screenshot of the tab\n' +
      '- wait: Wait for specified duration in seconds\n' +
      '- zoom: Take a screenshot and crop to a region\n' +
      `Coordinates are in CSS pixels relative to the browser viewport.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'left_click', 'right_click', 'type', 'screenshot', 'wait',
            'scroll', 'key', 'left_click_drag', 'double_click',
            'triple_click', 'zoom', 'scroll_to', 'hover',
          ] as ComputerAction[],
          description: 'The action to perform.',
        },
        coordinate: {
          type: 'array',
          items: { type: 'number' },
          minItems: 2,
          maxItems: 2,
          description: COORD_DESC,
        },
        start_coordinate: {
          type: 'array',
          items: { type: 'number' },
          minItems: 2,
          maxItems: 2,
          description: 'Starting coordinate for drag operations.',
        },
        text: {
          type: 'string',
          description: 'Text to type or key chord to send.',
        },
        duration: {
          type: 'number',
          minimum: 0,
          maximum: 30,
          description: 'Duration in seconds (for wait action).',
        },
        scroll_direction: {
          type: 'string',
          enum: ['up', 'down', 'left', 'right'],
          description: 'Scroll direction.',
        },
        scroll_amount: {
          type: 'number',
          minimum: 1,
          maximum: 10,
          description: 'Scroll amount (1-10), where 1 = ~100px.',
        },
        region: {
          type: 'array',
          items: { type: 'number' },
          minItems: 4,
          maxItems: 4,
          description: 'Region [x0, y0, x1, y1] for zoom action.',
        },
        repeat: {
          type: 'number',
          minimum: 1,
          maximum: 100,
          description: 'Number of times to repeat the key action.',
        },
        ref: {
          type: 'string',
          description: 'Element reference for clicking a specific element.',
        },
        modifiers: {
          type: 'string',
          description: 'Modifier keys to hold during click (e.g. "shift", "ctrl", "cmd").',
        },
        tabId: {
          type: 'number',
          description: 'The tab ID to operate on.',
        },
      },
      required: ['action', 'tabId'],
    },
  },

  // 6. navigate
  {
    name: 'navigate',
    description:
      'Navigate the browser tab to a URL. SSRF protection prevents navigation to internal/private hosts. ' +
      'The URL must use http or https protocol.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to navigate to (must be http or https).',
        },
        tabId: {
          type: 'number',
          description: 'The tab ID to navigate. If omitted, uses the active tab.',
        },
      },
      required: ['url', 'tabId'],
    },
  },

  // 7. resize_window
  {
    name: 'resize_window',
    description:
      'Resize the browser viewport to specific dimensions. Useful for responsive testing ' +
      'or ensuring consistent screenshot sizes.',
    inputSchema: {
      type: 'object',
      properties: {
        width: {
          type: 'number',
          description: 'Viewport width in pixels.',
        },
        height: {
          type: 'number',
          description: 'Viewport height in pixels.',
        },
        tabId: {
          type: 'number',
          description: 'The tab ID to resize.',
        },
      },
      required: ['width', 'height', 'tabId'],
    },
  },

  // 8. gif_creator
  {
    name: 'gif_creator',
    description:
      'Record browser interactions and export them as a GIF. ' +
      'Actions: start_recording, stop_recording, export, clear. ' +
      'Note: Full GIF encoding requires ffmpeg to be installed.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start_recording', 'stop_recording', 'export', 'clear'],
          description: 'Recording action to perform.',
        },
        tabId: {
          type: 'number',
          description: 'The tab ID to record.',
        },
        download: {
          type: 'boolean',
          description: 'Whether to download the GIF after export.',
        },
        filename: {
          type: 'string',
          description: 'Filename for the exported GIF.',
        },
        options: {
          type: 'object',
          properties: {
            showClickIndicators: { type: 'boolean' },
            showDragPaths: { type: 'boolean' },
            showActionLabels: { type: 'boolean' },
            showProgressBar: { type: 'boolean' },
            showWatermark: { type: 'boolean' },
            quality: { type: 'number', minimum: 1, maximum: 100 },
          },
          description: 'GIF export options.',
        },
      },
      required: ['action', 'tabId'],
    },
  },

  // 9. upload_image
  {
    name: 'upload_image',
    description:
      'Trigger a file upload on a file input element. Use a ref from the accessibility snapshot ' +
      'to identify the input, and provide file paths to upload.',
    inputSchema: {
      type: 'object',
      properties: {
        imageId: {
          type: 'string',
          description: 'ID for the upload operation (for tracking).',
        },
        ref: {
          type: 'string',
          description: 'Element reference for the file input.',
        },
        coordinate: {
          type: 'array',
          items: { type: 'number' },
          minItems: 2,
          maxItems: 2,
          description: 'Coordinates to click to focus the file input.',
        },
        tabId: {
          type: 'number',
          description: 'The tab ID.',
        },
        filename: {
          type: 'string',
          description: 'Name of the file being uploaded.',
        },
      },
      required: ['imageId', 'tabId'],
    },
  },

  // 10. get_page_text
  {
    name: 'get_page_text',
    description:
      'Extract all visible text content from the page. Returns the page content as plain text. ' +
      'Use this for reading article content, extracting data, or getting an overview of page content.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description: 'The tab ID to extract text from.',
        },
      },
      required: ['tabId'],
    },
  },

  // 11. tabs_context_mcp
  {
    name: 'tabs_context_mcp',
    description:
      'Get information about all open browser tabs including their IDs, URLs, and titles. ' +
      'Use this to discover what tabs are available before interacting with them.',
    inputSchema: {
      type: 'object',
      properties: {
        createIfEmpty: {
          type: 'boolean',
          description: 'If true and no tabs exist, create a new blank tab.',
        },
      },
      required: [],
    },
  },

  // 12. tabs_create_mcp
  {
    name: 'tabs_create_mcp',
    description:
      'Create a new browser tab. Optionally specify an initial URL. ' +
      'The new tab will become the active tab.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Optional initial URL for the new tab.',
        },
      },
      required: [],
    },
  },

  // 13. update_plan
  {
    name: 'update_plan',
    description:
      'Present a plan to the user for approval before executing browser actions. ' +
      'This is a non-interactive tool that records the plan domains and approach for user review. ' +
      'Use this when the user asks you to plan something before doing it.',
    inputSchema: {
      type: 'object',
      properties: {
        domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of domains/websites the plan will interact with.',
        },
        approach: {
          type: 'array',
          items: { type: 'string' },
          description: 'Step-by-step description of the planned approach.',
        },
      },
      required: ['domains', 'approach'],
    },
  },

  // 14. read_console_messages
  {
    name: 'read_console_messages',
    description:
      'Read browser console messages (log, warn, error) from the page. ' +
      'Useful for debugging JavaScript issues or monitoring page behavior. ' +
      'Can filter by errors only, text pattern, and limit results.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description: 'The tab ID to read console from.',
        },
        onlyErrors: {
          type: 'boolean',
          description: 'Only return error and warning messages.',
        },
        clear: {
          type: 'boolean',
          description: 'Clear the console buffer after reading.',
        },
        pattern: {
          type: 'string',
          description: 'Filter messages by text pattern (regex).',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of messages to return.',
        },
      },
      required: ['tabId'],
    },
  },

  // 15. read_network_requests
  {
    name: 'read_network_requests',
    description:
      'Read captured network requests from the page. Network capture must be started first. ' +
      'Use browser_network_start / browser_network_stop to control capture. ' +
      'Can filter by URL pattern and limit results.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description: 'The tab ID.',
        },
        urlPattern: {
          type: 'string',
          description: 'Filter requests by URL substring.',
        },
        clear: {
          type: 'boolean',
          description: 'Clear captured requests after reading.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of requests to return.',
        },
      },
      required: ['tabId'],
    },
  },
] as const;

export type BrowserToolName = (typeof BROWSER_TOOLS)[number]['name'];
