import { Box, Text } from 'ink';
import { useState, useEffect } from 'react';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function ThinkingIcon({ active }: { active: boolean }) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 120);
    return () => clearInterval(id);
  }, [active]);

  return (
    <Box width={2} flexShrink={0}>
      <Text color="#4FC3F7">
        {active ? SPINNER_FRAMES[frame] : '●'}
      </Text>
    </Box>
  );
}

function ThinkingHeader({ active, duration, tokens }: { active: boolean; duration?: number; tokens?: number }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!active) return;
    const start = Date.now();
    const id = setInterval(() => setElapsed(Date.now() - start), 100);
    return () => clearInterval(id);
  }, [active]);

  const seconds = active ? (elapsed / 1000) : ((duration ?? 0) / 1000);
  const timeStr = `${seconds.toFixed(1)}s`;
  const tokenStr = tokens != null ? `${tokens} tokens` : null;

  return (
    <Text>
      <Text>Cogitating</Text>
      <Text dimColor> · {timeStr}</Text>
      {tokenStr ? <Text dimColor> · {tokenStr}</Text> : null}
    </Text>
  );
}

/** Word-wrap plain text at word boundaries, respecting display width. */
function wordWrapText(text: string, maxWidth: number): string[] {
  const result: string[] = [];
  for (const line of text.split('\n')) {
    const words = line.split(/(?<=\s)/);
    let cur = '';
    let curW = 0;
    for (const word of words) {
      const w = displayWidth(word);
      if (curW === 0 || curW + w <= maxWidth) {
        cur += word;
        curW += w;
      } else {
        if (cur) result.push(cur);
        cur = word.replace(/^\s+/, '');
        curW = displayWidth(cur);
      }
    }
    if (cur) result.push(cur);
  }
  return result;
}

/** Get the visible display width of a string for terminal column alignment. */
export function displayWidth(str: string): number {
  let width = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0) ?? 0;
    if (
      (cp >= 0x0300 && cp <= 0x036F) ||
      (cp >= 0x0483 && cp <= 0x0489) ||
      (cp >= 0x0591 && cp <= 0x05BD) ||
      cp === 0x05BF ||
      (cp >= 0x05C1 && cp <= 0x05C2) ||
      (cp >= 0x05C4 && cp <= 0x05C5) ||
      cp === 0x05C7 ||
      cp === 0x0610 || cp === 0x061A ||
      (cp >= 0x064B && cp <= 0x065F) ||
      cp === 0x0670 ||
      (cp >= 0x06D6 && cp <= 0x06DC) ||
      (cp >= 0x06DF && cp <= 0x06E4) ||
      (cp >= 0x06E7 && cp <= 0x06E8) ||
      (cp >= 0x06EA && cp <= 0x06ED) ||
      cp === 0x0711 ||
      (cp >= 0x0730 && cp <= 0x074A) ||
      (cp >= 0x07A6 && cp <= 0x07B0) ||
      (cp >= 0x0900 && cp <= 0x0902) ||
      cp === 0x093A || cp === 0x093C ||
      (cp >= 0x0941 && cp <= 0x0948) ||
      cp === 0x094D ||
      (cp >= 0x0E31 && cp <= 0x0E3A) ||
      (cp >= 0x0E47 && cp <= 0x0E4E) ||
      cp === 0x200B ||
      cp === 0x200C ||
      cp === 0x200D ||
      (cp >= 0x200E && cp <= 0x200F) ||
      (cp >= 0x2028 && cp <= 0x202E) ||
      cp === 0x2060 ||
      (cp >= 0xFE00 && cp <= 0xFE0F) ||
      cp === 0xFEFF
    ) continue;
    if (
      (cp >= 0x1100 && cp <= 0x115F) ||
      (cp >= 0x231A && cp <= 0x23FF) ||
      (cp >= 0x2600 && cp <= 0x27BF) ||
      (cp >= 0x2E80 && cp <= 0xA4CF) ||
      cp === 0xA960 || cp === 0xA961 ||
      cp === 0xA963 || cp === 0xA96C ||
      (cp >= 0xAC00 && cp <= 0xD7A3) ||
      (cp >= 0xF900 && cp <= 0xFAFF) ||
      (cp >= 0xFE10 && cp <= 0xFE19) ||
      (cp >= 0xFE30 && cp <= 0xFE6F) ||
      (cp >= 0xFF01 && cp <= 0xFF60) ||
      (cp >= 0xFFE0 && cp <= 0xFFE6) ||
      (cp >= 0x1F000 && cp <= 0x1F9FF) ||
      (cp >= 0x1FA00 && cp <= 0x1FAFF) ||
      (cp >= 0x20000 && cp <= 0x2FFFD) ||
      (cp >= 0x30000 && cp <= 0x3FFFD)
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

interface ThinkingBlockRendererProps {
  content: string;
  thinkingExpanded?: boolean;
  thinkingDuration?: number;
  thinkingTokens?: number;
}

/**
 * Standalone thinking block renderer.
 * Renders the animated icon + Cogitating header + collapsible thinking content.
 */
export function ThinkingBlockRenderer({ content, thinkingExpanded, thinkingDuration, thinkingTokens }: ThinkingBlockRendererProps) {
  const isThoughtDone = thinkingDuration != null;
  const thinkingLines = content.split('\n');
  const tooLong = thinkingLines.length > 2;
  const collapsed = tooLong && !thinkingExpanded;
  const logicalLines = collapsed
    ? thinkingLines.slice(0, 2)
    : thinkingLines;

  return (
    <Box flexDirection="row" marginBottom={1}>
      <ThinkingIcon active={!isThoughtDone} />
      <Box flexDirection="column" flexGrow={1}>
        <ThinkingHeader active={!isThoughtDone} duration={thinkingDuration} tokens={thinkingTokens} />
        <Box paddingLeft={2} flexDirection="column">
          {logicalLines.map((line, i) => (
            <Text key={i} dimColor color="grey">{line || ' '}</Text>
          ))}
          {collapsed ? (
            <Text dimColor color="grey">{`... ${thinkingLines.length - 2} more lines (Ctrl+D to detail)`}</Text>
          ) : null}
          {tooLong && thinkingExpanded ? (
            <Text dimColor color="grey">{'(Ctrl+D to detail)'}</Text>
          ) : null}
        </Box>
      </Box>
    </Box>
  );
}
