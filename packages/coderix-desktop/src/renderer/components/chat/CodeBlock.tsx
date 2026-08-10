import { useState, useCallback } from 'react';
import { Copy, Check, FileOutput } from 'lucide-react';

interface CodeBlockProps {
  code: string;
  language: string;
  maxLines?: number;
  /** Optional target file path (auto-detected from language label) */
  filePath?: string;
}

export function CodeBlock({ code, language, maxLines, filePath }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const [applied, setApplied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const lines = code.split('\n');
  const truncated = maxLines && !expanded && lines.length > maxLines;
  const displayLines = truncated ? lines.slice(0, maxLines) : lines;

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* noop */ }
  }, [code]);

  const handleApply = useCallback(async () => {
    const target = filePath || window.prompt('File path to apply to:');
    if (!target || !target.trim()) return;
    const api = window.coderixAPI?.fs;
    if (!api) return;
    try {
      await api.writeFile(target.trim(), code);
      setApplied(true);
      setTimeout(() => setApplied(false), 2000);
    } catch (e) {
      alert('Failed to write: ' + (e as Error).message);
    }
  }, [code, filePath]);

  // Auto-detect file path from language label: "tsx src/App.tsx" → src/App.tsx
  const detectedFile = !filePath && language ? language.split(' ').find(w => w.includes('.') || w.includes('/')) : undefined;

  return (
    <div className="my-2 rounded-[var(--radius-lg)] border border-[var(--color-separator)] overflow-hidden bg-[var(--color-code-bg)]">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-[var(--color-bg-secondary)] border-b border-[var(--color-separator)]">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">
          {language || 'text'}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={handleApply}
            className="flex items-center gap-1 text-[11px] text-[var(--color-link)] hover:text-[var(--color-brand)] transition-colors px-1.5 py-0.5 rounded"
            title={applied ? 'Applied!' : 'Apply to file'}
          >
            {applied ? <Check size={12} /> : <FileOutput size={12} />}
            {applied ? 'Applied' : detectedFile || 'Apply'}
          </button>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 text-[11px] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] transition-colors px-1.5 py-0.5 rounded"
            title="Copy code"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
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
