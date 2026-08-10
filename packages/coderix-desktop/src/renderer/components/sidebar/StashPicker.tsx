import React, { useState, useEffect, useCallback } from 'react';
import { Archive, ArrowUp, Trash2 } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';

interface Stash {
  ref: string;
  message: string;
  date: string;
}

interface Props {
  onClose: () => void;
}

export function StashPicker({ onClose }: Props): React.ReactElement {
  const [stashes, setStashes] = useState<Stash[]>([]);
  const [loading, setLoading] = useState(true);
  const [stashMsg, setStashMsg] = useState('');
  const [includeUntracked, setIncludeUntracked] = useState(true);
  const addNotification = useUIStore((s) => s.addNotification);

  const api = (window as any).coderixAPI?.git;

  const load = useCallback(async () => {
    if (!api) return;
    setLoading(true);
    try {
      const r = await api.stashList();
      setStashes(r.stashes || []);
    } catch { /* ignore */ }
    setLoading(false);
  }, [api]);

  useEffect(() => { load(); }, [load]);

  const handleSave = async () => {
    const r = await api?.stashSave({ message: stashMsg.trim() || undefined, includeUntracked });
    if (r?.status === 'ok') {
      addNotification({ type: 'success', message: 'Changes stashed' });
      setStashMsg('');
      load();
    } else {
      addNotification({ type: 'error', message: 'Stash failed', detail: r?.error });
    }
  };

  const handlePop = async (ref?: string) => {
    const r = await api?.stashPop(ref);
    if (r?.status === 'ok') {
      addNotification({ type: 'success', message: 'Stash popped' });
      onClose();
    } else {
      addNotification({ type: 'error', message: 'Pop failed', detail: r?.error });
    }
  };

  const handleDrop = async (ref?: string) => {
    const r = await api?.stashDrop(ref);
    if (r?.status === 'ok') {
      addNotification({ type: 'success', message: 'Stash dropped' });
      load();
    } else {
      addNotification({ type: 'error', message: 'Drop failed', detail: r?.error });
    }
  };

  if (loading) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
        <div className="bg-[var(--color-bg-primary)] rounded-[var(--radius-md)] shadow-xl border border-[var(--color-separator)] w-72 p-4 text-center text-xs text-[var(--color-text-tertiary)]" onClick={e => e.stopPropagation()}>
          Loading stashes...
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-20" onClick={onClose}>
      <div className="bg-[var(--color-bg-primary)] rounded-[var(--radius-md)] shadow-xl border border-[var(--color-separator)] w-80 max-h-96 flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--color-separator)] flex-shrink-0">
          <span className="text-xs font-semibold text-[var(--color-text-primary)]">Stashes ({stashes.length})</span>
          <span className="text-[10px] text-[var(--color-text-tertiary)]">Esc to close</span>
        </div>

        {/* Save area */}
        <div className="px-3 py-2 border-b border-[var(--color-separator)]">
          <div className="flex gap-1.5 mb-1.5">
            <input type="text" value={stashMsg} onChange={e => setStashMsg(e.target.value)}
              placeholder="Stash message (optional)"
              className="flex-1 h-7 px-2 rounded-[var(--radius-md)] border border-[var(--color-separator)] bg-[var(--color-input-bg)] text-[var(--color-text-primary)] text-xs outline-none"
              onKeyDown={e => { if (e.key === 'Enter') handleSave(); }}
            />
            <button onClick={handleSave} className="h-7 px-2 rounded-[var(--radius-md)] bg-[var(--color-brand)] text-white text-xs font-medium whitespace-nowrap">
              Save
            </button>
          </div>
          <label className="flex items-center gap-1 text-[10px] text-[var(--color-text-tertiary)] cursor-pointer">
            <input type="checkbox" checked={includeUntracked} onChange={e => setIncludeUntracked(e.target.checked)} />
            Include untracked files
          </label>
        </div>

        {/* Stash list */}
        <div className="flex-1 overflow-y-auto">
          {stashes.length === 0 ? (
            <div className="p-4 text-center text-xs text-[var(--color-text-tertiary)] italic">No stashes</div>
          ) : (
            stashes.map((s, i) => (
              <div key={s.ref} className="flex items-center gap-2 px-3 py-2 hover:bg-[var(--color-bg-tertiary)] group border-b border-[var(--color-separator)]/50">
                <Archive size={12} className="flex-shrink-0 text-[var(--color-text-tertiary)]" />
                <div className="flex-1 min-w-0">
                  <div className="text-xs truncate text-[var(--color-text-primary)] font-medium">{s.message.replace(/^On [^:]+: /, '')}</div>
                  <div className="text-[9px] text-[var(--color-text-tertiary)]">{s.ref} · {s.date}</div>
                </div>
                <button onClick={() => handlePop(s.ref)} className="p-1 rounded hover:bg-[var(--color-bg-primary)] text-[var(--color-text-tertiary)] hover:text-[var(--color-link)] opacity-0 group-hover:opacity-100" title="Pop">
                  <ArrowUp size={12} />
                </button>
                <button onClick={() => handleDrop(s.ref)} className="p-1 rounded hover:bg-[var(--color-bg-primary)] text-[var(--color-text-tertiary)] hover:text-red-400 opacity-0 group-hover:opacity-100" title="Drop">
                  <Trash2 size={12} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

StashPicker.displayName = 'StashPicker';
