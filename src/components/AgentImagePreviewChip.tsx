import React, { useState } from 'react';
import { X, ImageIcon, ZoomIn } from 'lucide-react';

export interface AgentImagePreviewChipProps {
  /** The text the chip represents, e.g. "@.termina/clipboard/pasted-...png" */
  agentRef: string;
  /** A base64 data URL for the thumbnail preview. */
  previewDataUrl?: string;
  /** File name (for display in tooltip/title). */
  fileName?: string;
  /** Called when the user clicks the remove (X) button. */
  onRemove?: () => void;
  /** Optional click handler for the thumbnail (e.g. open lightbox). */
  onClick?: () => void;
}

/**
 * Compact preview chip shown when an image has been attached to the
 * agent's current input line. Renders a thumbnail + a short @path label,
 * with an X button to detach the attachment. The actual xterm input only
 * sees the @path text — the chip is purely a visual confirmation.
 */
export const AgentImagePreviewChip: React.FC<AgentImagePreviewChipProps> = ({
  agentRef,
  previewDataUrl,
  fileName,
  onRemove,
  onClick,
}) => {
  const [enlarged, setEnlarged] = useState(false);

  const display = fileName || agentRef.replace(/^@/, '');
  const title = agentRef;

  return (
    <>
      <div
        className="agent-image-chip"
        title={title}
        data-testid="agent-image-chip"
        data-agent-ref={agentRef}
      >
        <div
          className="agent-image-chip-thumb"
          onClick={() => {
            setEnlarged(true);
            onClick?.();
          }}
          role="button"
          tabIndex={0}
          aria-label="Preview attached image"
        >
          {previewDataUrl ? (
            <img src={previewDataUrl} alt={display} draggable={false} />
          ) : (
            <div className="agent-image-chip-thumb-fallback" aria-hidden>
              <ImageIcon size={14} />
            </div>
          )}
        </div>
        <div className="agent-image-chip-label">
          <div className="agent-image-chip-name" title={agentRef}>{display}</div>
          <div className="agent-image-chip-sub">image attached</div>
        </div>
        {previewDataUrl && (
          <button
            type="button"
            className="agent-image-chip-icon"
            onClick={() => setEnlarged(true)}
            title="Enlarge"
            aria-label="Enlarge attached image"
          >
            <ZoomIn size={11} />
          </button>
        )}
        {onRemove && (
          <button
            type="button"
            className="agent-image-chip-remove"
            onClick={onRemove}
            title="Detach image from current input"
            aria-label="Remove attached image"
          >
            <X size={11} />
          </button>
        )}
      </div>

      {enlarged && previewDataUrl && (
        <div
          className="agent-image-lightbox"
          onClick={() => setEnlarged(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Attached image preview"
        >
          <img src={previewDataUrl} alt={display} />
          <div className="agent-image-lightbox-hint">Click anywhere to close</div>
        </div>
      )}
    </>
  );
};
