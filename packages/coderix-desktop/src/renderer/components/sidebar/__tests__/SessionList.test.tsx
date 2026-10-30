import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionOriginBadge, SessionStatusBadge } from '../SessionList.js';

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
  it('renders a blue busy badge', () => {
    const html = renderToStaticMarkup(<SessionStatusBadge status="busy" />);
    expect(html).toContain('aria-label="该对话正在运行"');
    expect(html).toContain('忙碌');
    expect(html).toContain('bg-[var(--color-blue)]');
    expect(html).toContain('animate-pulse');
  });

  it('renders a warning-coloured wait badge', () => {
    const html = renderToStaticMarkup(<SessionStatusBadge status="wait" />);
    expect(html).toContain('aria-label="该对话正在等待你的输入"');
    expect(html).toContain('等待');
    expect(html).toContain('bg-[var(--color-warning)]');
  });

  it('renders a muted idle badge without a pulse', () => {
    const html = renderToStaticMarkup(<SessionStatusBadge status="idle" />);
    expect(html).toContain('aria-label="该对话空闲"');
    expect(html).toContain('空闲');
    expect(html).toContain('bg-[var(--color-text-tertiary)]');
    expect(html).not.toContain('animate-pulse');
  });
});
