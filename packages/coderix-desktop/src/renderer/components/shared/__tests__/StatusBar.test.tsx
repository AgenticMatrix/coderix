import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StatusBar } from '../StatusBar.js';

function render(overrides: Partial<Parameters<typeof StatusBar>[0]> = {}): string {
  return renderToStaticMarkup(
    <StatusBar
      engine="coderix"
      agentStatus="idle"
      inputTokens={1000}
      outputTokens={2000}
      cacheReadTokens={9000}
      cacheWriteTokens={0}
      contextTokens={3000}
      contextMax={128_000}
      cost={0.0123}
      currency="USD"
      sessionStartedAt={Date.now() - 120_000}
      lastActiveAt={Date.now() - 5_000}
      turnCount={3}
      stepCount={4}
      toolCallCount={7}
      {...overrides}
    />,
  );
}

describe('StatusBar stats pills', () => {
  it('renders the session summary with turns and steps', () => {
    const html = render();
    expect(html).toContain('3 轮 · 4 步');
  });

  it('renders the token total and cache hit rate inline', () => {
    const html = render();
    // 1000 uncached + 9000 cache-read + 2000 output = 12K total, 90% cached.
    expect(html).toContain('12K · 缓存 90%');
  });

  it('omits the token pill when no usage was reported', () => {
    const html = render({
      inputTokens: undefined,
      outputTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
      cost: undefined,
    });
    expect(html).not.toContain('% 缓存');
  });

  it('omits the session pill before the first turn', () => {
    const html = render({ turnCount: 0, stepCount: 0 });
    expect(html).not.toContain(' 轮 · ');
  });
});
