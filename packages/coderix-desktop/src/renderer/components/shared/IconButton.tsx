import React, { forwardRef } from 'react';
import { motion, type HTMLMotionProps } from 'framer-motion';
import { Tooltip } from './Tooltip';

export interface IconButtonProps extends Omit<HTMLMotionProps<'button'>, 'children'> {
  /** Accessible label (required for a11y) */
  label: string;
  /** Icon component */
  icon: React.ReactNode;
  /** Size preset */
  size?: 'sm' | 'md' | 'lg';
  /** Visual variant */
  variant?: 'ghost' | 'subtle';
  /** Show tooltip on hover */
  tooltip?: string;
  /** Keyboard shortcut hint shown in tooltip */
  shortcut?: string;
}

const sizeStyles: Record<NonNullable<IconButtonProps['size']>, string> = {
  sm: 'w-7 h-7 rounded-[var(--radius-sm)]',
  md: 'w-8 h-8 rounded-[var(--radius-md)]',
  lg: 'w-9 h-9 rounded-[var(--radius-md)]',
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ label, icon, size = 'md', variant = 'ghost', tooltip, shortcut, className = '', ...rest }, ref) => {
    const button = (
      <motion.button
        ref={ref}
        aria-label={label}
        whileTap={{ scale: 0.94 }}
        whileHover={{ scale: 1.08 }}
        transition={{ duration: 0.1, ease: 'easeOut' }}
        className={`
          inline-flex items-center justify-center
          transition-colors duration-100 cursor-pointer
          select-none outline-none
          focus-visible:ring-2 focus-visible:ring-[var(--color-brand)] focus-visible:ring-offset-1
          ${
            variant === 'ghost'
              ? 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)]'
              : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]'
          }
          ${sizeStyles[size]}
          ${className}
        `}
        {...rest}
      >
        {icon}
      </motion.button>
    );

    if (tooltip || shortcut) {
      return (
        <Tooltip content={tooltip ?? label} shortcut={shortcut}>
          {button}
        </Tooltip>
      );
    }

    return button;
  },
);

IconButton.displayName = 'IconButton';
