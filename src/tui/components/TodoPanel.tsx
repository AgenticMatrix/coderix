import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { getTaskListId } from '../../tasks/store.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

interface TodoItem {
  content: string;
  status: string;
  activeForm: string;
}

interface TodoStore {
  todos: TodoItem[];
  updatedAt: number;
}

interface TodoPanelProps {
  dismissed: boolean;
  onDismissReset?: () => void;
}

const TODOS_BASE_DIR = join(homedir(), '.coder', 'todos');
const POLL_INTERVAL_MS = 1000;

/** Hourglass flip animation: ⏳ sand-up → ⌛ sand-down, repeat */
const HOURGLASS_FRAMES = ['⏳', '⌛'];
const ANIMATION_INTERVAL_MS = 500;

function getTodoPath(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '-');
  return join(TODOS_BASE_DIR, `${safe}.json`);
}

async function loadTodos(sessionId: string): Promise<TodoItem[]> {
  try {
    const content = await readFile(getTodoPath(sessionId), 'utf-8');
    const data = JSON.parse(content) as TodoStore;
    return Array.isArray(data.todos) ? data.todos : [];
  } catch {
    return [];
  }
}

const STATUS_ICON: Record<string, string> = {
  pending: '○',
  in_progress: '⏳',
  completed: '✓',
};

const STATUS_COLOR: Record<string, string> = {
  pending: undefined as unknown as string,
  in_progress: 'yellow',
  completed: 'green',
};

/**
 * Fixed Todo panel pinned above the input box for V1 todo-write todos.
 */
export function TodoPanel({ dismissed, onDismissReset }: TodoPanelProps) {
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [frame, setFrame] = useState(0);
  const prevFingerprint = useState<string>('')[1];
  const hasActiveTodos = todos.some(t => t.status === 'in_progress');

  // Animate hourglass when there are active todos
  useEffect(() => {
    if (!hasActiveTodos) {
      setFrame(0);
      return;
    }
    const id = setInterval(() => {
      setFrame(f => (f + 1) % HOURGLASS_FRAMES.length);
    }, ANIMATION_INTERVAL_MS);
    return () => clearInterval(id);
  }, [hasActiveTodos]);

  useEffect(() => {
    let active = true;
    let lastFp = '';

    async function poll() {
      try {
        const sessionId = getTaskListId();
        const current = await loadTodos(sessionId);
        if (!active) return;

        const fp = current.map(t => `${t.content}:${t.status}`).join('|');
        if (fp !== lastFp) {
          lastFp = fp;
          setTodos(current);
        }

        // Auto-dismiss when all done
        const allDone = current.length > 0 && current.every(t => t.status === 'completed');
        if (!allDone) {
          if (dismissed) onDismissReset?.();
        }
      } catch {
        // Silently ignore poll errors
      }
    }

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [dismissed, onDismissReset]);

  if (dismissed || todos.length === 0) return null;

  const pendingCount = todos.filter(t => t.status === 'pending').length;
  const activeCount = todos.filter(t => t.status === 'in_progress').length;
  const doneCount = todos.filter(t => t.status === 'completed').length;

  // Sort: in_progress → pending → completed
  const sorted = [...todos].sort((a, b) => {
    const order: Record<string, number> = { in_progress: 0, pending: 1, completed: 2 };
    return (order[a.status] ?? 1) - (order[b.status] ?? 1);
  });

  const display = sorted.slice(0, 8);
  const truncated = sorted.length - display.length;
  const hasActive = activeCount > 0;

  return (
    <Box flexDirection="column" flexShrink={0} alignSelf="flex-start" paddingX={1} borderStyle="single" borderColor="grey">
      <Box>
        <Text bold>Todo </Text>
        <Text dimColor>
          ({pendingCount} pending, {activeCount} active
          {doneCount > 0 ? `, ${doneCount} done` : ''})
        </Text>
        <Text dimColor> — Ctrl+P to toggle</Text>
      </Box>

      {display.map((todo, i) => {
        const icon = todo.status === 'in_progress'
          ? HOURGLASS_FRAMES[frame]
          : STATUS_ICON[todo.status] ?? '?';
        const color = STATUS_COLOR[todo.status];
        const label = todo.status === 'in_progress' && todo.activeForm
          ? todo.activeForm
          : todo.content;

        return (
          <Box key={i} flexShrink={0}>
            <Text color={color}>{icon} </Text>
            <Text dimColor={todo.status === 'completed'}>{label}</Text>
          </Box>
        );
      })}

      {truncated > 0 && (
        <Box>
          <Text dimColor>  ... and {truncated} more</Text>
        </Box>
      )}
    </Box>
  );
}
