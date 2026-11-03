import React, { useCallback, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useT } from '../../i18n/index.js';
import { stripDataUrlPrefix } from '../../lib/imageAttachments.js';

export interface ImageBlockViewProps {
  /** Raw base64 payload, no `data:` prefix. */
  data: string;
  /** MIME type the payload decodes as (e.g. `image/png`). */
  mediaType: string;
  /** Optional caption / alt text, used for the filename. */
  name?: string;
}

/**
 * An image inside a chat message.
 *
 * Renders a bounded thumbnail (so a tall screenshot can't push the conversation
 * off-screen) and opens a full-screen overlay on click. The panel closes on
 * click, Escape, or the close button — no dependency needed for that.
 */
export function ImageBlockView({ data, mediaType, name }: ImageBlockViewProps): React.ReactElement {
  const t = useT();
  const [open, setOpen] = useState(false);
  // Tolerate a caller that passed a full data URL instead of a bare payload.
  const base64 = data.startsWith('data:') ? stripDataUrlPrefix(data) : data;
  const src = `data:${mediaType};base64,${base64}`;

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, close]);

  return (
    <>
      <button
        type="button"
        className="chat-image-thumb"
        onClick={() => setOpen(true)}
        title={name ?? t('composer.imageLabel')}
        aria-label={name ?? t('composer.imageLabel')}
      >
        <img src={src} alt={name ?? t('composer.imageLabel')} loading="lazy" />
      </button>

      {open && (
        <div
          className="chat-image-overlay"
          onClick={close}
          role="dialog"
          aria-modal="true"
          aria-label={name ?? t('composer.imageLabel')}
        >
          <button type="button" className="chat-image-close" onClick={close} aria-label={t('common.close')}>
            <X size={18} />
          </button>
          <img src={src} alt={name ?? t('composer.imageLabel')} />
        </div>
      )}
    </>
  );
}

ImageBlockView.displayName = 'ImageBlockView';