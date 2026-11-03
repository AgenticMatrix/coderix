import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  SessionOriginBadge,
  SessionStatusBadge,
  resolveRowStatus,
} from '../SessionList.js';

describe('SessionOriginBadge', () => {
  it('shows a monitor icon for desktop-created sessions', () => {
    const html = renderToStaticMarkup(<SessionOriginBadge origin="desktop" />);
    expect(html).toContain('lucide-monitor');
    expect(html).toContain('aria-label="桌面"');
  });

  it('shows a terminal icon for CLI-created sessions', () => {
    const html = renderToStaticMarkup(<SessionOriginBadge origin="cli" />);
    expect(html).toContain('lucide-terminal');
    expect(html).toContain('aria-label="CLI"');
  });

  it('shows no badge for legacy sessions', () => {
    const html = renderToStaticMarkup(<SessionOriginBadge />);
    expect(html).toBe('');
  });
});

describe('SessionStatusBadge', () => {
  it('renders a red busy badge', () => {
    const html = renderToStaticMarkup(<SessionStatusBadge status="busy" />);
    expect(html).toContain('aria-label="该对话正在运行"');
    expect(html).toContain('忙碌');
    expect(html).toContain('bg-[var(--color-danger)]');
    expect(html).toContain('animate-pulse');
  });

  it('renders a yellow wait badge', () => {
    const html = renderToStaticMarkup(<SessionStatusBadge status="wait" />);
    expect(html).toContain('aria-label="该对话正在等待你的输入"');
    expect(html).toContain('等待');
    expect(html).toContain('bg-[var(--color-warning)]');
  });

  it('renders a green idle badge without a pulse', () => {
    const html = renderToStaticMarkup(<SessionStatusBadge status="idle" />);
    expect(html).toContain('aria-label="该对话空闲"');
    expect(html).toContain('空闲');
    expect(html).toContain('bg-[var(--color-success)]');
    expect(html).not.toContain('animate-pulse');
  });

  it('uses the same green for idle as the bottom bar', () => {
    // Both read --color-success, so the row and the bar can never look like
    // two different states.
    const html = renderToStaticMarkup(<SessionStatusBadge status="idle" />);
    expect(html).toContain('text-[var(--color-success)]');
  });

  it('shows a settled error like the bar, without pulsing', () => {
    const html = renderToStaticMarkup(<SessionStatusBadge status="error" />);
    expect(html).toContain('aria-label="该对话上一轮出错了"');
    expect(html).toContain('错误');
    expect(html).toContain('bg-[var(--color-danger)]');
    expect(html).not.toContain('animate-pulse');
  });

  it('shows a stopped turn like the bar, without pulsing', () => {
    const html = renderToStaticMarkup(<SessionStatusBadge status="interrupted" />);
    expect(html).toContain('aria-label="该对话上一轮被中断"');
    expect(html).toContain('已中断');
    expect(html).toContain('bg-[var(--color-text-tertiary)]');
    expect(html).not.toContain('animate-pulse');
  });

  it('shows background work as waiting, not busy', () => {
    const html = renderToStaticMarkup(<SessionStatusBadge status="background" />);
    expect(html).toContain('aria-label="该对话正在等待后台任务完成"');
    expect(html).toContain('等待');
    expect(html).toContain('bg-[var(--color-warning)]');
    // Nothing is waiting on the user, so the dot does not pulse.
    expect(html).not.toContain('animate-pulse');
  });
});

/**
 * The row's status must be the bottom bar's status for the conversation being
 * viewed. This is the path the previous fix missed (it was gated on
 * `!session.busy`, so a leased session fell back to its own signals).
 */
describe('resolveRowStatus', () => {
  it('mirrors the bar for the viewed session even when local signals say busy', () => {
    // A leftover request-start and a CLI-held lease make `liveStatus` busy; the
    // bar is idle, so the row must be idle too.
    expect(resolveRowStatus('s1', 's1', 'idle', 'busy')).toBe('idle');
  });

  it('mirrors every bar state for the viewed session', () => {
    for (const status of [
      'busy',
      'wait',
      'background',
      'idle',
      'error',
      'interrupted',
    ] as const) {
      expect(resolveRowStatus('s1', 's1', status, 'idle')).toBe(status);
    }
  });

  it('falls back to the per-session signals for a backgrounded session', () => {
    expect(resolveRowStatus('s2', 's1', 'idle', 'busy')).toBe('busy');
    expect(resolveRowStatus('s2', 's1', 'idle', 'idle')).toBe('idle');
  });

  it('uses local signals when no session is viewed', () => {
    expect(resolveRowStatus('s1', null, 'idle', 'busy')).toBe('busy');
  });
});
