import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { splitTranscript } from '../transcript-commit.js';
import type { Message } from '../../../types.js';

/**
 * A finished answer must not be trapped in the clipped live region.
 *
 * The live half is a `ScrollBox`: it clips to the viewport and, being sticky,
 * shows the BOTTOM. Rows above the window are never written to the terminal, so
 * they are not in scrollback either — and no keybinding drives the ScrollBox's
 * scroll API (PageUp only freezes the display). A row that stays live and does
 * not fit is therefore unreachable by ANY means.
 *
 * That is survivable while a message is still streaming: it is about to change,
 * it cannot be committed, and the user is watching its tail. It is not
 * survivable once the turn is over. `keepLive` used to hold the newest message
 * back unconditionally, so the final answer of every turn — the one the user
 * actually wants to read — was exactly the one that could never commit. A reply
 * taller than the viewport lost its top: a table would show its bottom border
 * with the rows above it simply absent.
 *
 * Hence the rule: hold a message back only while something is still arriving.
 * The reason for holding one back at all is that a tool result can land in a
 * message that already looks settled, and a committed row cannot be redrawn —
 * but that risk exists only while the turn is in flight.
 */

let nextId = 1;

function settled(text = 'answer'): Message {
  return {
    id: nextId++,
    role: 'assistant',
    content: text,
    blocks: [{ type: 'text', content: text }],
    timestamp: Date.now(),
  } as Message;
}

function withRunningTool(): Message {
  return {
    id: nextId++,
    role: 'assistant',
    content: '',
    blocks: [
      { type: 'tool_use', toolId: `t${nextId}`, toolName: 'bash', input: {}, state: 'executing' },
    ],
    timestamp: Date.now(),
  } as unknown as Message;
}

describe('the commit boundary at the end of a turn', () => {
  it('commits the final answer once the turn is over', () => {
    // The regression. Everything settled and nothing streaming means nothing
    // can still change, so nothing needs to stay in the clipped region.
    const messages = [settled('first'), settled('second'), settled('final answer')];
    const { committed, live } = splitTranscript(messages, { streaming: false });

    expect(committed.length, 'a settled transcript commits in full').toBe(3);
    expect(live, 'nothing is trapped in the clipped live region').toEqual([]);
  });

  it('holds the newest message back while the turn is still streaming', () => {
    // The reason `keepLive` exists: a result can still land in the newest
    // message, and a committed row can never be redrawn.
    const messages = [settled('first'), settled('second')];
    const { committed, live } = splitTranscript(messages, { streaming: true });

    expect(committed.length).toBe(1);
    expect(live.length, 'the newest message stays editable while streaming').toBe(1);
    expect(live[0]!.content).toBe('second');
  });

  it('still refuses to commit a message whose tool is unsettled', () => {
    // The safety rule outranks the new one: not streaming does not make a
    // running tool safe to commit.
    const messages = [settled('first'), withRunningTool(), settled('later')];
    const { committed, live } = splitTranscript(messages, { streaming: false });

    expect(committed.length, 'the scan stops at the unsettled message').toBe(1);
    expect(live.length).toBe(2);
    for (const message of committed) {
      const unsettled = message.blocks.filter(
        (b) => b.type === 'tool_use' && b.state !== 'done' && b.state !== 'error',
      );
      expect(unsettled, `message ${message.id} committed with a live tool`).toEqual([]);
    }
  });

  it('commits an empty transcript without complaint', () => {
    expect(splitTranscript([], { streaming: false }).committed).toEqual([]);
    expect(splitTranscript([], { streaming: true }).committed).toEqual([]);
  });

  it('defaults to the safe behaviour when the turn state is unknown', () => {
    // A caller that forgets to say keeps the conservative old semantics, so an
    // un-migrated call site cannot silently commit a streaming message.
    const messages = [settled('first'), settled('second')];
    expect(splitTranscript(messages).committed.length).toBe(1);
  });

  it('is actually told the turn state by App.tsx', () => {
    // Because the default above is the BUGGY behaviour, the fix lives at the
    // call site as much as in the function. Dropping the option would restore
    // the defect while every other test here still passed, so the wiring is
    // pinned too. Asserted against source text: reaching this line behaviourally
    // needs the whole `App` with a live engine, and a test double would
    // constrain nothing.
    const app = readFileSync(fileURLToPath(new URL('../App.tsx', import.meta.url)), 'utf8');
    expect(app).toMatch(
      /splitTranscript\(\s*displayMessages\s*,\s*\{\s*streaming:\s*state\.isStreaming\s*\}\s*\)/,
    );
  });
});
