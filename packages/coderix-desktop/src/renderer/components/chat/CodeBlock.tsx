import { useState, useCallback } from 'react';
import { Copy, Check } from 'lucide-react';

interface CodeBlockProps {
  code: string;
  language: string;
  maxLines?: number;
}

export function CodeBlock({ code, language, maxLines }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const lines = code.split('\n');
  const truncated = maxLines && !expanded && lines.length > maxLines;
  const displayLines = truncated ? lines.slice(0, maxLines) : lines;

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
    }
  }, [code]);

  return (
    <div className="my-2 rounded-[var(--radius-lg)] border border-[var(--color-separator)] overflow-hidden bg-[var(--color-code-bg)]">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-[var(--color-bg-secondary)] border-b border-[var(--color-separator)]">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">
          {language || 'text'}
        </span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 text-[11px] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] transition-colors px-1.5 py-0.5 rounded"
          title="Copy code"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      {/* Code content */}
      <div className="overflow-x-auto">
        <pre className="p-3 m-0 font-mono text-[13px] leading-[20px]">
          <code className={language ? `language-${language}` : ''}>
            {displayLines.map((line, i) => (
              <div key={i} className="flex min-h-[21px]">
                <span className="inline-block w-[44px] pr-[14px] text-right text-[var(--color-text-tertiary)] text-[11px] select-none flex-shrink-0">
                  {i + 1}
                </span>
                <span className="whitespace-pre text-[var(--color-text-primary)]">
                  {line || ' '}
                </span>
              </div>
            ))}
          </code>
        </pre>
      </div>

      {/* Expand button */}
      {truncated && (
        <button
          className="block w-full px-3 py-1.5 text-xs text-[var(--color-link)] bg-[var(--color-bg-secondary)] border-t border-[var(--color-separator)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
          onClick={() => setExpanded(true)}
        >
          Show all {lines.length} lines...
        </button>
      )}
    </div>
  );
}

CodeBlock.displayName = 'CodeBlock';
