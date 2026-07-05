import { h } from 'preact';
import { useState } from 'preact/hooks';

export interface ThinkingBlockProps {
  content: string;
  isStreaming?: boolean;
}

export function ThinkingBlock({ content, isStreaming = false }: ThinkingBlockProps): h.JSX.Element {
  const [expanded, setExpanded] = useState(false);

  if (!content && !isStreaming) return <div />;

  const preview = content.length > 80 && !expanded
    ? content.slice(-80).replace(/^[\s\S]{1,10}/, '…')
    : content;

  return (
    <div class="thinking-block">
      <button
        class="thinking-block-toggle"
        onClick={() => setExpanded(!expanded)}
      >
        <span class={`thinking-arrow ${expanded ? 'expanded' : ''}`}>▶</span>
        <span class="thinking-icon">💭</span>
        <span class="thinking-label">Thinking</span>
        {isStreaming && <span class="thinking-spinner" />}
      </button>
      {expanded && (
        <div class="thinking-block-content">
          <pre>{preview}{isStreaming && <span class="thinking-cursor" />}</pre>
        </div>
      )}
    </div>
  );
}

ThinkingBlock.displayName = 'ThinkingBlock';
