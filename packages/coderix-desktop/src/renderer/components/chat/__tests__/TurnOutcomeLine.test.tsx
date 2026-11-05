import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TurnOutcomeLine } from '../TurnOutcomeLine.js';
import type { TurnOutcome } from '../../../turn-outcome.js';

function render(outcome: TurnOutcome): string {
  return renderToStaticMarkup(<TurnOutcomeLine outcome={outcome} />);
}

describe('TurnOutcomeLine', () => {
  it('renders nothing while the turn is still running', () => {
    expect(render({ kind: 'running', messageKey: 'turn.running' })).toBe('');
  });

  it('states that a clean turn completed', () => {
    const html = render({ kind: 'complete', messageKey: 'turn.complete' });
    expect(html).toContain('turn-outcome');
    expect(html).toContain('本轮已正常完成');
  });

  it('explains a truncated turn instead of calling it complete', () => {
    const html = render({ kind: 'max_tokens', messageKey: 'turn.maxTokens' });
    expect(html).toContain('长度上限');
    expect(html).not.toContain('正常完成');
  });

  it('marks a failure with its own dot so it reads apart from a normal finish', () => {
    const html = render({ kind: 'incomplete', messageKey: 'turn.incomplete' });
    expect(html).toContain('turn-outcome-dot--incomplete');
  });

  it('is a quiet, non-interactive element (no button or alert role)', () => {
    const html = render({ kind: 'complete', messageKey: 'turn.complete' });
    expect(html).toContain('role="status"');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('alert');
  });
});