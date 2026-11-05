import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { renderSync, Box, Text } from '@coderix/tui';
import { useInputHandler } from '../hooks/useInputHandler.js';
import { chatReducer, createInitialState } from '../hooks/useChatReducer.js';

vi.mock('../clipboard-image.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    MAX_PENDING_IMAGES: 4,
    readClipboardImage: async () => ({
      ok: true,
      image: { mediaType: 'image/png', data: 'AAAA', width: 3, height: 2, bytes: 71 },
    }),
  };
});

const tick = (ms = 250) => new Promise((r) => setTimeout(r, ms));

function Harness({ onSend }: { onSend: (t: string, i?: unknown[]) => void }) {
  const [state, dispatch] = React.useReducer(chatReducer, undefined, () => createInitialState('m'));
  useInputHandler({
    inputText: state.inputText,
    cursorPosition: state.cursorPosition,
    agentPhase: 'idle',
    messages: state.messages,
    dispatch,
    onSend: (t, i) => {
      onSend(t, i);
      dispatch({ type: 'SET_INPUT', text: '' });
    },
    onInterrupt: () => {},
    onKillAll: () => {},
    onExit: () => {},
    history: [],
    historyIndex: -1,
    historyScratch: '',
    pasteBlocks: state.pasteBlocks,
    pendingImages: state.pendingImages,
    commandPickerIndex: -1,
  });
  return (
    <Box flexDirection="column">
      <Text>{'IMG:' + state.pendingImages.length}</Text>
    </Box>
  );
}

async function mount() {
  const stdout: any = new PassThrough();
  stdout.isTTY = true;
  stdout.columns = 100;
  stdout.rows = 30;
  let buf = '';
  stdout.on('data', (c: Buffer) => {
    buf += c.toString();
  });
  const stdin: any = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  const sent: any[] = [];
  const inst = renderSync(<Harness onSend={(t, i) => sent.push({ t, i })} />, {
    stdin,
    stdout,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return { stdin, sent, frame: () => buf, inst };
}

describe('useInputHandler image wiring', () => {
  it('Ctrl+V stages an image, Enter sends it with the text', async () => {
    const { stdin, sent, frame, inst } = await mount();
    stdin.write('\x16');
    await tick(500);
    expect(frame()).toContain('IMG:1');

    stdin.write('hi');
    await tick(150);
    stdin.write('\r');
    await tick(400);

    expect(sent.length).toBe(1);
    expect(sent[0].t).toBe('hi');
    expect(sent[0].i).toHaveLength(1);
    inst.unmount();
  }, 20000);

  it('Ctrl+V then Enter sends an image-only turn', async () => {
    const { stdin, sent, inst } = await mount();
    stdin.write('\x16');
    await tick(500);
    stdin.write('\r');
    await tick(400);

    expect(sent.length).toBe(1);
    expect(sent[0].t).toBe('');
    expect(sent[0].i).toHaveLength(1);
    inst.unmount();
  }, 20000);

  it('Ctrl+X drops the staged image', async () => {
    const { stdin, frame, inst } = await mount();
    stdin.write('\x16');
    await tick(500);
    expect(frame()).toContain('IMG:1');

    stdin.write('\x18');
    await tick(400);
    expect(frame()).toContain('IMG:0');
    inst.unmount();
  }, 20000);

  it('caps at four images and reports it', async () => {
    const { stdin, frame, inst } = await mount();
    for (let i = 0; i < 5; i++) {
      stdin.write('\x16');
      await tick(300);
    }
    expect(frame()).toContain('IMG:4');
    inst.unmount();
  }, 25000);
});