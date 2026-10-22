import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StatPill } from '../StatPill.js';

const props = {
  icon: null,
  label: '12K · 缓存 90%',
  title: 'Token 用量',
  summary: '12,000',
  rows: [
    { label: '缓存命中率', value: '90%' },
    { label: '未缓存输入', value: '1,000' },
  ],
  onToggle: () => {},
  onClose: () => {},
};

describe('StatPill', () => {
  it('renders only the trigger while closed', () => {
    const html = renderToStaticMarkup(<StatPill {...props} open={false} />);
    expect(html).toContain('12K · 缓存 90%');
    expect(html).not.toContain('role="dialog"');
  });

  it('renders the full breakdown while open', () => {
    const html = renderToStaticMarkup(<StatPill {...props} open />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('Token 用量');
    expect(html).toContain('12,000');
    expect(html).toContain('缓存命中率');
    expect(html).toContain('90%');
    expect(html).toContain('未缓存输入');
    expect(html).toContain('1,000');
  });

  it('marks the trigger as a dialog opener', () => {
    const html = renderToStaticMarkup(<StatPill {...props} open={false} />);
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
  });
});
