import React from 'react';
import { motion } from 'framer-motion';

export interface SpinnerProps {
  /** Size preset */
  size?: 'sm' | 'md' | 'lg';
  /** Custom color — defaults to brand */
  color?: string;
  /** Additional CSS classes */
  className?: string;
}

const sizePx: Record<NonNullable<SpinnerProps['size']>, number> = {
  sm: 14,
  md: 20,
  lg: 28,
};

const strokeWidth: Record<NonNullable<SpinnerProps['size']>, number> = {
  sm: 2,
  md: 2.5,
  lg: 3,
};

export function Spinner({
  size = 'md',
  color = 'var(--color-brand)',
  className = '',
}: SpinnerProps): React.ReactElement {
  const px = sizePx[size];
  const sw = strokeWidth[size];
  const radius = (px - sw) / 2;
  const circumference = 2 * Math.PI * radius;

  return (
    <motion.svg
      width={px}
      height={px}
      viewBox={`0 0 ${px} ${px}`}
      className={className}
      animate={{ rotate: 360 }}
      transition={{ repeat: Infinity, duration: 0.8, ease: 'linear' }}
      role="status"
      aria-label="Loading"
    >
      <circle
        cx={px / 2}
        cy={px / 2}
        r={radius}
        fill="none"
        stroke="var(--color-bg-tertiary)"
        strokeWidth={sw}
      />
      <motion.circle
        cx={px / 2}
        cy={px / 2}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth={sw}
        strokeLinecap="round"
        strokeDasharray={circumference}
        animate={{ strokeDashoffset: [circumference, circumference * 0.25] }}
        transition={{ repeat: Infinity, duration: 1, ease: 'easeInOut' }}
      />
    </motion.svg>
  );
}

Spinner.displayName = 'Spinner';
