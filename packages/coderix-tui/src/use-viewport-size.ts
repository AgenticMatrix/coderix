import { useCallback, useSyncExternalStore } from 'react';
import { useStdout } from 'ink';

export type TerminalSize = {
  columns: number;
  rows: number;
};

/**
 * Returns the current terminal window dimensions and re-renders on resize.
 *
 * Implementation note — why this does NOT delegate to ink's `useWindowSize`:
 * ink's hook registers one `resize` listener per *component instance* on the
 * stream it was given. A message list mounts one consumer per message, so a
 * long session ends up with >10 simultaneous listeners on `process.stdout`
 * and Node prints
 * `MaxListenersExceededWarning: 11 resize listeners added to [WriteStream]`.
 *
 * This hook instead multiplexes every consumer onto a single `resize`
 * listener per stdout (usually `process.stdout`): the first subscriber
 * attaches it, the last one detaches it, and all components share one stable
 * size snapshot. Behavior is otherwise identical — every consumer re-renders
 * on resize, and the snapshot only changes when the terminal truly resizes.
 */

type Subscriber = () => void;

interface Subscription {
  /** Stable snapshot — replaced only on an actual resize. */
  size: TerminalSize;
  subscribers: Set<Subscriber>;
  attached: boolean;
  detach: (() => void) | null;
}

const FALLBACK_SIZE: TerminalSize = { columns: 80, rows: 24 };

/** Per-stream subscriptions, so tests rendering to a custom stdout still work. */
const subscriptions = new WeakMap<NodeJS.WriteStream, Subscription>();

function readSize(stdout: NodeJS.WriteStream): TerminalSize {
  // columns/rows are undefined on non-TTY streams (CI, piped output) — fall
  // back instead of leaking NaN into layout math.
  const columns = stdout.columns;
  const rows = stdout.rows;
  return {
    columns: typeof columns === 'number' && columns > 0 ? columns : FALLBACK_SIZE.columns,
    rows: typeof rows === 'number' && rows > 0 ? rows : FALLBACK_SIZE.rows,
  };
}

function getSubscription(stdout: NodeJS.WriteStream): Subscription {
  let sub = subscriptions.get(stdout);
  if (!sub) {
    sub = { size: readSize(stdout), subscribers: new Set(), attached: false, detach: null };
    subscriptions.set(stdout, sub);
  }
  return sub;
}

function subscribe(stdout: NodeJS.WriteStream, onChange: Subscriber): () => void {
  const sub = getSubscription(stdout);
  sub.subscribers.add(onChange);

  if (!sub.attached && stdout.isTTY && typeof stdout.on === 'function') {
    // Non-TTY streams never emit 'resize' — don't register a dead listener.
    const onResize = (): void => {
      sub.size = readSize(stdout);
      sub.subscribers.forEach((listener) => listener());
    };
    stdout.on('resize', onResize);
    sub.attached = true;
    sub.detach = () => {
      stdout.off('resize', onResize);
      sub.attached = false;
      sub.detach = null;
    };
  }

  return () => {
    sub.subscribers.delete(onChange);
    if (sub.subscribers.size === 0 && sub.attached && sub.detach) {
      sub.detach();
    }
  };
}

export function useTerminalSize(): TerminalSize {
  // StdoutContext defaults to process.stdout, so this is safe even outside
  // an ink tree; inside one it tracks the stream ink actually renders to.
  const { stdout } = useStdout();
  // Stable callbacks — re-subscribe only when the stream itself changes,
  // not on every render.
  const handleSubscribe = useCallback(
    (onChange: Subscriber) => subscribe(stdout, onChange),
    [stdout],
  );
  const getSnapshot = useCallback(() => getSubscription(stdout).size, [stdout]);
  return useSyncExternalStore(handleSubscribe, getSnapshot);
}
