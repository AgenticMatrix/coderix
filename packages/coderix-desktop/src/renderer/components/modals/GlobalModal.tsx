import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, AlertTriangle, Wrench } from 'lucide-react';
import type { PermissionRequest } from '../../types';
import { approvePermission, approvePermissionSession, approvePermissionAlways, denyPermission } from '../../ipc-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingPermission {
  request: PermissionRequest;
  cleanup: () => void;
}

// ---------------------------------------------------------------------------
// Modal Shell
// ---------------------------------------------------------------------------

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}

export function Modal({
  open,
  onClose,
  title,
  children,
}: ModalProps): React.ReactElement | null {
  if (!open) return null;

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center">
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={onClose}
          />

          {/* Dialog */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ duration: 0.2, ease: [0, 0, 0.2, 1] }}
            className="relative w-full max-w-lg mx-4 bg-[var(--color-bg-primary)] rounded-[var(--radius-xl)] border border-[var(--color-separator)] shadow-[var(--shadow-xl)] overflow-hidden"
          >
            {/* Title bar */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-separator)]">
              <h2 className="text-base font-semibold text-[var(--color-text-primary)]">
                {title}
              </h2>
              <button
                onClick={onClose}
                className="w-6 h-6 flex items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
                aria-label="Close"
              >
                <X size={14} />
              </button>
            </div>

            {/* Content */}
            <div className="px-5 py-4">{children}</div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

Modal.displayName = 'Modal';

// ---------------------------------------------------------------------------
// Permission Modal
// ---------------------------------------------------------------------------

function PermissionModal({
  pending,
  onResolved,
}: {
  pending: PendingPermission;
  onResolved: () => void;
}): React.ReactElement {
  const [processing, setProcessing] = useState<string | null>(null);

  const handleApprove = useCallback(async () => {
    setProcessing('once');
    pending.cleanup();
    try {
      await approvePermission(pending.request.id);
    } catch (err) {
      console.error('[PermissionModal] Failed to approve:', err);
    } finally {
      setProcessing(null);
      onResolved();
    }
  }, [pending, onResolved]);

  const handleApproveSession = useCallback(async () => {
    setProcessing('session');
    pending.cleanup();
    try {
      await approvePermissionSession(pending.request.id);
    } catch (err) {
      console.error('[PermissionModal] Failed to approve session:', err);
    } finally {
      setProcessing(null);
      onResolved();
    }
  }, [pending, onResolved]);

  const handleApproveAlways = useCallback(async () => {
    setProcessing('always');
    pending.cleanup();
    try {
      await approvePermissionAlways(pending.request.id);
    } catch (err) {
      console.error('[PermissionModal] Failed to approve always:', err);
    } finally {
      setProcessing(null);
      onResolved();
    }
  }, [pending, onResolved]);

  const handleDeny = useCallback(async () => {
    setProcessing('deny');
    pending.cleanup();
    try {
      await denyPermission(pending.request.id);
    } catch (err) {
      console.error('[PermissionModal] Failed to deny:', err);
    } finally {
      setProcessing(null);
      onResolved();
    }
  }, [pending, onResolved]);

  const { request } = pending;

  return (
    <div className="space-y-4">
      {/* Warning banner */}
      <div className="flex items-start gap-3 p-3 rounded-[var(--radius-md)] bg-[var(--color-warning)]/10 border border-[var(--color-warning)]/20">
        <AlertTriangle size={16} className="text-[var(--color-warning)] flex-shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-medium text-[var(--color-warning)]">
            Agent 需要您的确认
          </p>
          <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
            {request.message ?? `${request.toolName} 正在请求权限`}
          </p>
        </div>
      </div>

      {/* Tool details */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Wrench size={14} className="text-[var(--color-text-tertiary)]" />
          <span className="text-sm font-mono font-semibold text-[var(--color-text-primary)]">
            {request.toolName}
          </span>
        </div>

        {request.toolInput && Object.keys(request.toolInput).length > 0 && (
          <div className="p-3 rounded-[var(--radius-md)] bg-[var(--color-bg-tertiary)] border border-[var(--color-separator)]">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)] mb-1.5">
              Parameters
            </div>
            <pre className="text-xs text-[var(--color-text-secondary)] font-mono whitespace-pre-wrap break-all m-0">
              {JSON.stringify(request.toolInput, null, 2)}
            </pre>
          </div>
        )}
      </div>

      {/* Action buttons — approve options on top, deny below */}
      <div className="flex flex-col gap-2 pt-2">
        <div className="flex items-center gap-2">
          <button
            onClick={handleApprove}
            disabled={processing !== null}
            className="flex-1 px-3 py-2 text-sm font-medium rounded-[var(--radius-md)] bg-[var(--color-brand)] text-white hover:bg-[var(--color-brand-hover)] disabled:opacity-50 transition-colors"
          >
            {processing === 'once' ? 'Approving…' : 'Allow once'}
          </button>
          <button
            onClick={handleApproveSession}
            disabled={processing !== null}
            className="flex-1 px-3 py-2 text-sm font-medium rounded-[var(--radius-md)] border border-[var(--color-brand)]/40 bg-[var(--color-brand)]/10 text-[var(--color-brand)] hover:bg-[var(--color-brand)]/20 disabled:opacity-50 transition-colors"
          >
            {processing === 'session' ? 'Approving…' : 'Allow this session'}
          </button>
          <button
            onClick={handleApproveAlways}
            disabled={processing !== null}
            className="flex-1 px-3 py-2 text-sm font-medium rounded-[var(--radius-md)] border border-[var(--color-brand)]/25 bg-[var(--color-brand)]/5 text-[var(--color-text-secondary)] hover:bg-[var(--color-brand)]/10 hover:text-[var(--color-text-primary)] disabled:opacity-50 transition-colors"
          >
            {processing === 'always' ? 'Approving…' : 'Always allow'}
          </button>
        </div>
        <button
          onClick={handleDeny}
          disabled={processing !== null}
          className="px-4 py-2 text-sm font-medium rounded-[var(--radius-md)] border border-[var(--color-separator)] bg-[var(--color-bg-secondary)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] disabled:opacity-50 transition-colors"
        >
          {processing === 'deny' ? 'Denying…' : 'Deny'}
        </button>
      </div>
    </div>
  );
}

PermissionModal.displayName = 'PermissionModal';

// ---------------------------------------------------------------------------
// GlobalModal — Listens for permission requests and renders modals
// ---------------------------------------------------------------------------

export function GlobalModal(): React.ReactElement {
  const [pendingPermissions, setPendingPermissions] = useState<PendingPermission[]>([]);

  useEffect(() => {
    const handler = (e: Event): void => {
      const detail = (e as CustomEvent).detail as {
        request: PermissionRequest;
        cleanup: () => void;
      };
      if (detail?.request) {
        setPendingPermissions((prev) => [
          ...prev,
          { request: detail.request, cleanup: detail.cleanup },
        ]);
      }
    };

    window.addEventListener('coderix:permission-request', handler);
    return () => window.removeEventListener('coderix:permission-request', handler);
  }, []);

  if (pendingPermissions.length === 0) return <></>;

  const current = pendingPermissions[0];

  const handleResolved = (): void => {
    setPendingPermissions((prev) => prev.slice(1));
  };

  return (
    <Modal
      open={pendingPermissions.length > 0}
      onClose={handleResolved}
      title="Permission Required"
    >
      <PermissionModal pending={current} onResolved={handleResolved} />
    </Modal>
  );
}

GlobalModal.displayName = 'GlobalModal';
