import React, { useEffect, useRef } from 'react';
import { ChevronUp, ChevronDown, X } from 'lucide-react';

export function TrajectorySearchBar({
  query,
  onQueryChange,
  matchCount,
  activeIndex,
  onNext,
  onPrev,
  onClose,
}: {
  query: string;
  onQueryChange: (q: string) => void;
  matchCount: number;
  activeIndex: number;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}): React.ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const counter = matchCount > 0 ? `${activeIndex + 1}/${matchCount}` : '0/0';

  return (
    <div data-trajectory-search-bar="" className="trajectory-search-bar">
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          else if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) onPrev();
            else onNext();
          }
        }}
        placeholder="Search messages…"
        className="trajectory-search-input"
      />
      <span className="trajectory-search-count">{counter}</span>
      <button type="button" onClick={onPrev} title="Previous" aria-label="Previous" className="trajectory-search-btn">
        <ChevronUp size={14} />
      </button>
      <button type="button" onClick={onNext} title="Next" aria-label="Next" className="trajectory-search-btn">
        <ChevronDown size={14} />
      </button>
      <button type="button" onClick={onClose} title="Close" aria-label="Close" className="trajectory-search-btn">
        <X size={14} />
      </button>
    </div>
  );
}

TrajectorySearchBar.displayName = 'TrajectorySearchBar';
