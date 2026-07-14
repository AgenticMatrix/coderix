import { Box, Text, useInput } from '@coderix/ink';
import { useState, useEffect, useRef } from 'react';
import { homedir } from 'os';
import { resolve } from 'path';

import {
  loadMemoryConfig,
  getMemoryDir,
  loadIndex,
} from '@coderix/core';

interface MemoryPickerProps {
  cwd: string;
  onSelect: (target: 'user' | 'project' | 'auto') => void;
  onCancel: () => void;
}

type Option = { key: 'user' | 'project' | 'auto'; label: string; desc: string };

export function MemoryPicker({ cwd, onSelect, onCancel }: MemoryPickerProps) {
  const [sel, setSel] = useState(0);
  const [entryCount, setEntryCount] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const startedRef = useRef(false);

  const config = loadMemoryConfig();
  const memDir = getMemoryDir(cwd);

  const options: Option[] = [
    {
      key: 'user',
      label: 'User memory',
      desc: resolve(homedir(), '.coderix', 'CODER.md'),
    },
    {
      key: 'project',
      label: 'Project memory',
      desc: resolve(cwd, 'CODERIX.md'),
    },
    {
      key: 'auto',
      label: 'Open auto-memory folder',
      desc: memDir,
    },
  ];

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    loadIndex(cwd)
      .then(({ entries }) => setEntryCount(entries.length))
      .catch((err: Error) => setLoadError(err.message));
  }, [cwd]);

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }

    if (key.return) {
      const opt = options[sel];
      if (opt) onSelect(opt.key);
      return;
    }

    if (key.upArrow && sel > 0) {
      setSel((s) => s - 1);
      return;
    }

    if (key.downArrow && sel < options.length - 1) {
      setSel((s) => s + 1);
      return;
    }

    const n = parseInt(_input, 10);
    if (n >= 1 && n <= options.length) {
      onSelect(options[n - 1].key);
    }
  });

  const statusText = config.enabled ? 'on' : 'off';
  const statusColor = config.enabled ? 'ansi:green' : 'ansi:yellow';

  return (
    <Box borderStyle="round" borderColor="ansi:cyan" flexDirection="column" paddingX={1} paddingY={1}>
      <Text bold color="ansi:cyan">
        Memory
      </Text>

      <Text>
        <Text>    Auto-memory: </Text>
        <Text color={statusColor}>{statusText}</Text>
        {entryCount !== null && entryCount > 0 && (
          <Text dimColor> ({entryCount} entries)</Text>
        )}
        {entryCount === null && !loadError && (
          <Text dimColor> (loading...)</Text>
        )}
      </Text>

      <Text>{' '}</Text>

      {options.map((opt, i) => {
        const isSelected = sel === i;
        return (
          <Text key={opt.key}>
            <Text
              bold={isSelected}
              color={isSelected ? 'ansi:cyan' : undefined}
              dimColor={!isSelected}
              inverse={isSelected}
            >
              {isSelected ? '❯ ' : '  '}
              {i + 1}. {opt.label}
            </Text>
            <Text dimColor> — {opt.desc}</Text>
          </Text>
        );
      })}

      {loadError && (
        <Text color="ansi:red">  Error: {loadError}</Text>
      )}

      <Text>{' '}</Text>
      <Text dimColor>
        Up/Down select · Enter confirm · 1-3 quick pick · Esc cancel
      </Text>
    </Box>
  );
}
