import React from 'react';

export interface BadgeProps {
  /** Badge label */
  children: React.ReactNode;
  /** Color variant */
  variant?: 'default' | 'brand' | 'success' | 'warning' | 'danger' | 'info';
  /** Size preset */
  size?: 'sm' | 'md';
  /** Has dot indicator */
  dot?: boolean;
  /** Additional CSS classes */
  className?: string;
}

const variantStyles: Record<NonNullable<BadgeProps['variant']>, string> = {
  default: 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]',
  brand: 'bg-[var(--color-brand)]/10 text-[var(--color-brand)]',
  success: 'bg-[var(--color-success)]/10 text-[var(--color-success)]',
  warning: 'bg-[var(--color-warning)]/10 text-[var(--color-warning)]',
  danger: 'bg-[var(--color-danger)]/10 text-[var(--color-danger)]',
  info: 'bg-[var(--color-info)]/10 text-[var(--color-info)]',
};

const dotColors: Record<NonNullable<BadgeProps['variant']>, string> = {
  default: 'bg-[var(--color-text-tertiary)]',
  brand: 'bg-[var(--color-brand)]',
  success: 'bg-[var(--color-success)]',
  warning: 'bg-[var(--color-warning)]',
  danger: 'bg-[var(--color-danger)]',
  info: 'bg-[var(--color-info)]',
};

const sizeStyles: Record<NonNullable<BadgeProps['size']>, string> = {
  sm: 'px-1.5 py-0.5 text-[11px] leading-[14px] rounded-[var(--radius-sm)]',
  md: 'px-2 py-1 text-xs rounded-[var(--radius-md)]',
};

export function Badge({
  children,
  variant = 'default',
  size = 'sm',
  dot = false,
  className = '',
}: BadgeProps): React.ReactElement {
  return (
    <span
      className={`
        inline-flex items-center gap-1 font-medium
        ${variantStyles[variant]}
        ${sizeStyles[size]}
        ${className}
      `}
    >
      {dot && (
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dotColors[variant]}`} />
      )}
      {children}
    </span>
  );
}

Badge.displayName = 'Badge';
