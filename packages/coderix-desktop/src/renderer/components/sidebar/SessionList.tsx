import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { MessageSquare, Trash2 } from 'lucide-react';
import { useSessionStore } from '../../store/sessionStore.js';

export interface SessionListProps {
  activeSessionId?: string;
  onSessionSelect?: (sessionId: string) => void;
  searchQuery?: string;
}

function formatTimeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  const minutes = Math.floor(diff / 60000);
  return `${minutes}m ago`;
}

export function SessionList({
  activeSessionId,
  onSessionSelect,
  searchQuery = '',
}: SessionListProps): React.ReactElement {
  const sessions = useSessionStore((s) => s.sessions);
  const isLoading = useSessionStore((s) => s.isLoading);
  const deleteSession = useSessionStore((s) => s.deleteSession);
  const [deleting, setDeleting] = useState<string | null>(null);

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setDeleting(id);
    try {
      // deleteSession already removes the entry optimistically.
      await deleteSession(id);
    } catch { /* ignore */ }
    setDeleting(null);
  };

  const handleClearAll = async () => {
    if (!confirm('确定要删除所有会话？')) return;
    for (const s of sessions) {
      try { await deleteSession(s.id); } catch { /* ignore */ }
    }
  };

  if (isLoading) {
    return <div className="p-4 text-center text-xs text-[var(--color-text-tertiary)]">加载中...</div>;
  }

  const filtered = sessions.filter((s) =>
    s.title.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  return (
    <div className="flex flex-col h-full">
      {/* Clear all */}
      {sessions.length > 1 && (
        <div className="px-3 py-1 border-b border-[var(--color-separator)]">
          <button
            onClick={handleClearAll}
            className="text-[10px] text-[var(--color-text-tertiary)] hover:text-[var(--color-danger)] transition-colors"
          >
            清除全部 ({sessions.length})
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto py-1">
        {filtered.length === 0 ? (
          <div className="p-4 text-center text-xs text-[var(--color-text-tertiary)]">
            {searchQuery ? '未找到会话' : '点击 + 开始新会话'}
          </div>
        ) : (
          filtered.map((session) => {
            const isActive = session.id === activeSessionId;
            return (
              <motion.button
                key={session.id}
                onClick={() => onSessionSelect?.(session.id)}
                whileHover={{ backgroundColor: 'var(--color-bg-tertiary)' }}
                whileTap={{ scale: 0.98 }}
                className={`
                  w-full text-left px-3 py-2 cursor-pointer transition-colors duration-50 group
                  ${isActive ? 'bg-[var(--color-brand)]/10' : ''}
                  border-l-[3px]
                  ${isActive ? 'border-l-[var(--color-brand)]' : 'border-l-transparent'}
                `}
              >
                <div className="flex items-start gap-2">
                  <MessageSquare
                    size={14}
                    className={`mt-0.5 flex-shrink-0 ${
                      isActive ? 'text-[var(--color-brand)]' : 'text-[var(--color-text-tertiary)]'
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <div
                      className={`text-sm font-medium truncate ${
                        isActive ? 'text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)]'
                      }`}
                    >
                      {session.title}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 text-[11px] text-[var(--color-text-tertiary)]">
                      <span>{formatTimeAgo(session.updatedAt)}</span>
                      <span>·</span>
                      <span>{session.turnCount} turns</span>
                    </div>
                  </div>
                  <button
                    onClick={(e) => handleDelete(e, session.id)}
                    className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-[var(--color-bg-primary)]"
                    title="删除会话"
                  >
                    <Trash2 size={12} className="text-[var(--color-text-tertiary)] hover:text-[var(--color-danger)]" />
                  </button>
                </div>
              </motion.button>
            );
          })
        )}
      </div>
    </div>
  );
}

SessionList.displayName = 'SessionList';
