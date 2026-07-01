import React, { useState, useRef, useCallback, type KeyboardEvent } from 'react';
import { ArrowUp, Cpu } from 'lucide-react';
import styles from './Composer.module.css';

export interface ComposerProps {
  /** Current input value */
  value?: string;
  /** Input change handler */
  onChange?: (value: string) => void;
  /** Submit handler */
  onSubmit?: (value: string) => void;
  /** Current model */
  model?: string;
  /** Model picker handler */
  onModelPick?: () => void;
  /** Whether input is disabled (e.g., during streaming) */
  disabled?: boolean;
  /** Placeholder text */
  placeholder?: string;
}

/**
 * Composer — WeChat/Apple-style bottom input bar.
 * Textarea with auto-resize, send button, model picker, and shortcut hint.
 */
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

  // Auto-resize textarea
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value;
      setInternalValue(newValue);
      onChange?.(newValue);

      // Auto-resize
      const textarea = textareaRef.current;
      if (textarea) {
        textarea.style.height = 'auto';
        textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
      }
    },
    [onChange],
  );

  // Submit on Enter (without Shift)
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey) {
        e.preventDefault();
        if (canSend) {
          onSubmit?.(currentValue.trim());
          setInternalValue('');
          onChange?.('');
          // Reset textarea height
          if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
          }
        }
      }
      // Cmd+Enter also submits
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
    <div className={styles.composer}>
      {/* Main input row */}
      <div className={styles.composerInputRow}>
        {/* Input wrapper */}
        <div className={styles.composerInputWrapper}>
          <textarea
            ref={textareaRef}
            className={styles.composerInput}
            placeholder={placeholder}
            value={currentValue}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            rows={1}
            aria-label="Message input"
          />
          <span className={styles.shortcutHint}>⌘⏎</span>
        </div>

        {/* Action buttons */}
        <div className={styles.composerActions}>
          {/* Model picker */}
          <button
            className={styles.modelPickerBtn}
            onClick={onModelPick}
            title="Select model"
            type="button"
          >
            <Cpu size={12} />
            <span>{model}</span>
          </button>

          {/* Send button */}
          <button
            className={styles.sendBtn}
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
