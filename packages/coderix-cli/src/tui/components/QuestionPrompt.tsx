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
  const [qIndex, setQIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [customText, setCustomText] = useState('');

  const q = questions[qIndex]!;
  const options = q.options ?? [];
  const isLast = qIndex >= questions.length - 1;

  const submitCurrent = (answer: string | string[]) => {
    const next = { ...answers, [q.header]: answer };
    if (isLast) {
      onAnswer(next);
    } else {
      setAnswers(next);
      setSelected([]);
      setCustomText('');
      setQIndex(qIndex + 1);
    }
  };

  useInput((input, key) => {
    if (key.escape) {
      submitCurrent('');
      return;
    }

    if (key.return) {
      if (options.length > 0 && selected.length > 0) {
        submitCurrent(q.multiSelect ? selected : selected[0]!);
      } else if (customText.trim()) {
        submitCurrent(customText.trim());
      } else if (options.length === 0) {
        submitCurrent(customText.trim() || '');
      }
      return;
    }

    // Number keys for option selection
    if (options.length > 0 && input) {
      const num = parseInt(input, 10);
      if (num >= 1 && num <= options.length) {
        const label = options[num - 1]!.label;
        if (q.multiSelect) {
          setSelected(prev =>
            prev.includes(label) ? prev.filter(s => s !== label) : [...prev, label],
          );
        } else {
          submitCurrent(label);
        }
        return;
      }
    }

    // Arrow keys for navigation
    if (options.length > 0 && (key.upArrow || key.downArrow)) {
      const idx = selected.length > 0 ? options.findIndex(o => o.label === selected[0]) : -1;
      const newIdx = key.upArrow ? Math.max(0, idx - 1) : Math.min(options.length - 1, idx + 1);
      if (q.multiSelect) {
        const label = options[newIdx]!.label;
        setSelected(prev =>
          prev.includes(label) ? prev.filter(s => s !== label) : [...prev, label],
        );
      } else {
        setSelected([options[newIdx]!.label]);
      }
      return;
    }

    // Free-text input
    if (options.length === 0) {
      if (input) {
        setCustomText(prev => prev + input);
      } else if (key.backspace || key.delete) {
        setCustomText(prev => prev.slice(0, -1));
      }
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} paddingY={1}>
      {/* Progress indicator for multi-question */}
      {questions.length > 1 && (
        <Text dimColor>
          Question {qIndex + 1}/{questions.length}
        </Text>
      )}

      <Text bold color="cyan">
        Q: {q.question}
      </Text>

      {options.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {q.multiSelect && (
            <Text dimColor>Select one or more (Enter to confirm):</Text>
          )}
          {!q.multiSelect && (
            <Text dimColor>Choose one (number or Enter to select):</Text>
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
        <Text dimColor>
          Enter to submit · Esc to skip
          {questions.length > 1 ? ` · ${qIndex + 1}/${questions.length}` : ''}
        </Text>
      </Box>
    </Box>
  );
}
