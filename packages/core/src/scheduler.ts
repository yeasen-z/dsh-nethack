/**
 * Single-writer scheduler (handoff section 8: "All gameplay inputs, whether
 * from keyboard, UI, skill, or model, pass through a serialized scheduler.").
 *
 * Guarantees:
 *  - At most one runtime delivery is in flight at any time.
 *  - Queued items are checked against the current control epoch BEFORE the
 *    runtime is touched; items from revoked epochs are discarded unexecuted.
 */
export interface ScheduledItem {
  /** Identifier for logging / discarding. */
  id: string;
  /** Epoch captured when this item was queued. */
  epoch: number;
  /** Returns true if this item may still run under current ownership. */
  isCurrent: (epoch: number) => boolean;
  /** The actual serialized work (a full step transaction). */
  run: () => Promise<void>;
}

type QueueEntry = ScheduledItem | null; // null = sentinel meaning "stop here"

export class Scheduler {
  private queue: QueueEntry[] = [];
  private running = false;

  enqueue(item: ScheduledItem): void {
    this.queue.push(item);
    void this.pump();
  }

  /** Remove not-yet-started items rejected by the predicate (e.g. stale epoch). */
  discardWhere(predicate: (item: ScheduledItem) => boolean): string[] {
    const removed: string[] = [];
    this.queue = this.queue.filter((entry) => {
      if (entry !== null && predicate(entry)) {
        removed.push(entry.id);
        return false;
      }
      return true;
    });
    return removed;
  }

  get pending(): number {
    return this.queue.length;
  }

  /** Resolves once the queue drains (used by Stop to settle the boundary). */
  async idle(): Promise<void> {
    if (!this.running && this.queue.length === 0) return;
    await new Promise<void>((resolve) => {
      const check = () => {
        if (!this.running && this.queue.length === 0) resolve();
        else setTimeout(check, 1);
      };
      check();
    });
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const entry = this.queue.shift();
        if (entry == null) continue; // sentinel or empty race
        if (!entry.isCurrent(entry.epoch)) continue; // stale epoch: never reaches runtime
        try {
          await entry.run();
        } catch (err) {
          // A failed item must not wedge the write path; logged upstream via events.
          console.error("[scheduler] item failed:", entry.id, err);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
