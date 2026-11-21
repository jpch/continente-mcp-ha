/**
 * Session keep-alive (1.0.6, option `session_keepalive`, off by default).
 *
 * Continente's storefront session ends after about 30 idle minutes (measured 27-32.5 min). While the session is
 * known to be valid, the keep-alive sends one read-only `get_cart` when no Continente request was made for
 * `session_keepalive_minutes` (±20% jitter, drawn again for every wait). Every request, from any agent or from the
 * keep-alive itself, starts the wait again, so the gap between two requests never exceeds the interval plus jitter.
 *
 * - The check runs in the queue's background lane: it never goes before a waiting agent call and never interrupts one.
 * - The check can never sign in: it runs in a continentept-mcp process without a password (probe.ts): the main one
 *   when `unattended_sign_in` is off (it then has none), otherwise a separate short-lived one (`probeEnv`).
 * - It stops at the first `not_authenticated` result and does not try again until the session is valid again
 *   (a sign-in on the add-on page, or an agent call that finds a valid session).
 * - It stops `session_keepalive_max_hours` (1-12) after the sign-in (the `session.json` save time). There is no
 *   "no limit" setting.
 * - Only a result counts as a request: a check that failed (timeout, process error) is tried again one interval
 *   later, counted from the failure, without pretending the session was refreshed.
 */
export type KeepAliveState = 'off' | 'waiting_for_session' | 'scheduled' | 'checking' | 'stopped_expired' | 'stopped_max_hours';

export interface KeepAliveOptions {
  enabled: boolean;
  /** Base interval between requests, in milliseconds. */
  intervalMs: number;
  /** Fraction of the interval used as jitter in both directions (default 0.2). */
  jitter?: number;
  /** Stop this long after the sign-in (must be > 0). */
  maxSessionMs: number;
  /** One read-only check that never signs in: true signed in, false expired, null unknown (error, timeout). */
  probe: () => Promise<boolean | null>;
  sessionValid: () => boolean | null;
  /** When the current session was signed in (epoch ms), or null when unknown. */
  signedInAt: () => number | null;
  /** True while a sign-in on the add-on page is open: wait, a check would only race with it. */
  signingIn?: () => boolean;
  now?: () => number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  log?: (line: string) => void;
}

export const KEEPALIVE_MINUTES = { min: 10, max: 45, default: 15 } as const;
export const KEEPALIVE_MAX_HOURS = { min: 1, max: 12, default: 6 } as const;

export class SessionKeepAlive {
  state: KeepAliveState;
  lastRequestAt: number | null = null;
  nextAt: number | null = null;
  checks = 0;
  private timer: unknown;
  /** Start of the max-hours window when the sign-in time is unknown: the first time the session was seen valid. */
  private validSince: number | null = null;
  private stopped = false;

  constructor(private readonly o: KeepAliveOptions) {
    if (!(o.maxSessionMs > 0)) throw new RangeError('maxSessionMs must be positive');
    this.state = o.enabled ? 'waiting_for_session' : 'off';
  }

  private now(): number { return (this.o.now ?? Date.now)(); }

  /** The delay before the next check: interval ± jitter. */
  nextDelay(): number {
    const j = this.o.jitter ?? 0.2;
    const r = (this.o.random ?? Math.random)();
    return Math.round(this.o.intervalMs * (1 + j * (2 * r - 1)));
  }

  /** A signed-in Continente request returned a result (agent call, session check or keep-alive): the wait starts again. */
  touch(at = this.now()): void {
    this.lastRequestAt = at;
    if (this.state === 'scheduled' || this.state === 'stopped_max_hours') this.arm();
  }

  /** The session tracker changed: valid arms the keep-alive, expired stops it, unknown pauses it. */
  sessionChanged(valid: boolean | null): void {
    if (!this.o.enabled || this.stopped) return;
    if (valid === true) {
      this.validSince ??= this.now();
      this.arm();
    } else {
      this.validSince = null;
      this.cancel(valid === false ? 'stopped_expired' : 'waiting_for_session');
      if (valid === false) this.o.log?.('[keepalive] the Continente session has expired: keep-alive stopped (it never signs in)');
    }
  }

  stop(): void { this.stopped = true; this.cancel(this.o.enabled ? 'waiting_for_session' : 'off'); }

  /** True when the session is older than the max-hours limit. */
  private overMaxHours(): boolean {
    const since = this.o.signedInAt() ?? this.validSince;
    return since !== null && this.now() - since >= this.o.maxSessionMs;
  }

  private cancel(state: KeepAliveState): void {
    if (this.timer !== undefined) (this.o.clearTimer ?? ((t: unknown) => clearTimeout(t as NodeJS.Timeout)))(this.timer);
    this.timer = undefined;
    this.nextAt = null;
    this.state = state;
  }

  /** Schedules the next check one interval (± jitter) after `from` (default: the last request). */
  private arm(from?: number): void {
    if (!this.o.enabled || this.stopped || this.state === 'checking') return;
    if (this.o.sessionValid() !== true) { this.cancel('waiting_for_session'); return; }
    if (this.overMaxHours()) {
      if (this.state !== 'stopped_max_hours') this.o.log?.('[keepalive] session_keepalive_max_hours reached since the sign-in: keep-alive stopped');
      this.cancel('stopped_max_hours');
      return;
    }
    this.cancel('scheduled');
    const due = (from ?? this.lastRequestAt ?? this.now()) + this.nextDelay();
    this.nextAt = due;
    const t = (this.o.setTimer ?? setTimeout)(() => { void this.fire(); }, Math.max(0, due - this.now()));
    (t as { unref?: () => void } | undefined)?.unref?.();
    this.timer = t;
  }

  /** Timer due: one check, unless the session changed or a sign-in is open. Public for tests. */
  async fire(): Promise<void> {
    this.timer = undefined;
    if (!this.o.enabled || this.stopped || this.state !== 'scheduled') return;
    if (this.o.sessionValid() !== true) { this.cancel('waiting_for_session'); return; }
    if (this.overMaxHours()) { this.arm(); return; }
    if (this.o.signingIn?.()) { this.arm(this.now()); return; }
    this.state = 'checking';
    this.nextAt = null;
    this.checks++;
    let valid: boolean | null = null;
    try { valid = await this.o.probe(); } catch { valid = null; }
    const at = this.now();
    // Only an answer refreshed the session; a failure did not.
    if (valid !== null) this.lastRequestAt = at;
    // The check's own result already reached the session tracker; if that stopped or paused the keep-alive, keep it so.
    if (this.state !== 'checking') return;
    this.state = 'scheduled';
    if (valid === false) { this.sessionChanged(false); return; }
    if (valid === null) this.o.log?.('[keepalive] session check failed; trying again after the next interval');
    this.arm(at);
  }

  status(): { enabled: boolean; state: KeepAliveState; next_at: string | null; checks: number } {
    return { enabled: this.o.enabled, state: this.state, next_at: this.nextAt === null ? null : new Date(this.nextAt).toISOString(), checks: this.checks };
  }
}
