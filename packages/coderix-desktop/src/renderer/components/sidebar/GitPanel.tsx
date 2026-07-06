import React from 'react';

/**
 * GitPanel — Source Control panel for the sidebar
 *
 * Displays git status, changed files, and basic source control operations.
 * Currently a placeholder; full git integration coming soon.
 */
export function GitPanel(): React.ReactElement {
  return (
    <div className="p-4 space-y-3">
      <div className="text-xs font-semibold text-[var(--color-text-secondary)] uppercase tracking-wide">
        Source Control
      </div>
      <div className="text-xs text-[var(--color-text-tertiary)] text-center py-8">
        Git integration — coming soon
      </div>
    </div>
  );
}

GitPanel.displayName = 'GitPanel';
