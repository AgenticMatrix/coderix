import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { MessageSquare, X, Check } from 'lucide-react';
import type { QuestionRequest } from '../../types';
import { answerQuestion } from '../../ipc-client';

interface QuestionPromptProps {
  request: QuestionRequest;
  onResolved: () => void;
}

export function QuestionPrompt({ request, onResolved }: QuestionPromptProps): React.ReactElement {
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setAnswers({});
  }, [request.toolUseId]);

  const questions = request.questions ?? [];

  const updateText = useCallback((header: string, value: string) => {
    setAnswers((prev) => ({ ...prev, [header]: value }));
  }, []);

  const toggleOption = useCallback((header: string, label: string, multiSelect?: boolean) => {
    setAnswers((prev) => {
      const current = prev[header];
      if (multiSelect) {
        const next = new Set(Array.isArray(current) ? current : []);
        if (next.has(label)) next.delete(label);
        else next.add(label);
        return { ...prev, [header]: Array.from(next) };
      }
      return { ...prev, [header]: label };
    });
  }, []);

  const handleSubmit = useCallback(async () => {
    setSubmitting(true);
    try {
      await answerQuestion(request.toolUseId, answers);
    } catch (err) {
      console.error('[QuestionPrompt] Failed:', err);
    } finally {
      setSubmitting(false);
      onResolved();
    }
  }, [answers, onResolved, request.toolUseId]);

  const handleDismiss = useCallback(() => {
    void handleSubmit();
  }, [handleSubmit]);

  const filledCount = useMemo(() => {
    return Object.values(answers).filter((value) => {
      if (Array.isArray(value)) return value.length > 0;
      return value.trim().length > 0;
    }).length;
  }, [answers]);

  return (
    <div className="px-4 pb-3">
      <div className="rounded-[var(--radius-lg)] border border-[var(--color-separator)] bg-[var(--color-bg-secondary)] shadow-[var(--shadow-md)] overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-[var(--color-separator)]">
          <div className="flex items-center gap-2 min-w-0">
            <MessageSquare size={14} className="text-[var(--color-info)] flex-shrink-0" />
            <div className="min-w-0">
              <div className="text-sm font-semibold text-[var(--color-text-primary)] truncate">
                {request.toolName}
              </div>
              <div className="text-xs text-[var(--color-text-tertiary)] truncate">
                需要你补充 {questions.length || 1} 个回答
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={handleDismiss}
            disabled={submitting}
            className="w-7 h-7 flex items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
            aria-label="Close question prompt"
          >
            <X size={14} />
          </button>
        </div>

        <div className="px-4 py-3 space-y-3 max-h-[40vh] overflow-y-auto">
          {questions.map((question) => {
            const current = answers[question.header];
            return (
              <div key={question.header} className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]">
                    {question.header}
                  </span>
                  <span className="text-sm font-medium text-[var(--color-text-primary)]">
                    {question.question}
                  </span>
                </div>

                {question.options && question.options.length > 0 ? (
                  <div className="grid gap-2">
                    {question.options.map((option) => {
                      const selected = Array.isArray(current)
                        ? current.includes(option.label)
                        : current === option.label;
                      return (
                        <button
                          key={option.label}
                          type="button"
                          onClick={() => toggleOption(question.header, option.label, question.multiSelect)}
                          className={`text-left rounded-[var(--radius-md)] border px-3 py-2 transition-colors ${
                            selected
                              ? 'border-[var(--color-brand)] bg-[var(--color-brand)]/10 text-[var(--color-text-primary)]'
                              : 'border-[var(--color-separator)] bg-[var(--color-bg-primary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]'
                          }`}
                        >
                          <div className="flex items-start gap-2">
                            <span className="mt-0.5 flex-shrink-0">
                              {selected ? <Check size={13} className="text-[var(--color-brand)]" /> : <span className="inline-block w-3 h-3 rounded-full border border-current opacity-40" />}
                            </span>
                            <div className="min-w-0">
                              <div className="text-sm font-medium">{option.label}</div>
                              <div className="text-xs opacity-80">{option.description}</div>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <textarea
                    value={typeof current === 'string' ? current : ''}
                    onChange={(e) => updateText(question.header, e.target.value)}
                    rows={3}
                    className="w-full rounded-[var(--radius-md)] border border-[var(--color-separator)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none resize-y"
                    placeholder="输入你的回答..."
                  />
                )}
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-[var(--color-separator)] bg-[var(--color-bg-primary)]">
          <span className="text-xs text-[var(--color-text-tertiary)]">
            已填写 {filledCount}/{questions.length || 1}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleDismiss}
              disabled={submitting}
              className="px-3 py-2 rounded-[var(--radius-md)] border border-[var(--color-separator)] bg-[var(--color-bg-secondary)] text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] transition-colors disabled:opacity-50"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting}
              className="px-3 py-2 rounded-[var(--radius-md)] bg-[var(--color-brand)] text-sm font-medium text-white hover:bg-[var(--color-brand-hover)] transition-colors disabled:opacity-50"
            >
              {submitting ? '提交中...' : '提交'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

QuestionPrompt.displayName = 'QuestionPrompt';
