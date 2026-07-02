import React from 'react';
import * as RadixTooltip from '@radix-ui/react-tooltip';

export interface TooltipProps {
  /** Tooltip content */
  content: string;
  /** Keyboard shortcut to display */
  shortcut?: string;
  /** Content that triggers the tooltip */
  children: React.ReactNode;
  /** Side to render tooltip */
  side?: 'top' | 'bottom' | 'left' | 'right';
  /** Delay before showing (ms) */
  delayDuration?: number;
}

export function Tooltip({
  content,
  shortcut,
  children,
  side = 'top',
  delayDuration = 500,
}: TooltipProps): React.ReactElement {
  return (
    <RadixTooltip.Provider delayDuration={delayDuration}>
      <RadixTooltip.Root>
        <RadixTooltip.Trigger asChild>
          {children}
        </RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content
            side={side}
            sideOffset={6}
            className={`
              z-50 px-2.5 py-1.5 text-xs font-medium leading-[16px]
              text-[var(--color-text-primary)] bg-[var(--color-bg-tertiary)]
              rounded-[var(--radius-md)] border border-[var(--color-separator)]
              shadow-[var(--shadow-md)]
              animate-in fade-in-0 zoom-in-95
              backdrop-blur-sm
            `}
          >
            <span className="inline-flex items-center gap-2">
              {content}
              {shortcut && (
                <kbd className="px-1 py-0.5 text-[10px] rounded-[var(--radius-sm)] bg-[var(--color-bg-secondary)] text-[var(--color-text-tertiary)] font-mono">
                  {shortcut}
                </kbd>
              )}
            </span>
            <RadixTooltip.Arrow className="fill-[var(--color-bg-tertiary)]" />
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
}

Tooltip.displayName = 'Tooltip';
