import React from 'react';
import { useT } from '../../i18n/index.js';
import type { TurnOutcome } from '../../turn-outcome.js';

/**
 * TurnOutcomeLine — a quiet one-line explanation of why the last turn stopped,
 * shown under the final message.
 *
 * It is deliberately low-key: the ending is context, not an alert. Failures
 * still surface through the error banner and the status bar, so this line only
 * says *what happened* (finished normally, hit the token cap, was stopped, …)
 * and never competes with them for attention.
 */
export function TurnOutcomeLine({ outcome }: { outcome: TurnOutcome }): React.ReactElement | null {
  const t = useT();
  if (outcome.kind === 'running') return null;

  return (
    <div className="turn-outcome" role="status">
      <span className={`turn-outcome-dot turn-outcome-dot--${outcome.kind}`} aria-hidden="true" />
      <span>{t(outcome.messageKey)}</span>
    </div>
  );
}

TurnOutcomeLine.displayName = 'TurnOutcomeLine';