import * as log from "../../log.js";

type QueuedWork = () => Promise<void>;

export class SerialWorkQueue {
  private queue: QueuedWork[] = [];
  private processing = false;
  private errorLabel: string;

  constructor(errorLabel: string) {
    this.errorLabel = errorLabel;
  }

  enqueue(work: QueuedWork): void {
    this.queue.push(work);
    void this.processNext();
  }

  size(): number {
    return this.queue.length;
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;

    this.processing = true;
    const work = this.queue.shift();

    if (!work) {
      this.processing = false;
      return;
    }

    try {
      await work();
    } catch (err) {
      log.logWarning(this.errorLabel, err instanceof Error ? err.message : String(err));
    } finally {
      this.processing = false;
      void this.processNext();
    }
  }
}
