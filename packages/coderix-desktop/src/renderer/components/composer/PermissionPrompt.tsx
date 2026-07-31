import React, { useState, useCallback, useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import type { PermissionRequest } from '../../types';
import {
  approvePermission,
  approvePermissionSession,
  approvePermissionAlways,
  denyPermission,
} from '../../ipc-client';

export interface PermissionPromptProps {
  request: PermissionRequest;
  onResolved: () => void;
}

const OPTIONS = ['once', 'session', 'always', 'deny'] as const;

export function PermissionPrompt({
  request,
  onResolved,
}: PermissionPromptProps): React.ReactElement {
  const [processing, setProcessing] = useState<string | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const handleChoice = useCallback(
    async (key: string) => {
      setProcessing(key);
      try {
        switch (key) {
          case 'once':
            await approvePermission(request.id);
            break;
          case 'session':
            await approvePermissionSession(request.id);
            break;
          case 'always':
            await approvePermissionAlways(request.id);
            break;
          case 'deny':
            await denyPermission(request.id);
            break;
        }
      } catch (err) {
        console.error('[PermissionPrompt] Failed:', err);
      } finally {
        setProcessing(null);
        onResolved();
      }
    },
    [request.id, onResolved],
  );

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (processing) return;

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setFocusIndex((prev) => (prev + 1) % OPTIONS.length);
          break;
        case 'ArrowUp':
          e.preventDefault();
          setFocusIndex((prev) => (prev - 1 + OPTIONS.length) % OPTIONS.length);
          break;
        case 'Enter':
          e.preventDefault();
          handleChoice(OPTIONS[focusIndex]);
          break;
        case 'Escape':
          e.preventDefault();
          handleChoice('deny');
          break;
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [focusIndex, processing, handleChoice]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        paddingBottom: 100,
        background: 'rgba(0,0,0,0.4)',
      }}
    >
      <div
        style={{
          background: 'var(--color-bg-primary)',
          borderRadius: 12,
          boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
          width: 380,
          maxWidth: '90vw',
          overflow: 'hidden',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            padding: '20px 24px 0',
          }}
        >
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' }}>
              Permission Required
            </div>
            <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 4 }}>
              {request.toolName}
              {request.message ? ` — ${request.message}` : ' needs permission'}
            </div>
          </div>
          <button
            onClick={() => handleChoice('deny')}
            disabled={processing !== null}
            style={{
              width: 28,
              height: 28,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 6,
              border: 'none',
              background: 'transparent',
              color: 'var(--color-text-tertiary)',
              cursor: 'pointer',
              flexShrink: 0,
              marginLeft: 12,
            }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Options */}
        <div style={{ padding: '20px 16px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {OPTIONS.map((key, i) => {
            const isFocused = i === focusIndex;

            let label: string;
            switch (key) {
              case 'once': label = 'Allow once'; break;
              case 'session': label = 'Allow this session'; break;
              case 'always': label = 'Always allow'; break;
              case 'deny': label = 'Deny'; break;
            }

            return (
              <button
                key={key}
                ref={(el) => { btnRefs.current[i] = el; }}
                onClick={() => handleChoice(key)}
                onMouseEnter={() => setFocusIndex(i)}
                disabled={processing !== null}
                style={{
                  width: '100%',
                  padding: '12px 16px',
                  borderRadius: 8,
                  background: isFocused
                    ? 'rgba(217, 119, 87, 0.15)'
                    : 'var(--color-bg-secondary)',
                  color: 'var(--color-text-primary)',
                  fontSize: 14,
                  fontWeight: isFocused ? 600 : 500,
                  cursor: 'pointer',
                  opacity: processing ? 0.4 : 1,
                  outline: 'none',
                  border: isFocused
                    ? '1.5px solid rgba(217, 119, 87, 0.4)'
                    : '1.5px solid transparent',
                  transition: 'background 0.15s, border-color 0.15s',
                }}
              >
                {processing === key ? 'Processing…' : label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

PermissionPrompt.displayName = 'PermissionPrompt';
