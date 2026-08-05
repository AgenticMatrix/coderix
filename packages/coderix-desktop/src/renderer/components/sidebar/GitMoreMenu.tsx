import React, { useState, useCallback } from 'react';
import { ArrowUp, ArrowDown, Download, RotateCcw, GitBranch, Archive, Ellipsis } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';

interface Props {
  onPush: () => void;
  onPull: () => void;
  onFetch: () => void;
  onDiscardAll: () => void;
  onBranches: () => void;
  onStash: () => void;
  hasChanges: boolean;
}

export function GitMoreMenu({ onPush, onPull, onFetch, onDiscardAll, onBranches, onStash, hasChanges }: Props): React.ReactElement {
  const [open, setOpen] = useState(false);

  const close = useCallback(() => setOpen(false), []);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="p-1 rounded hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-tertiary)]"
        title="More"
      >
        <Ellipsis size={12} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={close} />
          <div className="absolute right-0 top-full mt-1 w-44 rounded-[var(--radius-md)] bg-[var(--color-bg-primary)] border border-[var(--color-separator)] shadow-lg z-50 py-1">
            <MenuItem icon={<ArrowUp size={12} />} label="Push" shortcut="..." onClick={() => { onPush(); close(); }} />
            <MenuItem icon={<ArrowDown size={12} />} label="Pull" shortcut="..." onClick={() => { onPull(); close(); }} />
            <MenuItem icon={<Download size={12} />} label="Fetch" shortcut="..." onClick={() => { onFetch(); close(); }} />
            <div className="border-t border-[var(--color-separator)] my-1" />
            <MenuItem icon={<RotateCcw size={12} />} label="Discard All Changes" danger disabled={!hasChanges} onClick={() => { onDiscardAll(); close(); }} />
            <div className="border-t border-[var(--color-separator)] my-1" />
            <MenuItem icon={<GitBranch size={12} />} label="Branches..." onClick={() => { onBranches(); close(); }} />
            <MenuItem icon={<Archive size={12} />} label="Stashes..." onClick={() => { onStash(); close(); }} />
            {/* Phase 3: Tag management */}
          </div>
        </>
      )}
    </div>
  );
}

function MenuItem({ icon, label, shortcut, danger, disabled, onClick }: {
  icon: React.ReactNode; label: string; shortcut?: string;
  danger?: boolean; disabled?: boolean; onClick: () => void;
}) {
  return (
    <button
      disabled={disabled}
      onClick={disabled ? undefined : onClick}
      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--color-bg-tertiary)] disabled:opacity-30 disabled:cursor-not-allowed"
      style={{ color: danger ? '#f44336' : 'var(--color-text-primary)' }}
    >
      <span className="flex-shrink-0 text-[var(--color-text-tertiary)]">{icon}</span>
      <span className="flex-1 text-left">{label}</span>
      {shortcut && <span className="text-[10px] text-[var(--color-text-tertiary)]">{shortcut}</span>}
    </button>
  );
}

GitMoreMenu.displayName = 'GitMoreMenu';
