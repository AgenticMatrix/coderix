import React, { forwardRef, type ButtonHTMLAttributes } from 'react';
import { motion, type HTMLMotionProps } from 'framer-motion';

export interface ButtonProps extends Omit<HTMLMotionProps<'button'>, 'children'> {
  /** Visual variant */
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  /** Size preset */
  size?: 'sm' | 'md' | 'lg';
  /** Disabled state */
  disabled?: boolean;
  /** Full width */
  fullWidth?: boolean;
  /** Leading icon */
  icon?: React.ReactNode;
  /** Button label */
  children: React.ReactNode;
}

const variantStyles: Record<NonNullable<ButtonProps['variant']>, string> = {
  primary:
    'bg-[var(--color-brand)] text-white hover:bg-[var(--color-brand-hover)] active:bg-[var(--color-brand-pressed)]',
  secondary:
    'bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)] border border-[var(--color-separator)]',
  ghost:
    'bg-transparent text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]',
  danger:
    'bg-[var(--color-danger)] text-white hover:bg-[#ff5f57] active:bg-[#e0352c]',
};

const sizeStyles: Record<NonNullable<ButtonProps['size']>, string> = {
  sm: 'px-2.5 py-1 text-xs rounded-[var(--radius-sm)] gap-1',
  md: 'px-4 py-2 text-sm rounded-[var(--radius-md)] gap-1.5',
  lg: 'px-5 py-2.5 text-base rounded-[var(--radius-lg)] gap-2',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'primary',
      size = 'md',
      disabled = false,
      fullWidth = false,
      icon,
      children,
      className = '',
      ...rest
    },
    ref,
  ) => {
    return (
      <motion.button
        ref={ref}
        whileTap={disabled ? undefined : { scale: 0.98 }}
        whileHover={disabled ? undefined : { scale: 1.02 }}
        transition={{ duration: 0.1, ease: 'easeOut' }}
        className={`
          inline-flex items-center justify-center font-medium
          transition-colors duration-100 cursor-pointer
          select-none outline-none
          focus-visible:ring-2 focus-visible:ring-[var(--color-brand)] focus-visible:ring-offset-1
          ${variantStyles[variant]}
          ${sizeStyles[size]}
          ${disabled ? 'opacity-40 cursor-not-allowed' : ''}
          ${fullWidth ? 'w-full' : ''}
          ${className}
        `}
        disabled={disabled}
        {...rest}
      >
        {icon && <span className="flex-shrink-0">{icon}</span>}
        {children}
      </motion.button>
    );
  },
);

Button.displayName = 'Button';
