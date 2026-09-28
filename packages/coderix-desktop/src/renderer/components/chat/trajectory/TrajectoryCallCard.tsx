import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronRight } from 'lucide-react';
import { ContentBlockRenderer } from '../ContentBlockRenderer';
import { TrajectoryMessageRow } from './TrajectoryMessageRow';
import { formatWorkDuration, type TrajectoryCall } from './trajectoryTypes';

export const TrajectoryCallCard = React.memo(function TrajectoryCallCard({
  call,
  revealRowKeys,
}: {
  call: TrajectoryCall;
  revealRowKeys?: Set<string>;
}): React.ReactElement {
  const [userOpened, setUserOpened] = useState(false);
  const hasWork = call.workRows.length > 0;
  const hasAnswer = call.answerBlocks.length > 0;
  // A search match on a work row force-opens the collapsed region (and the row
  // itself via the `reveal` prop), so hidden content is reachable while searching.
  const hasMatchingWorkRow = call.workRows.some((r) => revealRowKeys?.has(r.key));
  const workOpen = call.isStreaming || userOpened || hasMatchingWorkRow;
  const duration = formatWorkDuration(call.durationMs);

  return (
    <article data-trajectory-call="" className="trajectory-call">
      {/* User message — always visible */}
      {call.userBlocks.length > 0 && (
        <div className="trajectory-user">
          {call.userBlocks.map((block, i) => (
            <ContentBlockRenderer key={`${call.key}-user-${i}`} block={block} />
          ))}
        </div>
      )}

      {/* 已工作 X 分 Y 秒 — collapsible agent work region (default collapsed,
          placed above the response) */}
      {hasWork && (
        <div className="trajectory-work">
          <button
            type="button"
            className="trajectory-work-header"
            onClick={() => setUserOpened((v) => !v)}
            aria-expanded={workOpen}
          >
            <span className="trajectory-cplus" aria-hidden="true">
              C
            </span>
            <span className="trajectory-work-label">
              {call.isStreaming ? '正在工作…' : `已工作 ${duration}`}
            </span>
            {!workOpen && call.workRows.length > 0 && (
              <span className="trajectory-work-count">
                {call.workRows.length} 项
              </span>
            )}
            <motion.span
              animate={{ rotate: workOpen ? 90 : 0 }}
              transition={{ duration: 0.15 }}
              className="trajectory-work-chevron"
            >
              <ChevronRight size={13} />
            </motion.span>
          </button>

          <AnimatePresence initial={false}>
            {workOpen && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
                className="trajectory-work-body"
              >
                <div className="trajectory-work-inner">
                  {call.workRows.map((row) => (
                    <TrajectoryMessageRow
                      key={row.key}
                      row={row}
                      isStreaming={!!call.isStreaming}
                      reveal={revealRowKeys?.has(row.key)}
                      durationMs={call.durationMs}
                    />
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      {/* Final answer — always visible */}
      {hasAnswer && (
        <div className="trajectory-answer">
          {call.answerBlocks.map((block, i) => (
            <ContentBlockRenderer
              key={`${call.key}-answer-${i}`}
              block={block}
              isStreaming={!!call.isStreaming}
            />
          ))}
        </div>
      )}
    </article>
  );
});

TrajectoryCallCard.displayName = 'TrajectoryCallCard';
