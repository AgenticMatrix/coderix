import { Box, Text, useInput } from '@coderix/ink';
import { useState } from 'react';

interface SessionSummary {
  id: string;
  title: string;
  turnCount: number;
  model: string;
  updatedAt: Date;
  lastUserPreview?: string;
}

interface SessionPickerProps {
  sessions: SessionSummary[];
  onSelect: (sessionId: string) => void;
  onCancel: () => void;
}

function formatRelativeTime(date: Date): string {
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ${mins % 60}m ago`;
  return `${days}d ago`;
}

function sessionLabel(s: SessionSummary): string {
  const isAuto = /^Session [0-9a-f]{8}$/.test(s.title);
  if (!isAuto && s.title.length > 0) {
    return s.title.length > 56 ? s.title.slice(0, 56) + '...' : s.title;
  }
  // Auto-generated title — use first user message as preview
  if (s.lastUserPreview) return s.lastUserPreview;
  return '--';
}

export function SessionPicker({ sessions, onSelect, onCancel }: SessionPickerProps) {
  const [sel, setSel] = useState(0);
  const [filter, setFilter] = useState('');

  const filtered = filter
    ? sessions.filter((s) => {
        const label = sessionLabel(s).toLowerCase();
        return label.includes(filter.toLowerCase());
      })
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

    // Typing: filter sessions by label
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
        const time = formatRelativeTime(s.updatedAt instanceof Date ? s.updatedAt : new Date(s.updatedAt));
        const label = sessionLabel(s);
        const turns = s.turnCount > 0 ? `${s.turnCount} turns` : 'new';
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
              {String(i + 1).padEnd(3)} {s.id.slice(0, 8)}  {turns.padEnd(10)} {time.padEnd(14)} {label}
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
