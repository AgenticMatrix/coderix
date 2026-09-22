import { PassThrough } from 'node:stream';
import React from 'react';
import { renderSync, Box, Text, Divider, ScrollBox, useVirtualScroll } from '@coderix/tui';
import type { ScrollBoxHandle } from '@coderix/tui';
import { MarkdownRenderer } from './src/tui/components/MarkdownRenderer.js';

const WIDTH = 60;
const HEIGHT = 30;

function makeStdout() {
  const stream = new PassThrough();
  let buf = '';
  stream.on('data', (c) => (buf += c.toString()));
  (stream as any).columns = WIDTH;
  (stream as any).rows = HEIGHT;
  (stream as any).isTTY = true;
  return { stream, getOutput: () => buf };
}

/** Normalize to the visible characters the user sees (cursor-forward → spaces, strip ANSI). */
function visible(s: string): string {
  return s
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)?/g, '') // OSC
    .replace(/\x1b\[(\d*)C/g, (_, n: string) => ' '.repeat(n ? Number(n) : 1)) // cursor forward
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '') // remaining CSI
    .replace(/\x1b[=>]|\x1b[()][A-Z0-9]/g, '') // other escapes
    .replace(/\r/g, '');
}

const MARKDOWN = [
  '# Heading 1',
  '## Heading 2',
  'Some **bold** and *italic* and `inline code` and [link](http://x).',
  '',
  '- item one',
  '- item two',
  '  - nested',
  '',
  '| col a | col b |',
  '|-------|-------|',
  '| 1     | 2     |',
  '',
  '```ts',
  'const x = 1;',
  'function f() { return x; }',
  '```',
  '',
  '> a quote',
].join('\n');

function ColorFixture() {
  return (
    <Box flexDirection="column">
      <Text color="ansi:red">red ansi</Text>
      <Text color="ansi:blackBright">blackBright ansi</Text>
      <Text color="#A855F7">hex purple</Text>
      <Text color="rgb(1,200,3)">rgb green</Text>
      <Text color="ansi256(196)">ansi256 red</Text>
      <Divider padding={2} />
    </Box>
  );
}

function VirtualListFixture() {
  const items = ['one', 'two\nthree', 'four', 'five', 'six\nseven\neight', 'nine'];
  const scrollRef = React.createRef<ScrollBoxHandle>();
  return (
    <Box flexDirection="column" height={8}>
      <Text>HEADER</Text>
      <ScrollBox ref={scrollRef} flexGrow={1} stickyScroll>
        <InnerList items={items} scrollRef={scrollRef} />
      </ScrollBox>
      <Text>FOOTER</Text>
    </Box>
  );
}

function InnerList({
  items,
  scrollRef,
}: {
  items: string[];
  scrollRef: React.RefObject<ScrollBoxHandle | null>;
}) {
  const { range, topSpacer, bottomSpacer, measureRef, spacerRef } = useVirtualScroll(
    scrollRef,
    items,
    WIDTH,
    { maxMounted: 200, overscan: 40, estimateHeight: 1 },
  );
  const [s, e] = range;
  return (
    <>
      <Box ref={spacerRef} height={topSpacer} flexShrink={0} />
      {items.slice(s, e).map((it, i) => (
        <Box key={items[s + i]} ref={measureRef(items[s + i]!)} flexDirection="column">
          <Text>{it}</Text>
        </Box>
      ))}
      {bottomSpacer > 0 && <Box height={bottomSpacer} flexShrink={0} />}
    </>
  );
}

async function renderFixture(name: string, el: React.ReactNode) {
  const { stream, getOutput } = makeStdout();
  const inst = renderSync(el, {
    stdout: stream,
    exitOnCtrlC: false,
    patchConsole: false,
    interactive: false,
  });
  await new Promise((r) => setTimeout(r, 400));
  inst.unmount();
  await new Promise((r) => setTimeout(r, 50));
  const raw = getOutput();
  console.log(`\n========== ${name} (raw) ==========`);
  console.log(JSON.stringify(raw));
  console.log(`========== ${name} (clean) ==========`);
  console.log(JSON.stringify(visible(raw)));
}

async function main() {
  await renderFixture('color', React.createElement(ColorFixture));
  await renderFixture('markdown', React.createElement(MarkdownRenderer, { content: MARKDOWN, theme: 'dark' }));
  await renderFixture('virtuallist', React.createElement(VirtualListFixture));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
