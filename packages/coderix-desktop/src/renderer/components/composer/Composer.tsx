import React, { useState, useRef, useCallback, type KeyboardEvent } from 'react';
import { ArrowUp, Cpu } from 'lucide-react';
import './Composer.css';

export interface ComposerProps {
  value?: string;
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
  model?: string;
  onModelPick?: () => void;
  disabled?: boolean;
  placeholder?: string;
}

export function Composer({
  value: controlledValue,
  onChange,
  onSubmit,
  model = 'sonnet 4.5',
  onModelPick,
  disabled = false,
  placeholder = 'Ask Coderix anything...',
}: ComposerProps): React.ReactElement {
  const [internalValue, setInternalValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const currentValue = controlledValue ?? internalValue;
  const canSend = currentValue.trim().length > 0 && !disabled;

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value;
      setInternalValue(newValue);
      onChange?.(newValue);

      const textarea = textareaRef.current;
      if (textarea) {
        textarea.style.height = 'auto';
        textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
      }
    },
    [onChange],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey) {
        e.preventDefault();
        if (canSend) {
          onSubmit?.(currentValue.trim());
          setInternalValue('');
          onChange?.('');
          if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
          }
        }
      }
      if (e.key === 'Enter' && e.metaKey) {
        e.preventDefault();
        if (canSend) {
          onSubmit?.(currentValue.trim());
          setInternalValue('');
          onChange?.('');
        }
      }
    },
    [canSend, currentValue, onSubmit, onChange],
  );

  const handleSend = useCallback(() => {
    if (canSend) {
      onSubmit?.(currentValue.trim());
      setInternalValue('');
      onChange?.('');
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    }
  }, [canSend, currentValue, onSubmit, onChange]);

  return (
    <div className="composer">
      {/* Model selector row — above the input, Claude Desk style */}
      {onModelPick && (
        <div className="model-selector">
          <button
            className="model-picker-btn"
            onClick={onModelPick}
            title="Select model"
            type="button"
          >
            <Cpu size={12} />
            <span>{model}</span>
          </button>
        </div>
      )}

      {/* Input wrapper — textarea + send button inside, Claude Desk style */}
      <div className="composer-input-wrapper">
        <textarea
          ref={textareaRef}
          className="composer-input"
          placeholder={placeholder}
          value={currentValue}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          rows={1}
          aria-label="Message input"
        />

        <div className="composer-input-actions">
          <button
            className="composer-input-btn send"
            onClick={handleSend}
            disabled={!canSend}
            title="Send message (⌘⏎)"
            type="button"
            aria-label="Send message"
          >
            <ArrowUp size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

Composer.displayName = 'Composer';
