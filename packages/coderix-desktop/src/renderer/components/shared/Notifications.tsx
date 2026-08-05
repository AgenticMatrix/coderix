import React from 'react';
import { X, AlertCircle, AlertTriangle, CheckCircle, Info } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useUIStore, type AppNotification, type NotificationType } from '../../store/uiStore';
import type { LucideIcon } from 'lucide-react';

const ICON_MAP: Record<NotificationType, LucideIcon> = {
  error: AlertCircle,
  warning: AlertTriangle,
  success: CheckCircle,
  info: Info,
};

const COLOR_MAP: Record<NotificationType, string> = {
  error: '#f44336',
  warning: '#ff9800',
  success: '#4caf50',
  info: '#2196f3',
};

function NotificationItem({ n }: { n: AppNotification }) {
  const remove = useUIStore((s) => s.removeNotification);
  const Icon = ICON_MAP[n.type];
  const color = COLOR_MAP[n.type];

  return (
    <motion.div
      initial={{ opacity: 0, y: -20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.95 }}
      transition={{ duration: 0.2 }}
      className="pointer-events-auto flex items-start gap-2 px-3 py-2.5 rounded-[var(--radius-md)] border shadow-lg max-w-sm"
      style={{
        background: 'var(--color-bg-primary)',
        borderColor: 'var(--color-separator)',
      }}
    >
      <span style={{ color, flexShrink: 0, marginTop: 1 }}><Icon size={14} /></span>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-[var(--color-text-primary)]">{n.message}</div>
        {n.detail && (
          <div className="text-[10px] text-[var(--color-text-tertiary)] mt-0.5 break-all line-clamp-2">
            {n.detail}
          </div>
        )}
      </div>
      <button
        onClick={() => remove(n.id)}
        className="flex-shrink-0 p-0.5 rounded hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-tertiary)]"
      >
        <X size={12} />
      </button>
    </motion.div>
  );
}

export function Notifications(): React.ReactElement | null {
  const notifications = useUIStore((s) => s.notifications);

  return (
    <div
      className="pointer-events-none fixed bottom-6 right-6 z-[9999] flex flex-col gap-2"
    >
      <AnimatePresence>
        {notifications.map((n) => (
          <NotificationItem key={n.id} n={n} />
        ))}
      </AnimatePresence>
    </div>
  );
}

Notifications.displayName = 'Notifications';
