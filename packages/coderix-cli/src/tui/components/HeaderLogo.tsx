import React from 'react';
import {
  Box,
  Text,
  HORIZONTAL_RULE,
  VERTICAL_SEPARATOR,
  CORNER_TOP_LEFT,
  CORNER_TOP_RIGHT,
  CORNER_BOTTOM_LEFT,
  CORNER_BOTTOM_RIGHT,
  toSafeGlyphs,
  useTerminalSize,
  textWidth,
  truncateToWidth,
  padToWidth,
} from '@coderix/tui';
import { getSkillRegistry } from '@coderix/core';;

/**
 * The art is written with the familiar ● and · so the shape stays readable in
 * source, then passed through `toSafeGlyphs` so what actually reaches the
 * terminal is single-column in every locale. Both ● (U+25CF) and · (U+00B7) are
 * East Asian **Ambiguous**: a CJK-locale terminal draws them 2 columns wide,
 * which would double the logo's width, wrap every line, and desynchronize ink's
 * cursor arithmetic for the whole frame. See `safe-glyphs.ts`.
 */
const CADUCEUS_ART = [
  '               ················',
  '             ··●●●●●●●●●●●●●··',
  '           ··●●●●●●●●●●●●●●··   ',
  '         ·●●●●●●●●●●●●●●●··     ',
  '       ··●●●●●●●●●●●●●●··       ',
  '      ··●●●●●●●●●●●●●··          ',
  '     ··●●●●●●●●●●●●●●●●··        ',
  '     ··●●●●●●●●●●●●●●●●●●●●●··   ',
  '            ··●●●●●●●●●●●●●●●··   ',
  '               ··●●●●●●●●●●··     ',
  '              ··●●●●●●●●●··       ',
  '              ··●●●●●●●●··        ',
  '             ··●●●●●●··           ',
  '            ··●●●●··              ',
  '           ··●●··                 ',
  '           ····                    ',
].map(toSafeGlyphs);

/**
 * One line of the info column, as styled runs.
 *
 * The line is kept as segments rather than finished JSX because it has to be
 * measured and truncated as a whole: the cut can land anywhere, including in
 * the middle of a run, and a renderer that truncated each run against the same
 * budget would let a long line through.
 */
type Segment = { readonly text: string; readonly tone: 'key' | 'muted' | 'value' };
type InfoLine = readonly Segment[];

const key = (text: string): Segment => ({ text, tone: 'key' });
const muted = (text: string): Segment => ({ text, tone: 'muted' });
const value = (text: string): Segment => ({ text, tone: 'value' });

const lineText = (line: InfoLine): string => line.map((s) => s.text).join('');

/**
 * Clips a line to `columns`, then pads it back out to exactly that width.
 *
 * Padding to a fixed width is what keeps the right border in a straight line,
 * and it is why the width has to be bounded in the first place: every line is
 * padded to the widest one, so a single over-long line widens the whole box.
 */
function renderInfoLine(line: InfoLine, columns: number): React.ReactNode {
  const full = lineText(line);
  const clipped = truncateToWidth(full, columns);
  const pad = columns - textWidth(clipped);

  // Nothing was cut: emit the runs as they are, with the padding appended.
  if (clipped === full) {
    return (
      <Text>
        {line.map((seg, i) => (
          <Text key={i} {...toneProps(seg.tone)}>
            {seg.text}
          </Text>
        ))}
        {pad > 0 ? <Text>{' '.repeat(pad)}</Text> : null}
      </Text>
    );
  }

  // Something was cut. Walk the runs against the clipped width so each run
  // keeps its own colour up to the cut, and the ellipsis is emitted once.
  const limit = textWidth(clipped) - 1;
  const parts: React.ReactNode[] = [];
  let used = 0;
  for (const [i, seg] of line.entries()) {
    if (used >= limit) break;
    const slice = truncateToWidth(seg.text, limit - used + 1);
    // `truncateToWidth` adds its own ellipsis when it cuts; strip it so the
    // single trailing one below is the only marker.
    const bare = slice.endsWith('…') ? slice.slice(0, -1) : slice;
    if (bare === '') continue;
    parts.push(
      <Text key={i} {...toneProps(seg.tone)}>
        {bare}
      </Text>,
    );
    used += textWidth(bare);
  }
  return (
    <Text>
      {parts}
      <Text {...toneProps('muted')}>…</Text>
      {pad > 0 ? <Text>{' '.repeat(pad)}</Text> : null}
    </Text>
  );
}

function toneProps(tone: Segment['tone']) {
  switch (tone) {
    case 'key':
      return { bold: true, color: 'ansi:blackBright' } as const;
    case 'muted':
      return { dimColor: true, color: 'ansi:blackBright' } as const;
    default:
      return { color: 'ansi:white' } as const;
  }
}

/**
 * Columns of frame around the info column when the art is shown:
 * `╎ ` + art + ` ╎ ` + info + ` ╎`, plus `paddingX={2}` on both sides.
 */
const CHROME_WITH_ART = 7 + 4;
/** The same without the art column: `╎ ` + info + ` ╎`, plus the padding. */
const CHROME_WITHOUT_ART = 4 + 4;
/** Below this many columns for the info itself, the art is dropped instead. */
const MIN_INFO_COLUMNS = 24;

export function HeaderLogo() {
  const { columns } = useTerminalSize();
  const logoLines = CADUCEUS_ART;
  const artMaxLen = Math.max(...logoLines.map((l) => textWidth(l)));

  // The banner is the first `<Static>` item: printed once, straight into
  // scrollback, never repainted. So its height is a permanent cost, and it is
  // capped at the art's own height rather than left to grow with whatever
  // happens to be installed on disk.
  const maxInfoLines = logoLines.length;

  const skillLines = ((): InfoLine[] => {
    const registry = getSkillRegistry();
    if (registry.count === 0) registry.loadFromDisk();
    const summaries = registry.getSummaries();

    // Everything except the skill list is fixed, so the list gets whatever
    // rows are left. `- 1` leaves a row for the "and N more" note.
    const fixedLines = 11;
    const budget = Math.max(0, maxInfoLines - fixedLines);

    const lines: InfoLine[] = [[key('skills:'), value(` ${summaries.length}`)]];
    const shown = summaries.length <= budget ? summaries : summaries.slice(0, Math.max(0, budget - 1));
    for (const s of shown) {
      // Descriptions are free-form and often multi-line YAML; only the first
      // line can appear on a single row, and it is clipped to the terminal by
      // `renderInfoLine` regardless of how long it is.
      const firstLine = s.description.split('\n')[0]!.trim();
      lines.push([muted(`  - ${s.name}`), value(`: ${firstLine}`)]);
    }
    const hidden = summaries.length - shown.length;
    if (hidden > 0) lines.push([muted(`  … and ${hidden} more`)]);
    return lines;
  })();

  const infoLines: InfoLine[] = [
    [key('CodeRix'), value(' v0.4.1')],
    [],
    [key('tools:'), value(' 33')],
    [muted('  File Operations:'), value(' Read / Write / Update')],
    [muted('  Terminal:'), value(' Bash')],
    [muted('  Agent:'), value(' Explore / Plan / general-purpose')],
    [muted('  Task Management:'), value(' TaskCreate / TaskUpdate / TaskList / TaskGet')],
    [],
    ...skillLines,
    [],
    [key('workspace:'), value(` ${process.cwd()}`)],
  ].slice(0, maxInfoLines);

  // The width the info column WANTS, and the width the terminal can actually
  // give it. Taking the smaller of the two is the whole fix: every one of these
  // lines is padded to the chosen width, so leaving it unbounded made a single
  // long line soft-wrap EVERY row — turning an 18-row banner into 36 rows and
  // pushing it off the top of the screen at startup.
  const naturalInfo = Math.max(...infoLines.map((l) => textWidth(lineText(l))));
  const showArt = columns - artMaxLen - CHROME_WITH_ART >= MIN_INFO_COLUMNS;
  const availableInfo = showArt
    ? columns - artMaxLen - CHROME_WITH_ART
    : columns - CHROME_WITHOUT_ART;
  const infoWidth = Math.max(1, Math.min(naturalInfo, availableInfo));

  const border = (left: string, right: string) =>
    showArt
      ? left +
        HORIZONTAL_RULE.repeat(artMaxLen + 2) +
        HORIZONTAL_RULE +
        HORIZONTAL_RULE.repeat(infoWidth + 2) +
        right
      : left + HORIZONTAL_RULE.repeat(infoWidth + 2) + right;

  const renderRow = (index: number): React.ReactNode => {
    const info = infoLines[index];
    const infoJsx = info
      ? renderInfoLine(info, infoWidth)
      : <Text>{' '.repeat(infoWidth)}</Text>;

    return (
      <Text key={index}>
        <Text color="ansi:blackBright">{`${VERTICAL_SEPARATOR} `}</Text>
        {showArt ? (
          <>
            <Text color="#AB47BC">{padToWidth(logoLines[index] ?? '', artMaxLen)}</Text>
            <Text color="ansi:blackBright">{` ${VERTICAL_SEPARATOR} `}</Text>
          </>
        ) : null}
        {infoJsx}
        <Text color="ansi:blackBright">{` ${VERTICAL_SEPARATOR}`}</Text>
      </Text>
    );
  };

  const totalRows = showArt
    ? Math.max(logoLines.length, infoLines.length)
    : infoLines.length;

  return (
    <Box flexDirection="column" marginBottom={1} paddingX={2}>
      <Text color="ansi:blackBright">{border(CORNER_TOP_LEFT, CORNER_TOP_RIGHT)}</Text>
      {Array.from({ length: totalRows }, (_, i) => renderRow(i))}
      <Text color="ansi:blackBright">{border(CORNER_BOTTOM_LEFT, CORNER_BOTTOM_RIGHT)}</Text>
    </Box>
  );
}
