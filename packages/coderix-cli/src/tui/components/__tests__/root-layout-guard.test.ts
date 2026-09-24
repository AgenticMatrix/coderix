import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * A structural guard on the root element of the transcript.
 *
 * Ink renders the committed (`<Static>`) region into a buffer sized from that
 * node's own computed height, while writing each row at
 * `offsetY + getComputedTop()`. Any vertical offset ABOVE the region therefore
 * shifts its rows without enlarging the buffer, and the rows pushed past the
 * bottom are dropped — never written to the terminal at all. One row of
 * `paddingTop` loses the last committed message, two lose the last two.
 * `static-region.test.tsx` pins that behaviour against ink directly.
 *
 * On screen it reads as a message vanishing at the instant it is committed. When
 * the message holds a tool that later settles, the live region redraws the
 * corrected copy and the tool's header ends up on two adjacent rows — the
 * reported symptom.
 *
 * Asserted against the source text because the failure is invisible in a
 * rendered snapshot: the layout looks correct, and the dropped rows simply never
 * appear. A behavioural test would need the full `App` with a live engine, and
 * a test double would not constrain `App.tsx` at all — which is precisely the
 * hole this closes.
 */

const APP_SOURCE = readFileSync(
  fileURLToPath(new URL('../App.tsx', import.meta.url)),
  'utf8',
);

/** The root element's opening tag, i.e. the first `<Box>` of the returned tree. */
function rootOpeningTag(source: string): string {
  const marker = '  return (\n    <Box';
  const start = source.lastIndexOf(marker);
  expect(start, 'the root <Box> of App’s returned tree').toBeGreaterThan(-1);
  const from = start + '  return (\n'.length;
  return source.slice(from, source.indexOf('>', from) + 1);
}

describe('the root element above the committed region', () => {
  it('applies no top padding, which would drop committed rows', () => {
    const tag = rootOpeningTag(APP_SOURCE);
    expect(tag).not.toMatch(/\bpaddingTop\b/);
    // `padding` and `paddingY` set the top edge too.
    expect(tag).not.toMatch(/\bpadding\b\s*=/);
    expect(tag).not.toMatch(/\bpaddingY\b/);
    expect(tag).not.toMatch(/\bmarginTop\b/);
  });

  it('spaces the transcript with a sibling row instead', () => {
    // The supported alternative: a zero-content box laid out INSIDE the flow, so
    // the static region's height and its children's offsets agree.
    expect(APP_SOURCE).toMatch(/<Box height=\{1\} flexShrink=\{0\} \/>/);
  });

  it('puts no vertical offset on the Static element itself', () => {
    const staticTag = APP_SOURCE.slice(
      APP_SOURCE.indexOf('<Static'),
      APP_SOURCE.indexOf('>', APP_SOURCE.indexOf('<Static')) + 1,
    );
    expect(staticTag).toMatch(/<Static/);
    expect(staticTag).not.toMatch(/marginTop|paddingTop/);
  });
});
