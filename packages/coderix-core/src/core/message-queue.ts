export interface QueuedMessage {
  text: string;
  timestamp: number;
}

type DrainCallback = (message: string) => void;

export class MessageQueue {
  private queue: QueuedMessage[] = [];
  private drainCallbacks: Set<DrainCallback> = new Set();

  enqueue(text: string): void {
    this.queue.push({ text, timestamp: Date.now() });
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
        fn(next.text);
      } catch {
        // swallow errors in drain callbacks
      }
    }
  }

  clear(): void {
    this.queue.length = 0;
  }
}
