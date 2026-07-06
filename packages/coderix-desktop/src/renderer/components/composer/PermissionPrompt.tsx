import React, { useState, useCallback } from 'react';
import { ShieldAlert, X, Check, Wrench, Terminal } from 'lucide-react';
import type { PermissionRequest } from '../../types';
import { approvePermission, denyPermission } from '../../ipc-client';

export interface PermissionPromptProps {
  request: PermissionRequest;
  onResolved: () => void;
}

/**
 * PermissionPrompt — inline permission card rendered above the composer,
 * styled like Claude Code's inline tool confirmation.
 *
 * Compact, non-blocking: the user can still see the chat while deciding.
 */
export function PermissionPrompt({
  request,
  onResolved,
}: PermissionPromptProps): React.ReactElement {
  const [approving, setApproving] = useState(false);
  const [denying, setDenying] = useState(false);

  const handleApprove = useCallback(async () => {
    setApproving(true);
    try {
      await approvePermission(request.id);
    } catch (err) {
      console.error('[PermissionPrompt] Failed to approve:', err);
    } finally {
      setApproving(false);
      onResolved();
    }
  }, [request.id, onResolved]);

  const handleDeny = useCallback(async () => {
    setDenying(true);
    try {
      await denyPermission(request.id);
    } catch (err) {
      console.error('[PermissionPrompt] Failed to deny:', err);
    } finally {
      setDenying(false);
      onResolved();
    }
  }, [request.id, onResolved]);

  // Build a short description from request fields
  const description = request.message
    || `${request.toolName} needs permission`;

  return (
    <div
      className="mx-3 mb-2 rounded-lg border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/5 overflow-hidden animate-in fade-in slide-in-from-bottom-2"
      style={{ animationDuration: '150ms' }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--color-warning)]/15">
        <ShieldAlert size={13} className="text-[var(--color-warning)] flex-shrink-0" />
        <span className="text-xs font-semibold text-[var(--color-warning)] tracking-wide uppercase">
          Permission Required
        </span>
        <div className="flex-1" />
        <button
          onClick={handleDeny}
          disabled={denying || approving}
          className="w-5 h-5 flex items-center justify-center rounded text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
        >
          <X size={12} />
        </button>
      </div>

      {/* Body */}
      <div className="px-3 py-2.5 space-y-2">
        {/* Tool name & description */}
        <div className="flex items-start gap-2">
          <Terminal size={13} className="text-[var(--color-text-tertiary)] flex-shrink-0 mt-0.5" />
          <div className="min-w-0">
            <span className="text-xs font-mono font-semibold text-[var(--color-text-primary)]">
              {request.toolName}
            </span>
            <p className="text-xs text-[var(--color-text-secondary)] mt-0.5 leading-relaxed line-clamp-3">
              {description}
            </p>
          </div>
        </div>

        {/* Tool input preview (collapsed) */}
        {request.toolInput && Object.keys(request.toolInput).length > 0 && (
          <div className="pl-5">
            <div className="p-2 rounded-md bg-[var(--color-bg-secondary)]/60 border border-[var(--color-separator)] text-[11px] font-mono text-[var(--color-text-tertiary)] whitespace-pre-wrap break-all max-h-20 overflow-y-auto">
              {JSON.stringify(request.toolInput, null, 2)}
            </div>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 px-3 pb-2.5 pt-0.5">
        <button
          onClick={handleDeny}
          disabled={denying || approving}
          className="flex-1 px-3 py-1.5 text-xs font-medium rounded-md border border-[var(--color-separator)] bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)] disabled:opacity-40 transition-colors"
        >
          Deny
        </button>
        <button
          onClick={handleApprove}
          disabled={approving || denying}
          className="flex-1 px-3 py-1.5 text-xs font-semibold rounded-md bg-[var(--color-brand)] text-white hover:brightness-110 disabled:opacity-40 transition-all flex items-center justify-center gap-1.5"
        >
          <Check size={12} />
          {approving ? 'Approving…' : 'Approve'}
        </button>
      </div>
    </div>
  );
}

PermissionPrompt.displayName = 'PermissionPrompt';
