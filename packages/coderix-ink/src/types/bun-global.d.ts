// Stub for Bun global — only used in typeof checks with JS fallbacks
declare const Bun: {
  stringWidth?: (str: string, opts?: { ambiguousIsNarrow?: boolean }) => number
  wrapAnsi?: (str: string, width: number) => string
} | undefined
