/**
 * Image attachment normalization for the desktop Composer.
 *
 * A user can paste, pick, or drop up to `MAX_IMAGES` images. Each is normalized
 * once, here, before it ever reaches the IPC boundary:
 *   - the media type must be one the provider decodes (PNG/JPEG/GIF/WebP)
 *   - the long edge is capped at `MAX_EDGE`, re-encoding to JPEG unless the
 *     source has alpha
 *
 * The session transcript stores these blocks inline, so an attached image is
 * replayed to the model on every later turn of the conversation. Capping the
 * pixel size is what keeps that from ballooning the transcript and the request.
 * GIF is deliberately left untouched: a canvas re-encode would drop the
 * animation frames.
 */

export const SUPPORTED_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;

export type ImageMediaType = (typeof SUPPORTED_IMAGE_TYPES)[number];

/** Hard cap on how many images one message may carry. */
export const MAX_IMAGES = 8;

/** Raw file size ceiling before normalization (8 MB). */
export const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

/** Long-edge ceiling after normalization, matching what vision models decode well. */
export const MAX_EDGE = 1568;

/** Re-encode quality for the JPEG path. */
export const JPEG_QUALITY = 0.85;

export type ImageErrorCode =
  | 'unsupported'
  | 'too-large'
  | 'too-many'
  | 'read-failed';

export class ImageAttachmentError extends Error {
  readonly code: ImageErrorCode;

  constructor(code: ImageErrorCode, message: string) {
    super(message);
    this.name = 'ImageAttachmentError';
    this.code = code;
  }
}

/** One normalized image ready to send and to preview. */
export interface ImageAttachment {
  /** Renderer-local id, used as the React key and for removal. */
  id: string;
  mediaType: ImageMediaType;
  /** Raw base64 payload without the `data:` prefix. */
  data: string;
  /** Original file name when the image came from a file (absent for pastes). */
  name?: string;
  /** `data:<mediaType>;base64,<data>` — what the thumbnail renders. */
  previewUrl: string;
  width: number;
  height: number;
  /** Normalized byte size, for the size caption. */
  bytes: number;
}

/** True when the browser-declared MIME type is one the provider accepts. */
export function isSupportedImageType(mediaType: string): mediaType is ImageMediaType {
  return (SUPPORTED_IMAGE_TYPES as readonly string[]).includes(mediaType.toLowerCase());
}

/** Strip the `data:<type>;base64,` prefix from a data URL. */
export function stripDataUrlPrefix(dataUrl: string): string {
  const idx = dataUrl.indexOf(',');
  return idx === -1 ? dataUrl : dataUrl.slice(idx + 1);
}

/**
 * Target dimensions for an image whose long edge may exceed `MAX_EDGE`.
 * Returns `null` when the image already fits and needs no re-encode.
 */
export function planResize(
  width: number,
  height: number,
  maxEdge = MAX_EDGE,
): { width: number; height: number } | null {
  const longEdge = Math.max(width, height);
  if (longEdge <= maxEdge || longEdge === 0) return null;
  const scale = maxEdge / longEdge;
  return {
    // Never round down to 0 — a 1px-tall panorama must still produce a valid image.
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Approximate decoded size of a base64 payload, for the size caption. */
export function base64ByteLength(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

function createAttachmentId(): string {
  return `img-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

/** Canvas-free path for images that already fit: keep the original bytes. */
async function fromOriginal(
  file: File,
  mediaType: ImageMediaType,
  dimensions: { width: number; height: number },
): Promise<ImageAttachment> {
  const dataUrl = await readFileAsDataUrl(file);
  const data = stripDataUrlPrefix(dataUrl);
  return {
    id: createAttachmentId(),
    mediaType,
    data,
    ...(file.name ? { name: file.name } : {}),
    previewUrl: dataUrl,
    width: dimensions.width,
    height: dimensions.height,
    bytes: base64ByteLength(data),
  };
}

/**
 * Read, validate, and (when oversized) downscale one image file.
 *
 * The size/type checks are repeated in the main process before the block is
 * sent; this copy exists so the UI can report a specific reason immediately
 * instead of silently dropping the attachment.
 */
export async function readImageFile(file: File): Promise<ImageAttachment> {
  const mediaType = (file.type || '').toLowerCase();
  if (!isSupportedImageType(mediaType)) {
    throw new ImageAttachmentError(
      'unsupported',
      `Unsupported image type: ${file.type || '(empty)'}`,
    );
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new ImageAttachmentError('too-large', `Image exceeds ${MAX_SOURCE_BYTES} bytes`);
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new ImageAttachmentError('read-failed', 'Could not decode image');
  }

  try {
    const source = { width: bitmap.width, height: bitmap.height };

    // A GIF's animation lives in its frames, which a single canvas draw loses.
    const target = mediaType === 'image/gif' ? null : planResize(source.width, source.height);
    if (!target) return await fromOriginal(file, mediaType, source);

    const canvas = new OffscreenCanvas(target.width, target.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return await fromOriginal(file, mediaType, source);
    ctx.drawImage(bitmap, 0, 0, target.width, target.height);

    // PNG keeps transparency; everything else re-encodes smaller as JPEG.
    const outputType = mediaType === 'image/png' ? 'image/png' : 'image/jpeg';
    const blob = await canvas.convertToBlob({ type: outputType, quality: JPEG_QUALITY });
    const dataUrl = await readFileAsDataUrl(blob);
    const data = stripDataUrlPrefix(dataUrl);

    return {
      id: createAttachmentId(),
      mediaType: outputType as ImageMediaType,
      data,
      ...(file.name ? { name: file.name } : {}),
      previewUrl: dataUrl,
      width: target.width,
      height: target.height,
      bytes: base64ByteLength(data),
    };
  } finally {
    bitmap.close();
  }
}

export interface NormalizeResult {
  accepted: ImageAttachment[];
  /** One entry per rejected input, carrying the reason for the Composer's error line. */
  errors: ImageAttachmentError[];
}

/**
 * Normalize a batch of files, honoring the per-message image cap.
 *
 * `existing` is the current attachment list so a paste/drop cannot push the
 * message past `MAX_IMAGES`. Non-image files are ignored rather than reported:
 * a drop of mixed content should attach what it can.
 */
export async function normalizeFiles(
  files: readonly File[],
  existing: readonly ImageAttachment[] = [],
): Promise<NormalizeResult> {
  const accepted: ImageAttachment[] = [];
  const errors: ImageAttachmentError[] = [];
  let room = Math.max(0, MAX_IMAGES - existing.length);

  for (const file of files) {
    if (!isSupportedImageType(file.type || '')) continue;
    if (room <= 0) {
      errors.push(new ImageAttachmentError('too-many', 'Too many images'));
      continue;
    }
    try {
      accepted.push(await readImageFile(file));
      room -= 1;
    } catch (err) {
      errors.push(
        err instanceof ImageAttachmentError
          ? err
          : new ImageAttachmentError('read-failed', 'Could not read image'),
      );
    }
  }

  return { accepted, errors };
}

/**
 * Files carried by a paste or drop, in clipboard order.
 * `clipboardData.items` is preferred because it exposes pasted screenshots,
 * which `files` omits on some platforms.
 */
export function filesFromDataTransfer(data: DataTransfer | null): File[] {
  if (!data) return [];
  const fromItems: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file) fromItems.push(file);
  }
  if (fromItems.length > 0) return fromItems;
  return Array.from(data.files ?? []);
}