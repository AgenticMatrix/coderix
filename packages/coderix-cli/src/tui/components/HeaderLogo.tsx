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

export function HeaderLogo() {
  const logoLines = CADUCEUS_ART;
  const artMaxLen = Math.max(...logoLines.map((l) => l.length));

  const Kw = ({ children }: { children: string }) => (
    <Text bold color="ansi:blackBright">{children}</Text>
  );

  const Dim = ({ children }: { children: string }) => (
    <Text dimColor color="ansi:blackBright">{children}</Text>
  );

  const rightPanel: { text: string; render: (pad: number) => React.ReactNode }[] = [
    {
      text: 'CodeRix v0.4.1',
      render: (pad) => (
        <Text>
          <Kw>CodeRix</Kw>
          <Text color="ansi:white"> v0.4.1{' '.repeat(pad)}</Text>
        </Text>
      ),
    },
    { text: '', render: (pad) => <Text>{' '.repeat(pad)}</Text> },
    {
      text: 'tools: 33',
      render: (pad) => (
        <Text>
          <Kw>tools:</Kw>
          <Text color="ansi:white"> 33{' '.repeat(pad)}</Text>
        </Text>
      ),
    },
    {
      text: '  File Operations: Read / Write / Update',
      render: (pad) => (
        <Text>
          <Dim>  File Operations:</Dim>
          <Text color="ansi:white"> Read / Write / Update{' '.repeat(pad)}</Text>
        </Text>
      ),
    },
    {
      text: '  Terminal: Bash',
      render: (pad) => (
        <Text>
          <Dim>  Terminal:</Dim>
          <Text color="ansi:white"> Bash{' '.repeat(pad)}</Text>
        </Text>
      ),
    },
    {
      text: '  Agent: Explore / Plan / general-purpose',
      render: (pad) => (
        <Text>
          <Dim>  Agent:</Dim>
          <Text color="ansi:white"> Explore / Plan / general-purpose{' '.repeat(pad)}</Text>
        </Text>
      ),
    },
    {
      text: '  Task Management: TaskCreate / TaskUpdate / TaskList / TaskGet',
      render: (pad) => (
        <Text>
          <Dim>  Task Management:</Dim>
          <Text color="ansi:white"> TaskCreate / TaskUpdate / TaskList / TaskGet{' '.repeat(pad)}</Text>
        </Text>
      ),
    },
    { text: '', render: (pad) => <Text>{' '.repeat(pad)}</Text> },
    ...(() => {
      const registry = getSkillRegistry();
      if (registry.count === 0) registry.loadFromDisk();
      const summaries = registry.getSummaries();
      const count = summaries.length;

      // Keep descriptions short to prevent the right panel from
      // overflowing the terminal width (each column is padded to
      // the longest line regardless of terminal size).
      const MAX_DESC = 60;
      function shortDesc(raw: string): string {
        if (raw.length <= MAX_DESC) return raw;
        return raw.slice(0, MAX_DESC) + '…';
      }

      const items: Array<{ text: string; render: (pad: number) => React.ReactNode }> = [
        {
          text: `skills: ${count}`,
          render: (pad) => (
            <Text>
              <Kw>skills:</Kw>
              <Text color="ansi:white"> {count}{' '.repeat(pad)}</Text>
            </Text>
          ),
        },
      ];
      for (const s of summaries) {
        const label = `  - ${s.name}`;
        const desc = `: ${shortDesc(s.description)}`;
        items.push({
          text: `${label}${desc}`,
          render: (pad) => (
            <Text>
              <Dim>{label}</Dim>
              <Text color="ansi:white">{desc}{' '.repeat(pad)}</Text>
            </Text>
          ),
        });
      }
      return items;
    })(),
    { text: '', render: (pad) => <Text>{' '.repeat(pad)}</Text> },
    {
      text: `workspace: ${process.cwd()}`,
      render: (pad) => (
        <Text>
          <Kw>workspace:</Kw>
          <Text color="ansi:white"> {process.cwd()}{' '.repeat(pad)}</Text>
        </Text>
      ),
    },
  ];

  const rightMaxLen = Math.max(...rightPanel.map((r) => r.text.length));

  const artDashLen = artMaxLen + 2;
  const rightDashLen = rightMaxLen + 2;
  // The tee glyphs ┬ / ┴ have no single-column counterpart, so the rule simply
  // runs through the join. See the corner notes in `safe-glyphs.ts`.
  const topBorder =
    CORNER_TOP_LEFT +
    HORIZONTAL_RULE.repeat(artDashLen) +
    HORIZONTAL_RULE +
    HORIZONTAL_RULE.repeat(rightDashLen) +
    CORNER_TOP_RIGHT;
  const botBorder =
    CORNER_BOTTOM_LEFT +
    HORIZONTAL_RULE.repeat(artDashLen) +
    HORIZONTAL_RULE +
    HORIZONTAL_RULE.repeat(rightDashLen) +
    CORNER_BOTTOM_RIGHT;

  const renderLine = (lineIdx: number): React.ReactNode => {
    const artLine = lineIdx < logoLines.length ? logoLines[lineIdx] : '';
    const artPadded = artLine.padEnd(artMaxLen);

    const rightEntry = rightPanel[lineIdx];
    const rightJsx = rightEntry
      ? rightEntry.render(rightMaxLen - rightEntry.text.length)
      : <Text color="ansi:white">{' '.repeat(rightMaxLen)}</Text>;

    return (
      <Text key={lineIdx}>
        <Text color="ansi:blackBright">{`${VERTICAL_SEPARATOR} `}</Text>
        <Text color="#AB47BC">{artPadded}</Text>
        <Text color="ansi:blackBright">{` ${VERTICAL_SEPARATOR} `}</Text>
        {rightJsx}
        <Text color="ansi:blackBright">{` ${VERTICAL_SEPARATOR}`}</Text>
      </Text>
    );
  };

  const totalLines = Math.max(logoLines.length, rightPanel.length);

  return (
    <Box flexDirection="column" marginBottom={1} paddingX={2}>
      <Text color="ansi:blackBright">{topBorder}</Text>
      {Array.from({ length: totalLines }, (_, i) => renderLine(i))}
      <Text color="ansi:blackBright">{botBorder}</Text>
    </Box>
  );
}
