/** Lane of a queued upstream call: priority tokens (Cesto) first, then every other agent, FIFO. */
export type Lane = 'priority' | 'normal';

export class QueueFullError extends Error {
  constructor() { super('The Continente MCP queue is full; try again shortly'); this.name = 'QueueFullError'; }
}

/**
 * Single worker in front of the serial Chromium MCP: one upstream call at a time. A waiting
 * priority call always runs before waiting normal calls; a running call is never interrupted.
 */
export class SerialQueue {
  private readonly lanes: Record<Lane, (() => Promise<void>)[]> = { priority: [], normal: [] };
  private busy = false;
  private pending = 0;
  constructor(private readonly maxWaiting = 50) {}

  get length(): number { return this.pending; }
  waiting(): Record<Lane, number> { return { priority: this.lanes.priority.length, normal: this.lanes.normal.length }; }

  run<T>(job: () => Promise<T>, lane: Lane = 'normal'): Promise<T> {
    if (this.lanes.priority.length + this.lanes.normal.length >= this.maxWaiting) return Promise.reject(new QueueFullError());
    this.pending++;
    return new Promise<T>((resolve, reject) => {
      this.lanes[lane].push(async () => { try { resolve(await job()); } catch (e) { reject(e); } });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (;;) {
        const lane: Lane | undefined = this.lanes.priority.length ? 'priority' : this.lanes.normal.length ? 'normal' : undefined;
        if (!lane) break;
        const next = this.lanes[lane].shift()!;
        try { await next(); } finally { this.pending--; }
      }
    } finally { this.busy = false; }
  }
}
