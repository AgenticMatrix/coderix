import { useState } from 'react';
import { useChatStore } from '../../stores/chatStore';

interface QuestionPromptProps {
  onSubmit: (requestId: string, answers: Record<string, string>) => void;
}

export function QuestionPrompt({ onSubmit }: QuestionPromptProps) {
  const pendingQuestion = useChatStore((s) => s.pendingQuestion);
  const [answers, setAnswers] = useState<Record<string, string>>({});

  if (!pendingQuestion) return null;

  const handleSubmit = () => {
    onSubmit(pendingQuestion.toolUseId, answers);
    setAnswers({});
  };

  return (
    <div className="question-overlay">
      <div className="question-dialog">
        <div className="question-header">
          <span className="question-title">Input Required</span>
        </div>
        <div className="question-body">
          {pendingQuestion.questions.map((q, i) => (
            <div key={i} className="question-field">
              <label className="question-label">
                {q.header || q.question}
              </label>
              {q.multiSelect ? (
                <div className="question-options">
                  {q.options.map((opt, j) => (
                    <label key={j} className="question-option">
                      <input
                        type="checkbox"
                        checked={answers[q.question]?.includes(opt.label)}
                        onChange={(e) => {
                          const prev = answers[q.question] ?? '';
                          const parts = prev ? prev.split(',') : [];
                          if (e.target.checked) {
                            parts.push(opt.label);
                          } else {
                            const idx = parts.indexOf(opt.label);
                            if (idx >= 0) parts.splice(idx, 1);
                          }
                          setAnswers({ ...answers, [q.question]: parts.join(',') });
                        }}
                      />
                      <span>{opt.label}</span>
                      <small>{opt.description}</small>
                    </label>
                  ))}
                </div>
              ) : (
                <div className="question-options">
                  {q.options.map((opt, j) => (
                    <label key={j} className="question-option">
                      <input
                        type="radio"
                        name={`q-${i}`}
                        value={opt.label}
                        checked={answers[q.question] === opt.label}
                        onChange={() =>
                          setAnswers({ ...answers, [q.question]: opt.label })
                        }
                      />
                      <span>{opt.label}</span>
                      <small>{opt.description}</small>
                    </label>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="question-actions">
          <button className="btn btn-primary" onClick={handleSubmit}>
            Submit
          </button>
        </div>
      </div>
    </div>
  );
}
