/**
 * Computer Use MCP - Tool Schema validation tests.
 */

import { describe, it, expect } from 'vitest';
import { COMPUTER_TOOLS } from '../../../../src/mcp/builtin/computer-use-mcp/tools.js';

describe('COMPUTER_TOOLS', () => {
  it('has 24 tools', () => {
    expect(COMPUTER_TOOLS).toHaveLength(24);
  });

  it('every tool has name, description, inputSchema', () => {
    for (const tool of COMPUTER_TOOLS) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('every tool name is unique', () => {
    const names = COMPUTER_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  describe('coordinate-based tools', () => {
    const coordTools = [
      'left_click', 'double_click', 'triple_click', 'right_click',
      'middle_click', 'scroll', 'left_click_drag', 'mouse_move',
    ];

    for (const name of coordTools) {
      it(`${name} requires coordinate parameter`, () => {
        const tool = COMPUTER_TOOLS.find((t) => t.name === name);
        expect(tool).toBeDefined();
        expect(tool!.inputSchema.required).toContain('coordinate');
      });

      it(`${name} coordinate is array of 2 numbers`, () => {
        const tool = COMPUTER_TOOLS.find((t) => t.name === name);
        const coord = (tool!.inputSchema.properties as any).coordinate;
        expect(coord.type).toBe('array');
        expect(coord.items.type).toBe('number');
        expect(coord.minItems).toBe(2);
        expect(coord.maxItems).toBe(2);
      });
    }
  });

  describe('request_access tool', () => {
    it('requires apps and reason', () => {
      const tool = COMPUTER_TOOLS.find((t) => t.name === 'request_access')!;
      expect(tool.inputSchema.required).toContain('apps');
      expect(tool.inputSchema.required).toContain('reason');
    });

    it('apps is an array of strings', () => {
      const tool = COMPUTER_TOOLS.find((t) => t.name === 'request_access')!;
      const apps = (tool.inputSchema.properties as any).apps;
      expect(apps.type).toBe('array');
      expect(apps.items.type).toBe('string');
    });

    it('has optional clipboard permission flags', () => {
      const tool = COMPUTER_TOOLS.find((t) => t.name === 'request_access')!;
      const props = tool.inputSchema.properties as any;
      expect(props.clipboardRead.type).toBe('boolean');
      expect(props.clipboardWrite.type).toBe('boolean');
      expect(props.systemKeyCombos.type).toBe('boolean');
    });
  });

  describe('screenshot tool', () => {
    it('has optional save_to_disk', () => {
      const tool = COMPUTER_TOOLS.find((t) => t.name === 'screenshot')!;
      const props = tool.inputSchema.properties as any;
      expect(props.save_to_disk.type).toBe('boolean');
    });

    it('has no required params', () => {
      const tool = COMPUTER_TOOLS.find((t) => t.name === 'screenshot')!;
      expect(tool.inputSchema.required).toEqual([]);
    });
  });

  describe('type tool', () => {
    it('requires text', () => {
      const tool = COMPUTER_TOOLS.find((t) => t.name === 'type')!;
      expect(tool.inputSchema.required).toContain('text');
    });
  });

  describe('key tool', () => {
    it('requires text (key chord)', () => {
      const tool = COMPUTER_TOOLS.find((t) => t.name === 'key')!;
      expect(tool.inputSchema.required).toContain('text');
    });

    it('has repeat with range 1-100', () => {
      const tool = COMPUTER_TOOLS.find((t) => t.name === 'key')!;
      const repeat = (tool.inputSchema.properties as any).repeat;
      expect(repeat.minimum).toBe(1);
      expect(repeat.maximum).toBe(100);
    });
  });

  describe('scroll tool', () => {
    it('requires coordinate, scroll_direction, scroll_amount', () => {
      const tool = COMPUTER_TOOLS.find((t) => t.name === 'scroll')!;
      expect(tool.inputSchema.required).toContain('coordinate');
      expect(tool.inputSchema.required).toContain('scroll_direction');
      expect(tool.inputSchema.required).toContain('scroll_amount');
    });

    it('scroll_direction has 4 values', () => {
      const tool = COMPUTER_TOOLS.find((t) => t.name === 'scroll')!;
      const dir = (tool.inputSchema.properties as any).scroll_direction;
      expect(dir.enum).toEqual(['up', 'down', 'left', 'right']);
    });
  });

  describe('wait tool', () => {
    it('requires duration with range 0-100', () => {
      const tool = COMPUTER_TOOLS.find((t) => t.name === 'wait')!;
      expect(tool.inputSchema.required).toContain('duration');
      const dur = (tool.inputSchema.properties as any).duration;
      expect(dur.minimum).toBe(0);
      expect(dur.maximum).toBe(100);
    });
  });

  describe('computer_batch tool', () => {
    it('requires actions array', () => {
      const tool = COMPUTER_TOOLS.find((t) => t.name === 'computer_batch')!;
      expect(tool.inputSchema.required).toContain('actions');
      const actions = (tool.inputSchema.properties as any).actions;
      expect(actions.type).toBe('array');
    });
  });

  describe('zoom tool', () => {
    it('requires region', () => {
      const tool = COMPUTER_TOOLS.find((t) => t.name === 'zoom')!;
      expect(tool.inputSchema.required).toContain('region');
      const region = (tool.inputSchema.properties as any).region;
      expect(region.minItems).toBe(4);
      expect(region.maxItems).toBe(4);
    });
  });

  describe('no-parameter tools', () => {
    const noParamTools = ['list_granted_applications', 'read_clipboard',
      'cursor_position', 'left_mouse_down', 'left_mouse_up'];

    for (const name of noParamTools) {
      it(`${name} has no required params`, () => {
        const tool = COMPUTER_TOOLS.find((t) => t.name === name)!;
        expect(tool.inputSchema.required).toEqual([]);
      });
    }
  });
});
