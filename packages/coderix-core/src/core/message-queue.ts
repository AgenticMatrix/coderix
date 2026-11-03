/** An image travelling with a queued message (raw base64, no `data:` prefix). */
export interface QueuedImage {
  mediaType: string;
  data: string;
}

export interface QueuedMessage {
  text: string;
  /** Attached images, when the message carried any. */
  images?: QueuedImage[];
  timestamp: number;
}

type DrainCallback = (message: string, images?: QueuedImage[]) => void;

export class MessageQueue {
  private queue: QueuedMessage[] = [];
  private drainCallbacks: Set<DrainCallback> = new Set();

  enqueue(text: string, images?: QueuedImage[]): void {
    this.queue.push({
      text,
      ...(images && images.length > 0 ? { images } : {}),
      timestamp: Date.now(),
    });
  }

  dequeue(): QueuedMessage | undefined {
    return this.queue.shift();
  }

  peek(): QueuedMessage | undefined {
    return this.queue[0];
  }

  get length(): number {
    return this.queue.length;
  }

  get hasPending(): boolean {
    return this.queue.length > 0;
  }

  onDrain(fn: DrainCallback): () => void {
    this.drainCallbacks.add(fn);
    return () => {
      this.drainCallbacks.delete(fn);
    };
  }

  drainNext(): void {
    const next = this.dequeue();
    if (!next) return;
    for (const fn of this.drainCallbacks) {
      try {
        fn(next.text, next.images);
      } catch {
        // swallow errors in drain callbacks
      }
    }
  }

  clear(): void {
    this.queue.length = 0;
  }
}
