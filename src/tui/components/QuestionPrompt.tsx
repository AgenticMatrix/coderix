import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { useInput } from 'ink';

export interface QuestionPromptProps {
  questions: Array<{
    header: string;
    question: string;
    options?: Array<{ label: string; description: string }>;
    multiSelect?: boolean;
  }>;
  onAnswer: (answers: Record<string, string | string[]>) => void;
}

export function QuestionPrompt({ questions, onAnswer }: QuestionPromptProps) {
  const q = questions[0]!;
  const options = q.options ?? [];
  const [selected, setSelected] = useState<string[]>([]);
  const [customText, setCustomText] = useState('');

  const toggleOption = (label: string) => {
    if (q.multiSelect) {
      setSelected((prev) =>
        prev.includes(label)
          ? prev.filter((s) => s !== label)
          : [...prev, label],
      );
    } else {
      if (selected.includes(label)) {
        // Deselect current → allow picking another
        setSelected([]);
      } else {
        setSelected([label]);
      }
    }
  };

  useInput((input, key) => {
    if (key.return) {
      if (options.length > 0 && selected.length > 0) {
        onAnswer({
          [q.header]: q.multiSelect ? selected : selected[0]!,
        });
      } else if (customText.trim()) {
        onAnswer({ [q.header]: customText.trim() });
      } else if (options.length === 0) {
        onAnswer({ [q.header]: customText.trim() || '' });
      }
      return;
    }

    if (key.escape) {
      onAnswer({ [q.header]: '' });
      return;
    }

    // Option selection: number keys or arrow keys
    if (options.length > 0) {
      const num = parseInt(input, 10);
      if (num >= 1 && num <= options.length) {
        toggleOption(options[num - 1]!.label);
        if (!q.multiSelect) {
          // Auto-submit for single-select
          onAnswer({ [q.header]: options[num - 1]!.label });
        }
        return;
      }

      // Arrow keys for navigation + Enter to select
      if (key.upArrow || key.downArrow) {
        const idx = selected.length > 0
          ? options.findIndex((o) => o.label === selected[0])
          : -1;
        const newIdx =
          key.upArrow
            ? Math.max(0, idx - 1)
            : Math.min(options.length - 1, idx + 1);
        if (q.multiSelect) {
          toggleOption(options[newIdx]!.label);
        } else {
          setSelected([options[newIdx]!.label]);
        }
        return;
      }
    }

    // Free-text input (no options or custom answer)
    if (options.length === 0) {
      if (input) {
        setCustomText((prev) => prev + input);
      } else if (key.backspace || key.delete) {
        setCustomText((prev) => prev.slice(0, -1));
      }
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} paddingY={1}>
      <Text bold color="cyan">
        Q: {q.question}
      </Text>

      {options.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {q.multiSelect && (
            <Text dimColor>Select one or more (press Enter to confirm):</Text>
          )}
          {!q.multiSelect && (
            <Text dimColor>Choose one (press number or Enter):</Text>
          )}
          {options.map((opt, i) => {
            const isSelected = selected.includes(opt.label);
            return (
              <Box key={i}>
                <Text color={isSelected ? 'green' : 'white'}>
                  {isSelected ? (q.multiSelect ? '[x]' : '●') : (q.multiSelect ? '[ ]' : '○')}{' '}
                  {i + 1}. {opt.label}
                </Text>
                <Text dimColor> — {opt.description}</Text>
              </Box>
            );
          })}
        </Box>
      )}

      {options.length === 0 && (
        <Box marginTop={1}>
          <Text dimColor>Your answer: </Text>
          <Text color="white">{customText || '█'}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>Enter to submit · Esc to skip</Text>
      </Box>
    </Box>
  );
}
