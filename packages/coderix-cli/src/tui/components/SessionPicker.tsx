import { Box, Text, useInput } from '@coderix/ink';
import { useState } from 'react';

interface SessionSummary {
  id: string;
  title: string;
  turnCount: number;
  model: string;
  updatedAt: Date;
}

interface SessionPickerProps {
  sessions: SessionSummary[];
  onSelect: (sessionId: string) => void;
  onCancel: () => void;
}

export function SessionPicker({ sessions, onSelect, onCancel }: SessionPickerProps) {
  const [sel, setSel] = useState(0);
  const [filter, setFilter] = useState('');

  const filtered = filter
    ? sessions.filter((s) => s.title.toLowerCase().includes(filter.toLowerCase()))
    : sessions;

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }

    if (key.return) {
      const session = filtered[sel];
      if (session) onSelect(session.id);
      return;
    }

    if (key.upArrow && sel > 0) {
      setSel((s) => s - 1);
      return;
    }

    if (key.downArrow && sel < filtered.length - 1) {
      setSel((s) => s + 1);
      return;
    }

    // Number keys quick-pick
    const n = parseInt(input, 10);
    if (n >= 1 && n <= filtered.length) {
      const session = filtered[n - 1];
      if (session) onSelect(session.id);
      return;
    }

    // Typing: filter sessions by title
    if (input.length === 1) {
      setFilter((prev) => prev + input);
      setSel(0);
      return;
    }

    if (key.backspace || key.delete) {
      setFilter((prev) => prev.slice(0, -1));
      setSel(0);
    }
  });

  if (sessions.length === 0) {
    return (
      <Box borderStyle="double" borderColor="ansi:cyan" flexDirection="column" paddingX={1}>
        <Text bold color="ansi:cyan">Sessions</Text>
        <Text dimColor>No previous sessions found.</Text>
        <Text dimColor>Press Esc to close.</Text>
      </Box>
    );
  }

  return (
    <Box borderStyle="double" borderColor="ansi:cyan" flexDirection="column" paddingX={1}>
      <Text bold color="ansi:cyan">
        Sessions ({filtered.length}) — select one to resume
      </Text>
      {filter ? <Text dimColor>Filter: "{filter}"</Text> : null}

      <Text>{' '}</Text>

      {filtered.slice(0, 20).map((s, i) => {
        const updated = s.updatedAt instanceof Date
          ? s.updatedAt.toISOString().split('T')[0]
          : s.updatedAt;
        const isAuto = /^Session [0-9a-f]{8}$/.test(s.title);
        const title = isAuto ? '--' : s.title.length > 48 ? s.title.slice(0, 48) + '...' : s.title;
        const isSelected = sel === i;

        return (
          <Text key={s.id}>
            <Text
              bold={isSelected}
              color={isSelected ? 'ansi:cyan' : undefined}
              dimColor={!isSelected}
              inverse={isSelected}
            >
              {isSelected ? '> ' : '  '}
              {i + 1}. {String(s.turnCount).padStart(4)}t  {s.model.padEnd(18)}  {updated}  {title}
            </Text>
          </Text>
        );
      })}

      <Text>{' '}</Text>
      <Text dimColor>
        Up/Down select  ·  Type to filter  ·  Enter confirm  ·  1-9 quick pick  ·  Esc cancel
      </Text>
    </Box>
  );
}
