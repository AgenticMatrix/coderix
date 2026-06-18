/**
 * Chrome Use MCP - Tool Schema validation tests.
 */

import { describe, it, expect } from 'vitest';
import { BROWSER_TOOLS } from '../../../../src/mcp/builtin/chrome-mcp/tools.js';

describe('BROWSER_TOOLS', () => {
  it('has 15 tools', () => {
    expect(BROWSER_TOOLS).toHaveLength(15);
  });

  it('every tool has name, description, inputSchema', () => {
    for (const tool of BROWSER_TOOLS) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('every tool name is unique', () => {
    const names = BROWSER_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  describe('tabId parameter consistency', () => {
    const toolsWithTabIdRequired = ['javascript_tool', 'read_page', 'find', 'form_input', 'computer',
      'navigate', 'resize_window', 'gif_creator', 'upload_image', 'get_page_text',
      'read_console_messages', 'read_network_requests'];
    const toolsWithTabIdOptional = ['tabs_context_mcp', 'tabs_create_mcp', 'update_plan'];

    for (const name of toolsWithTabIdRequired) {
      it(`${name} has tabId in required params`, () => {
        const tool = BROWSER_TOOLS.find((t) => t.name === name);
        expect(tool).toBeDefined();
        expect(tool!.inputSchema.required).toContain('tabId');
      });
    }
  });

  describe('computer tool has 13 actions', () => {
    it('has all expected actions', () => {
      const computer = BROWSER_TOOLS.find((t) => t.name === 'computer');
      expect(computer).toBeDefined();
      const actions = (computer!.inputSchema.properties as any).action.enum;
      expect(actions).toContain('left_click');
      expect(actions).toContain('right_click');
      expect(actions).toContain('double_click');
      expect(actions).toContain('triple_click');
      expect(actions).toContain('hover');
      expect(actions).toContain('scroll');
      expect(actions).toContain('scroll_to');
      expect(actions).toContain('type');
      expect(actions).toContain('key');
      expect(actions).toContain('screenshot');
      expect(actions).toContain('wait');
      expect(actions).toContain('zoom');
      expect(actions).toContain('left_click_drag');
      expect(actions).toHaveLength(13);
    });
  });

  describe('read_page tool', () => {
    it('has filter enum', () => {
      const tool = BROWSER_TOOLS.find((t) => t.name === 'read_page');
      expect(tool).toBeDefined();
      const filter = (tool!.inputSchema.properties as any).filter;
      expect(filter.enum).toEqual(['interactive', 'all']);
    });
  });

  describe('gif_creator tool', () => {
    it('has 4 actions', () => {
      const tool = BROWSER_TOOLS.find((t) => t.name === 'gif_creator');
      const actions = (tool!.inputSchema.properties as any).action.enum;
      expect(actions).toEqual(['start_recording', 'stop_recording', 'export', 'clear']);
    });
  });

  describe('navigate tool', () => {
    it('requires url', () => {
      const tool = BROWSER_TOOLS.find((t) => t.name === 'navigate');
      expect(tool!.inputSchema.required).toContain('url');
    });
  });

  describe('form_input tool', () => {
    it('requires ref and value', () => {
      const tool = BROWSER_TOOLS.find((t) => t.name === 'form_input');
      expect(tool!.inputSchema.required).toContain('ref');
      expect(tool!.inputSchema.required).toContain('value');
    });
  });

  describe('update_plan tool', () => {
    it('requires domains and approach arrays', () => {
      const tool = BROWSER_TOOLS.find((t) => t.name === 'update_plan');
      expect(tool!.inputSchema.required).toContain('domains');
      expect(tool!.inputSchema.required).toContain('approach');
    });
  });
});
