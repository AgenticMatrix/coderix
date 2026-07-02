import { useState, useEffect, useRef } from 'react';

/**
 * Shared hook for tool execution timer with blinking indicator.
 *
 * Drives the elapsed-time display and blinking dot that appear
 * while a tool is in the `executing` state.  The same pattern is
 * used by every tool renderer so the UX is consistent regardless
 * of whether tools run sequentially or in parallel.
 */
export function useToolTimer(isActive: boolean): {
  elapsedSecs: string;
  blinkOn: boolean;
} {
  const [tick, setTick] = useState(0);

  // Reset counter when timer becomes active
  useEffect(() => {
    if (isActive) setTick(0);
  }, [isActive]);

  // Continuous 100 ms interval
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  useEffect(() => {
    const id = setInterval(() => {
      if (isActiveRef.current) {
        setTick((t) => t + 1);
      }
    }, 100);
    return () => clearInterval(id);
  }, []);

  const elapsedSecs = (tick * 0.1).toFixed(1);
  const blinkOn = Math.floor(tick / 5) % 2 === 0;

  return { elapsedSecs, blinkOn };
}
