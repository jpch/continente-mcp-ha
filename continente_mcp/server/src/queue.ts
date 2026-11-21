/**
 * Lane of a queued upstream call: priority tokens (Cesto) first, then every other agent, FIFO. `background`
 * (the session keep-alive) runs only when no other call is waiting.
 */
export type Lane = 'priority' | 'normal' | 'background';

export class QueueFullError extends Error {
  constructor() { super('The Continente MCP queue is full; try again shortly'); this.name = 'QueueFullError'; }
}

/**
 * Single worker in front of the serial Chromium MCP: one upstream call at a time. A waiting
 * priority call always runs before waiting normal calls, and both before background calls; a running
 * call is never interrupted.
 */
export class SerialQueue {
  private readonly lanes: Record<Lane, (() => Promise<void>)[]> = { priority: [], normal: [], background: [] };
  private busy = false;
  private pending = 0;
  constructor(private readonly maxWaiting = 50) {}

  get length(): number { return this.pending; }
  waiting(): Record<Lane, number> { return { priority: this.lanes.priority.length, normal: this.lanes.normal.length, background: this.lanes.background.length }; }

  run<T>(job: () => Promise<T>, lane: Lane = 'normal'): Promise<T> {
    if (this.lanes.priority.length + this.lanes.normal.length + this.lanes.background.length >= this.maxWaiting) return Promise.reject(new QueueFullError());
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
        const lane: Lane | undefined = (['priority', 'normal', 'background'] as const).find(l => this.lanes[l].length);
        if (!lane) break;
        const next = this.lanes[lane].shift()!;
        try { await next(); } finally { this.pending--; }
      }
    } finally { this.busy = false; }
  }
}
