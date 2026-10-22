import { useEffect, useRef, type ReactElement, type ReactNode, type RefObject } from 'react';
import { ChevronUp } from 'lucide-react';

export interface StatRow {
  label: string;
  value: string;
}

export interface StatPillProps {
  icon: ReactNode;
  /** Inline label shown in the status bar. */
  label: string;
  /** Dialog heading. */
  title: string;
  /** Optional headline value in the dialog heading (e.g. exact total). */
  summary?: string;
  rows: readonly StatRow[];
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  /** Tooltip for the trigger. */
  buttonTitle?: string;
  /** Optional shared container of sibling pills: clicks inside it are not
   *  "outside", so clicking another pill switches dialogs in one click. */
  groupRef?: RefObject<HTMLElement | null>;
}

/**
 * A status-bar reading that opens a detail dialog above itself.
 *
 * The dialog is bottom-anchored (`bottom-full`) because the status bar sits on
 * the window's bottom edge. An outside pointerdown or Escape dismisses it.
 */
export function StatPill({
  icon,
  label,
  title,
  summary,
  rows,
  open,
  onToggle,
  onClose,
  buttonTitle,
  groupRef,
}: StatPillProps): ReactElement {
  const rootRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    // Document-level outside-close instead of a full-screen backdrop: a
    // backdrop would swallow the click on a sibling pill, forcing two clicks
    // to switch dialogs. Sibling pills share a `groupRef`, so a click on one is
    // treated as inside and reaches its own toggle handler.
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (groupRef?.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, onClose, groupRef]);

  return (
    <span ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        onClick={onToggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={buttonTitle}
        className="inline-flex items-center gap-1 -mx-1 px-1 py-0.5 rounded whitespace-nowrap transition-colors cursor-pointer text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)]"
      >
        {icon}
        <span className="font-medium tabular-nums">{label}</span>
        <ChevronUp
          size={9}
          className={`transition-transform ${open ? 'rotate-180' : ''} text-[var(--color-text-tertiary)]`}
        />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={title}
          className="absolute bottom-full left-0 mb-2 z-[60] w-64 rounded-[var(--radius-md)] bg-[var(--color-bg-primary)] border border-[var(--color-separator)] shadow-lg overflow-hidden"
        >
          <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-[var(--color-separator)]">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--color-text-primary)]">
              {icon}
              {title}
            </span>
            {summary && (
              <span className="font-mono text-[11px] font-medium text-[var(--color-text-primary)]">
                {summary}
              </span>
            )}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 px-3 py-2 text-[11px]">
            {rows.map((row) => (
              <div key={row.label} className="contents">
                <dt className="text-[var(--color-text-tertiary)]">{row.label}</dt>
                <dd className="text-right font-medium tabular-nums text-[var(--color-text-primary)]">
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </span>
  );
}
