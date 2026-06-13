import React, { useRef, useEffect, useCallback } from 'react';

interface PromptModalProps {
  title?: string;
  defaultValue?: string;
  placeholder?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

const PromptModal: React.FC<PromptModalProps> = ({ title, defaultValue = '', placeholder, onConfirm, onCancel }) => {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') onConfirm(inputRef.current?.value ?? '');
    if (e.key === 'Escape') onCancel();
    e.stopPropagation();
  }, [onConfirm, onCancel]);

  return (
    <div className="prompt-backdrop" onClick={onCancel} onContextMenu={(e) => e.preventDefault()}>
      <div className="prompt-modal" onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        {title && <div className="prompt-title">{title}</div>}
        <input
          ref={inputRef}
          className="prompt-input"
          type="text"
          defaultValue={defaultValue}
          placeholder={placeholder}
          onKeyDown={handleKeyDown}
        />
        <div className="prompt-actions">
          <button className="prompt-btn prompt-cancel" onClick={onCancel}>Cancel</button>
          <button className="prompt-btn prompt-confirm" onClick={() => onConfirm(inputRef.current?.value ?? '')}>OK</button>
        </div>
      </div>
    </div>
  );
};

export default PromptModal;
