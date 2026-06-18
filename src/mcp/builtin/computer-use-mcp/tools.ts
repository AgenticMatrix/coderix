/**
 * Computer Use MCP — Tool Schemas
 *
 * 24 tools matching claude-code-best's @ant/computer-use-mcp tool set.
 * Computer Use controls the macOS desktop (not browser viewport).
 * All coordinates are in screen pixels.
 */

const COORD_DESC =
  'Screen pixel coordinates [x, y]. ' +
  'Read coordinates directly from the screenshot image — ' +
  'the top-left pixel is [0, 0].';

export const COMPUTER_TOOLS = [
  // 1. request_access
  {
    name: 'request_access',
    description:
      'Request permission to control one or more applications. ' +
      'You MUST call this before any other computer use tools. ' +
      'Provide the list of app names you plan to interact with and a reason. ' +
      'This returns which apps were granted and which were denied.',
    inputSchema: {
      type: 'object',
      properties: {
        apps: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of application names or bundle IDs to request access to.',
        },
        reason: {
          type: 'string',
          description: 'Reason for needing access to these applications.',
        },
        clipboardRead: {
          type: 'boolean',
          description: 'Request clipboard read permission.',
        },
        clipboardWrite: {
          type: 'boolean',
          description: 'Request clipboard write permission.',
        },
        systemKeyCombos: {
          type: 'boolean',
          description: 'Request permission to use system-level key combinations.',
        },
      },
      required: ['apps', 'reason'],
    },
  },

  // 2. screenshot
  {
    name: 'screenshot',
    description:
      'Take a full-screen screenshot of the entire desktop (all displays). ' +
      'Returns a base64-encoded PNG image with pixel dimensions. ' +
      'Use this to see the current state of the desktop before interacting. ' +
      'The screenshot includes the cursor. ' +
      'Coordinates from this screenshot can be used directly with click/type/scroll tools.',
    inputSchema: {
      type: 'object',
      properties: {
        save_to_disk: {
          type: 'boolean',
          description: 'If true, save the screenshot to the current working directory.',
        },
      },
      required: [],
    },
  },

  // 3. zoom
  {
    name: 'zoom',
    description:
      'Crop the most recent screenshot to a region for a closer look. ' +
      'Use this when you need to see fine details in a specific area. ' +
      'The region is specified as [x0, y0, x1, y1] in screen pixels. ' +
      'Coordinates in the zoomed image are relative to the region. ' +
      'Note: zoom does NOT take a new screenshot — it crops the previous one.',
    inputSchema: {
      type: 'object',
      properties: {
        region: {
          type: 'array',
          items: { type: 'number' },
          minItems: 4,
          maxItems: 4,
          description: 'Region to crop as [x0, y0, x1, y1] in screen pixels.',
        },
        save_to_disk: {
          type: 'boolean',
          description: 'If true, save the cropped image to disk.',
        },
      },
      required: ['region'],
    },
  },

  // 4. left_click
  {
    name: 'left_click',
    description:
      'Left-click at the specified screen coordinates. ' +
      COORD_DESC +
      '\nOptionally hold modifier keys during the click (e.g. "shift", "cmd", "ctrl").',
    inputSchema: {
      type: 'object',
      properties: {
        coordinate: {
          type: 'array',
          items: { type: 'number' },
          minItems: 2,
          maxItems: 2,
          description: COORD_DESC,
        },
        text: {
          type: 'string',
          description: 'Modifier keys to hold during click, e.g. "shift" or "cmd+shift".',
        },
      },
      required: ['coordinate'],
    },
  },

  // 5. double_click
  {
    name: 'double_click',
    description: 'Double-click at the specified screen coordinates. ' + COORD_DESC,
    inputSchema: {
      type: 'object',
      properties: {
        coordinate: {
          type: 'array',
          items: { type: 'number' },
          minItems: 2,
          maxItems: 2,
          description: COORD_DESC,
        },
      },
      required: ['coordinate'],
    },
  },

  // 6. triple_click
  {
    name: 'triple_click',
    description: 'Triple-click at the specified screen coordinates. ' + COORD_DESC,
    inputSchema: {
      type: 'object',
      properties: {
        coordinate: {
          type: 'array',
          items: { type: 'number' },
          minItems: 2,
          maxItems: 2,
          description: COORD_DESC,
        },
      },
      required: ['coordinate'],
    },
  },

  // 7. right_click
  {
    name: 'right_click',
    description: 'Right-click (context menu) at the specified screen coordinates. ' + COORD_DESC,
    inputSchema: {
      type: 'object',
      properties: {
        coordinate: {
          type: 'array',
          items: { type: 'number' },
          minItems: 2,
          maxItems: 2,
          description: COORD_DESC,
        },
      },
      required: ['coordinate'],
    },
  },

  // 8. middle_click
  {
    name: 'middle_click',
    description: 'Middle-click at the specified screen coordinates. ' + COORD_DESC,
    inputSchema: {
      type: 'object',
      properties: {
        coordinate: {
          type: 'array',
          items: { type: 'number' },
          minItems: 2,
          maxItems: 2,
          description: COORD_DESC,
        },
      },
      required: ['coordinate'],
    },
  },

  // 9. type
  {
    name: 'type',
    description:
      'Type text using the keyboard. The text is typed at the current cursor/focus position. ' +
      'Use this to fill in text fields, write messages, or enter commands. ' +
      'Special characters and newlines are supported.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The text to type. Can include newlines, tabs, and special characters.',
        },
      },
      required: ['text'],
    },
  },

  // 10. key
  {
    name: 'key',
    description:
      'Send a keyboard shortcut (key combination). ' +
      'Format: modifier+modifier+key, e.g. "cmd+c", "ctrl+shift+t", "cmd+space". ' +
      'Supported modifiers: cmd, ctrl, alt/option, shift. ' +
      'Supported keys: letters, numbers, enter, tab, space, escape, backspace, delete, ' +
      'arrow keys (up/down/left/right), home, end, pageup, pagedown, F1-F12. ' +
      'Optionally repeat the chord multiple times.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Key chord to send, e.g. "cmd+c" or "ctrl+shift+t".',
        },
        repeat: {
          type: 'number',
          minimum: 1,
          maximum: 100,
          description: 'Number of times to send the chord (default: 1).',
        },
      },
      required: ['text'],
    },
  },

  // 11. scroll
  {
    name: 'scroll',
    description:
      'Scroll at the specified screen coordinates. ' +
      'Use scroll_direction to specify direction and scroll_amount (0-100) for intensity. ' +
      'The mouse must be moved to the coordinate first (this happens automatically).',
    inputSchema: {
      type: 'object',
      properties: {
        coordinate: {
          type: 'array',
          items: { type: 'number' },
          minItems: 2,
          maxItems: 2,
          description: 'Screen coordinates where the scroll should happen.',
        },
        scroll_direction: {
          type: 'string',
          enum: ['up', 'down', 'left', 'right'],
          description: 'Direction to scroll.',
        },
        scroll_amount: {
          type: 'number',
          minimum: 0,
          maximum: 100,
          description: 'Amount to scroll. 1 = one scroll "click", 10 = a full page scroll.',
        },
      },
      required: ['coordinate', 'scroll_direction', 'scroll_amount'],
    },
  },

  // 12. left_click_drag
  {
    name: 'left_click_drag',
    description:
      'Click and drag from one point to another. ' +
      'If start_coordinate is omitted, uses the current cursor position. ' +
      'Useful for selecting text, moving windows, or drag-and-drop operations.',
    inputSchema: {
      type: 'object',
      properties: {
        coordinate: {
          type: 'array',
          items: { type: 'number' },
          minItems: 2,
          maxItems: 2,
          description: 'End coordinate for the drag.',
        },
        start_coordinate: {
          type: 'array',
          items: { type: 'number' },
          minItems: 2,
          maxItems: 2,
          description: 'Start coordinate for the drag. Defaults to current cursor position.',
        },
      },
      required: ['coordinate'],
    },
  },

  // 13. mouse_move
  {
    name: 'mouse_move',
    description: 'Move the mouse cursor to the specified screen coordinates without clicking.',
    inputSchema: {
      type: 'object',
      properties: {
        coordinate: {
          type: 'array',
          items: { type: 'number' },
          minItems: 2,
          maxItems: 2,
          description: COORD_DESC,
        },
      },
      required: ['coordinate'],
    },
  },

  // 14. open_application
  {
    name: 'open_application',
    description:
      'Open an application by name or bundle ID. ' +
      'Examples: "Safari", "Google Chrome", "com.apple.TextEdit", "Terminal". ' +
      'The application will be brought to the foreground.',
    inputSchema: {
      type: 'object',
      properties: {
        app: {
          type: 'string',
          description: 'Application name (e.g. "Safari") or bundle ID (e.g. "com.apple.Safari").',
        },
      },
      required: ['app'],
    },
  },

  // 15. switch_display
  {
    name: 'switch_display',
    description:
      'Switch which display screenshots are taken from. ' +
      'Use "auto" for automatic display detection, or specify a display identifier. ' +
      'Useful on multi-monitor setups.',
    inputSchema: {
      type: 'object',
      properties: {
        display: {
          type: 'string',
          description: 'Display identifier or "auto" for automatic selection.',
        },
      },
      required: ['display'],
    },
  },

  // 16. list_granted_applications
  {
    name: 'list_granted_applications',
    description:
      'List all applications that have been granted access for Computer Use. ' +
      'Shows which apps are allowed and the current permission flags.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  // 17. read_clipboard
  {
    name: 'read_clipboard',
    description:
      'Read the current content of the system clipboard. ' +
      'Returns the text content. Requires clipboard read permission.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  // 18. write_clipboard
  {
    name: 'write_clipboard',
    description:
      'Write text to the system clipboard. Requires clipboard write permission.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Text to write to the clipboard.',
        },
      },
      required: ['text'],
    },
  },

  // 19. wait
  {
    name: 'wait',
    description:
      'Wait for a specified duration. Useful for waiting for UI animations, ' +
      'page loads, or application responses before taking the next action.',
    inputSchema: {
      type: 'object',
      properties: {
        duration: {
          type: 'number',
          minimum: 0,
          maximum: 100,
          description: 'Duration to wait in seconds.',
        },
      },
      required: ['duration'],
    },
  },

  // 20. cursor_position
  {
    name: 'cursor_position',
    description:
      'Get the current mouse cursor position in screen pixel coordinates. ' +
      'Returns x, y coordinates and the coordinate mode.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  // 21. hold_key
  {
    name: 'hold_key',
    description:
      'Hold a key combination down for a specified duration, then release. ' +
      'Format: modifier+key, e.g. "cmd", "shift", "ctrl+shift". ' +
      'Useful for press-and-hold interactions.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Key chord to hold, e.g. "cmd" or "shift+ctrl".',
        },
        duration: {
          type: 'number',
          minimum: 0,
          maximum: 100,
          description: 'Duration to hold the key in seconds.',
        },
      },
      required: ['text', 'duration'],
    },
  },

  // 22. left_mouse_down
  {
    name: 'left_mouse_down',
    description:
      'Press and hold the left mouse button at the current cursor position. ' +
      'Use with left_mouse_up for custom drag operations.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  // 23. left_mouse_up
  {
    name: 'left_mouse_up',
    description:
      'Release the left mouse button at the current cursor position. ' +
      'Use after left_mouse_down to complete a drag operation.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  // 24. computer_batch
  {
    name: 'computer_batch',
    description:
      'Execute multiple Computer Use actions in a single call for efficiency. ' +
      'Each action has an "action" field (same names as individual tools) plus its parameters. ' +
      'Actions are executed in order. If one fails, subsequent actions are still attempted. ' +
      'Batchable actions: screenshot, left_click, double_click, right_click, type, key, ' +
      'scroll, mouse_move, wait, cursor_position.',
    inputSchema: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                description: 'Action name, e.g. "left_click", "type", "screenshot", "key".',
              },
              coordinate: {
                type: 'array',
                items: { type: 'number' },
                minItems: 2,
                maxItems: 2,
              },
              text: { type: 'string' },
              start_coordinate: {
                type: 'array',
                items: { type: 'number' },
                minItems: 2,
                maxItems: 2,
              },
              scroll_direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
              scroll_amount: { type: 'number', minimum: 0, maximum: 100 },
              duration: { type: 'number', minimum: 0, maximum: 100 },
              repeat: { type: 'number', minimum: 1, maximum: 100 },
            },
            required: ['action'],
          },
          description: 'List of actions to execute in sequence.',
        },
      },
      required: ['actions'],
    },
  },
] as const;

export type ComputerToolName = (typeof COMPUTER_TOOLS)[number]['name'];
