import React from 'react';
import { motion } from 'framer-motion';
import { MessageSquare } from 'lucide-react';
import type { SessionInfo } from '../../types';

export interface SessionListProps {
  /** Currently active session ID */
  activeSessionId?: string;
  /** Callback when session is selected */
  onSessionSelect?: (sessionId: string) => void;
  /** Search query to filter sessions */
  searchQuery?: string;
}

// Mock session data — in production this comes from window.coderixAPI.session.list()
const mockSessions: SessionInfo[] = [
  { id: '1', title: 'Fix login page bug', turnCount: 12, model: 'sonnet 4.5', updatedAt: Date.now() - 2 * 3600000, createdAt: Date.now() - 86400000 },
  { id: '2', title: 'Refactor API middleware', turnCount: 8, model: 'sonnet 4.5', updatedAt: Date.now() - 86400000, createdAt: Date.now() - 172800000 },
  { id: '3', title: 'Code Review #42', turnCount: 3, model: 'opus 4.5', updatedAt: Date.now() - 172800000, createdAt: Date.now() - 259200000 },
  { id: '4', title: 'Setup CI/CD pipeline', turnCount: 24, model: 'haiku 4.5', updatedAt: Date.now() - 259200000, createdAt: Date.now() - 345600000 },
];

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
  const filteredSessions = mockSessions.filter((s) =>
    s.title.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  if (filteredSessions.length === 0) {
    return (
      <div className="p-4 text-center text-xs text-[var(--color-text-tertiary)]">
        {searchQuery ? 'No sessions found' : 'Start a new session'}
      </div>
    );
  }

  return (
    <div className="py-1">
      {filteredSessions.map((session) => {
        const isActive = session.id === activeSessionId;

        return (
          <motion.button
            key={session.id}
            onClick={() => onSessionSelect?.(session.id)}
            whileHover={{ backgroundColor: 'var(--color-bg-tertiary)' }}
            whileTap={{ scale: 0.98 }}
            className={`
              w-full text-left px-3 py-2 cursor-pointer transition-colors duration-50
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
                  <span>·</span>
                  <span>{session.model}</span>
                </div>
              </div>
            </div>
          </motion.button>
        );
      })}
    </div>
  );
}

SessionList.displayName = 'SessionList';
