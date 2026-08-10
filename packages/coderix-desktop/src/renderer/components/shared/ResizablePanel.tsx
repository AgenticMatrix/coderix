import React, { useCallback, useRef, useState, useEffect, type ReactNode } from 'react';

export interface ResizablePanelProps {
  /** Panel content */
  children: ReactNode;
  /** Which side the resize handle is on */
  direction: 'left' | 'right' | 'top' | 'bottom';
  /** Initial size in pixels */
  defaultSize: number;
  /** Minimum size constraint */
  minSize: number;
  /** Maximum size constraint */
  maxSize: number;
  /** Current size override (for controlled usage) */
  size?: number;
  /** Size change callback */
  onResize?: (size: number) => void;
  /** Is the panel collapsed */
  collapsed?: boolean;
  /** Collapsed size (usually 0) */
  collapsedSize?: number;
  /** Additional CSS classes */
  className?: string;
  /** Resize handle CSS classes */
  handleClassName?: string;
}

export function ResizablePanel({
  children,
  direction,
  defaultSize,
  minSize,
  maxSize,
  size: controlledSize,
  onResize,
  collapsed = false,
  collapsedSize = 0,
  className = '',
  handleClassName = '',
}: ResizablePanelProps): React.ReactElement {
  const [internalSize, setInternalSize] = useState(defaultSize);
  const panelRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const startPos = useRef(0);
  const startSize = useRef(0);

  const currentSize = controlledSize ?? internalSize;
  const displaySize = collapsed ? collapsedSize : currentSize;

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      isDragging.current = true;
      const isHorizontal = direction === 'left' || direction === 'right';
      startPos.current = isHorizontal ? e.clientX : e.clientY;
      startSize.current = currentSize;

      document.body.style.cursor = isHorizontal ? 'col-resize' : 'row-resize';
      document.body.style.userSelect = 'none';
    },
    [direction, currentSize],
  );

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;

      const isHorizontal = direction === 'left' || direction === 'right';
      const currentPos = isHorizontal ? e.clientX : e.clientY;
      const delta = currentPos - startPos.current;

      // For left/right, positive delta means larger panel
      const multiplier = direction === 'left' || direction === 'top' ? 1 : -1;
      const newSize = Math.max(minSize, Math.min(maxSize, startSize.current + delta * multiplier));

      setInternalSize(newSize);
      onResize?.(newSize);
    };

    const handleMouseUp = () => {
      if (isDragging.current) {
        isDragging.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [direction, minSize, maxSize, onResize]);

  const isHorizontal = direction === 'left' || direction === 'right';
  const sizeStyle = isHorizontal ? { width: displaySize } : { height: displaySize };

  const handlePositionStyles: Record<string, string> = {
    right: 'left-0 top-0 h-full w-[3px] cursor-col-resize bg-transparent hover:bg-[var(--color-brand)]/40 active:bg-[var(--color-brand)]/60 transition-colors z-10',
    left: 'right-0 top-0 h-full w-[3px] cursor-col-resize bg-transparent hover:bg-[var(--color-brand)]/40 active:bg-[var(--color-brand)]/60 transition-colors z-10',
    bottom: 'top-0 left-0 w-full h-[3px] cursor-row-resize bg-transparent hover:bg-[var(--color-brand)]/40 active:bg-[var(--color-brand)]/60 transition-colors z-10',
    top: 'bottom-0 left-0 w-full h-[3px] cursor-row-resize bg-transparent hover:bg-[var(--color-brand)]/40 active:bg-[var(--color-brand)]/60 transition-colors z-10',
  };

  return (
    <div ref={panelRef} style={sizeStyle} className={`relative flex-shrink-0 overflow-hidden ${className}`}>
      {children}
      {/* Resize handle */}
      <div
        className={`absolute z-10 ${handlePositionStyles[direction]} ${handleClassName}`}
        onMouseDown={handleMouseDown}
      />
    </div>
  );
}

ResizablePanel.displayName = 'ResizablePanel';
