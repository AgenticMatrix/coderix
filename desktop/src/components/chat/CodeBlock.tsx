import { useState, useCallback } from 'react';

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
    <div className="code-block">
      <div className="code-block-header">
        <span className="code-block-lang">{language || 'text'}</span>
        <div className="code-block-actions">
          <button className="btn-icon code-block-btn" onClick={handleCopy} title="Copy">
            {copied ? '✓ Copied' : '📋 Copy'}
          </button>
        </div>
      </div>
      <div className="code-block-content">
        <pre>
          <code className={language ? `language-${language}` : ''}>
            {displayLines.map((line, i) => (
              <div key={i} className="code-line">
                <span className="code-line-number">{i + 1}</span>
                <span className="code-line-text">{line || ' '}</span>
              </div>
            ))}
          </code>
        </pre>
      </div>
      {truncated && (
        <button
          className="code-block-expand"
          onClick={() => setExpanded(true)}
        >
          Show all {lines.length} lines...
        </button>
      )}
    </div>
  );
}
