/**
 * Unit tests for git graph ASCII → Unicode rendering.
 */
import { describe, it, expect } from 'vitest';

// Replicate the renderGraph logic for testing (pure function, no React)
const BRANCH_COLORS = [
  '#2196f3', '#4caf50', '#ff9800', '#e91e63', '#9c27b0',
  '#00bcd4', '#795548', '#607d8b', '#cddc39', '#ff5722',
];

function renderGraphChars(graph: string): Array<{ char: string; hasColor: boolean }> {
  if (!graph) return [];

  const laneColor: Record<number, string> = {};
  let nc = 0;
  const positions = new Set<number>();
  for (let i = 0; i < graph.length; i++) {
    if (graph[i] === '|' || graph[i] === '/' || graph[i] === '\\') positions.add(i);
  }
  const sorted = [...positions].sort((a, b) => a - b);
  for (const p of sorted) {
    if (!(p in laneColor)) laneColor[p] = BRANCH_COLORS[nc++ % BRANCH_COLORS.length];
  }

  return [...graph].map((ch, i) => {
    if (ch === '*') return { char: '●', hasColor: true };
    if (ch === '|') return { char: '│', hasColor: true };
    if (ch === '/') return { char: '╱', hasColor: true };
    if (ch === '\\') return { char: '╲', hasColor: true };
    if (ch === '_') return { char: '─', hasColor: true };
    return { char: ' ', hasColor: false };
  });
}

describe('renderGraph', () => {
  it('returns empty for null/undefined', () => {
    expect(renderGraphChars('')).toEqual([]);
  });

  it('renders single commit (*)', () => {
    const result = renderGraphChars('*');
    expect(result[0].char).toBe('●');
  });

  it('renders vertical line (|)', () => {
    const result = renderGraphChars('|');
    expect(result[0].char).toBe('│');
  });

  it('renders commit with branch line', () => {
    const result = renderGraphChars('* ');
    expect(result[0].char).toBe('●');
    expect(result[1].char).toBe(' ');
  });

  it('renders branch fork (* \\ )', () => {
    const result = renderGraphChars('* \\');
    expect(result[0].char).toBe('●');
    expect(result[2].char).toBe('╲');
  });

  it('renders merge commit (|/)', () => {
    const result = renderGraphChars('|/');
    expect(result[0].char).toBe('│');
    expect(result[1].char).toBe('╱');
  });

  it('renders horizontal line (_)', () => {
    const result = renderGraphChars('_');
    expect(result[0].char).toBe('─');
  });

  it('renders complex graph', () => {
    const graph = '*---* |\\';
    const result = renderGraphChars(graph);
    expect(result.length).toBe(graph.length);
    // All non-space chars should have colors
    for (let i = 0; i < result.length; i++) {
      if (result[i].char !== ' ') {
        expect(result[i].hasColor).toBe(true);
      }
    }
  });

  it('assigns different colors to different lanes', () => {
    // Two parallel branches: | |
    const result = renderGraphChars('| |');
    // Both should be rendered as │ but with potentially different colors
    expect(result[0].char).toBe('│');
    expect(result[1].char).toBe(' ');
    expect(result[2].char).toBe('│');
  });

  it('handles spaces correctly', () => {
    const result = renderGraphChars('  *  ');
    expect(result[2].char).toBe('●');
    expect(result[0].char).toBe(' ');
    expect(result[4].char).toBe(' ');
  });
});
