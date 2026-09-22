import { useWindowSize } from 'ink';

export type TerminalSize = {
  columns: number;
  rows: number;
};

/**
 * Returns the current terminal window dimensions and re-renders on resize.
 */
export function useTerminalSize(): TerminalSize {
  return useWindowSize();
}
