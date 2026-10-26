import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionOriginBadge } from '../SessionList.js';

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
