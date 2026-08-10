import React, { useState, useEffect, useCallback } from 'react';
import { GitBranch, Plus, Trash2, Check, X } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';

interface Branch {
  name: string;
  hash: string;
  upstream: string;
  current: boolean;
}

interface Props {
  onClose: () => void;
}

export function BranchPicker({ onClose }: Props): React.ReactElement {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [newBranch, setNewBranch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const addNotification = useUIStore((s) => s.addNotification);

  const api = (window as any).coderixAPI?.git;

  const load = useCallback(async () => {
    if (!api) return;
    setLoading(true);
    try {
      const r = await api.branchList();
      setBranches(r.branches || []);
    } catch { /* ignore */ }
    setLoading(false);
  }, [api]);

  useEffect(() => { load(); }, [load]);

  const handleCheckout = async (branch: string) => {
    const r = await api?.checkout({ branch });
    if (r?.status === 'ok') {
      addNotification({ type: 'success', message: `Switched to ${branch}` });
      onClose();
    } else {
      addNotification({ type: 'error', message: 'Checkout failed', detail: r?.error });
    }
  };

  const handleCreate = async () => {
    if (!newBranch.trim()) return;
    const r = await api?.checkout({ branch: newBranch.trim(), create: true });
    if (r?.status === 'ok') {
      addNotification({ type: 'success', message: `Created and switched to ${newBranch.trim()}` });
      onClose();
    } else {
      addNotification({ type: 'error', message: 'Create branch failed', detail: r?.error });
    }
  };

  const handleDelete = async (branch: string) => {
    const r = await api?.branchDelete(branch);
    if (r?.status === 'ok') {
      addNotification({ type: 'success', message: `Deleted ${branch}` });
      load();
    } else {
      addNotification({ type: 'error', message: `Delete failed`, detail: r?.error });
    }
  };

  if (loading) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
        <div className="bg-[var(--color-bg-primary)] rounded-[var(--radius-md)] shadow-xl border border-[var(--color-separator)] w-72 p-4 text-center text-xs text-[var(--color-text-tertiary)]" onClick={e => e.stopPropagation()}>
          Loading branches...
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-20" onClick={onClose}>
      <div className="bg-[var(--color-bg-primary)] rounded-[var(--radius-md)] shadow-xl border border-[var(--color-separator)] w-72 max-h-96 flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--color-separator)] flex-shrink-0">
          <span className="text-xs font-semibold text-[var(--color-text-primary)]">Branches</span>
          <button onClick={() => setShowCreate(!showCreate)} className="p-1 rounded hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-tertiary)]" title="Create branch">
            <Plus size={14} />
          </button>
        </div>

        {/* Create input */}
        {showCreate && (
          <div className="px-3 py-2 border-b border-[var(--color-separator)] flex gap-1.5">
            <input
              type="text" value={newBranch} onChange={e => setNewBranch(e.target.value)}
              placeholder="New branch name..." autoFocus
              className="flex-1 h-7 px-2 rounded-[var(--radius-md)] border border-[var(--color-separator)] bg-[var(--color-input-bg)] text-[var(--color-text-primary)] text-xs outline-none"
              onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setShowCreate(false); }}
            />
            <button onClick={handleCreate} disabled={!newBranch.trim()} className="h-7 w-7 rounded-[var(--radius-md)] bg-[var(--color-brand)] text-white disabled:opacity-30 flex items-center justify-center">
              <Check size={12} />
            </button>
            <button onClick={() => setShowCreate(false)} className="h-7 w-7 rounded-[var(--radius-md)] hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-tertiary)] flex items-center justify-center">
              <X size={12} />
            </button>
          </div>
        )}

        {/* Branch list */}
        <div className="flex-1 overflow-y-auto">
          {branches.map(b => (
            <div key={b.name}
              className="flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--color-bg-tertiary)] cursor-pointer group"
              onClick={() => handleCheckout(b.name)}
            >
              <GitBranch size={11} className="flex-shrink-0" style={{ color: b.current ? '#4caf50' : 'var(--color-text-tertiary)' }} />
              <span className="flex-1 text-xs truncate font-mono" style={{ fontWeight: b.current ? 600 : 400, color: b.current ? '#4caf50' : 'var(--color-text-primary)' }}>
                {b.name}
              </span>
              <span className="text-[9px] text-[var(--color-text-tertiary)] font-mono">{b.hash.slice(0, 6)}</span>
              {!b.current && (
                <button onClick={e => { e.stopPropagation(); handleDelete(b.name); }}
                  className="p-0.5 rounded hover:bg-[var(--color-bg-primary)] text-[var(--color-text-tertiary)] hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Delete branch"
                >
                  <Trash2 size={11} />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

BranchPicker.displayName = 'BranchPicker';
