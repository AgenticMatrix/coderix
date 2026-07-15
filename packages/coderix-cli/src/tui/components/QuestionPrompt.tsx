import React, { useState } from 'react';
import { Box, Text } from '@coderix/ink';
import { useInput } from '@coderix/ink';

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
  const firstQ = questions[0]!;
  const [qIndex, setQIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [selected, setSelected] = useState<string[]>(
    firstQ.multiSelect ? [] : (firstQ.options?.length ? [firstQ.options[0].label] : []),
  );
  const [cursorIndex, setCursorIndex] = useState(0);
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
      const nextQ = questions[qIndex + 1]!;
      setSelected(nextQ.multiSelect ? [] : (nextQ.options?.length ? [nextQ.options[0]!.label] : []));
      setCustomText('');
      setCursorIndex(0);
      setQIndex(qIndex + 1);
    }
  };

  useInput((input, key) => {
    if (key.escape) {
      submitCurrent('');
      return;
    }

    // Ctrl+C denies the question (same as Esc)
    if ((key.ctrl && (input === 'c' || input === '\x03')) || input === '\x03') {
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

    // Space key toggles selection in multi-select mode
    if (input === ' ' && q.multiSelect && options.length > 0) {
      const label = options[cursorIndex]!.label;
      setSelected(prev =>
        prev.includes(label) ? prev.filter(s => s !== label) : [...prev, label],
      );
      return;
    }

    // Number keys for quick option selection
    if (options.length > 0 && input) {
      const num = parseInt(input, 10);
      if (num >= 1 && num <= options.length) {
        const label = options[num - 1]!.label;
        setCursorIndex(num - 1);
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

    // Arrow keys move the cursor (toggle in single-select, navigate in multi-select)
    if (options.length > 0 && (key.upArrow || key.downArrow)) {
      const newIdx = key.upArrow
        ? Math.max(0, cursorIndex - 1)
        : Math.min(options.length - 1, cursorIndex + 1);
      if (q.multiSelect) {
        setCursorIndex(newIdx);
      } else {
        setSelected([options[newIdx]!.label]);
        setCursorIndex(newIdx);
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
    <Box flexDirection="column" borderStyle="round" borderColor="ansi:cyan" paddingX={1} paddingY={1}>
      {/* Progress indicator for multi-question */}
      {questions.length > 1 && (
        <Text dimColor>
          Question {qIndex + 1}/{questions.length}
        </Text>
      )}

      <Text bold color="ansi:cyan">
        Q: {q.question}
      </Text>

      {options.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {!q.multiSelect && (
            <Text dimColor>Choose one (number or Enter to select):</Text>
          )}
          {options.map((opt, i) => {
            const isSelected = selected.includes(opt.label);
            const isCursor = cursorIndex === i;
            return (
              <Box key={i}>
                <Text color={isCursor ? 'ansi:cyan' : isSelected ? 'ansi:green' : 'ansi:white'}>
                  {isCursor ? '❯' : ' '}{' '}
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
          <Text color="ansi:white">{customText || '█'}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          {q.multiSelect
            ? 'Space to select · Enter to submit · Esc to skip'
            : 'Enter to submit · Esc to skip'}
          {questions.length > 1 ? ` · ${qIndex + 1}/${questions.length}` : ''}
        </Text>
      </Box>
    </Box>
  );
}
