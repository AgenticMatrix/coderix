interface InputBoxProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  disabled?: boolean;
}

export function InputBox({ value, onChange, onSend, onKeyDown, disabled }: InputBoxProps) {
  return (
    <div className="input-box">
      <textarea
        className="input-box-textarea"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={disabled ? 'Coderix is thinking...' : 'Ask anything — Enter to send'}
        disabled={disabled}
        rows={1}
        autoFocus
      />
      <button
        className="input-box-send"
        onClick={onSend}
        disabled={disabled || !value.trim()}
        title="Send (Enter)"
      >
        ↑
      </button>
    </div>
  );
}
