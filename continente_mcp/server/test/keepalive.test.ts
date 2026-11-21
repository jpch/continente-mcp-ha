import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { intOption, loadConfig, loginEnv, probeEnv, upstreamEnv } from '../src/config.js';
import { CORE_API, HaSessionNotifier, NOTIFICATION_ID, SENSOR_ENTITY, addonLinks, expiredNotification } from '../src/ha.js';
import { KEEPALIVE_MAX_HOURS, KEEPALIVE_MINUTES, SessionKeepAlive, type KeepAliveOptions } from '../src/keepalive.js';
import { probeSession } from '../src/probe.js';
import { SerialQueue } from '../src/queue.js';
import { haSignIn } from '../src/signin.js';
import { SessionTracker, StdioUpstream, sessionEvidence, type Upstream } from '../src/upstream.js';
import { FAKE } from './helpers.js';

const MIN = 60_000;
const ok = (tool = 'get_cart'): CallToolResult => ({ content: [], structuredContent: { result: { status: 'success', data: { tool } } } });
const expired = (): CallToolResult => ({ content: [], structuredContent: { result: { status: 'error', error: { code: 'not_authenticated' } } }, isError: true });

/** A keep-alive on a fake clock with manual timers. */
function rig(over: Partial<KeepAliveOptions> = {}) {
  let now = 1_000_000_000_000;
  const timers: { fn: () => void; at: number; id: number }[] = [];
  let ids = 0;
  let valid: boolean | null = true;
  const probe = vi.fn(async (): Promise<boolean | null> => true);
  const k = new SessionKeepAlive({
    enabled: true, intervalMs: 15 * MIN, maxSessionMs: 6 * 60 * MIN, probe, sessionValid: () => valid, signedInAt: () => null,
    now: () => now, random: () => 0.5,
    setTimer: (fn, ms) => { const t = { fn, at: now + ms, id: ++ids }; timers.push(t); return t.id; },
    clearTimer: id => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); },
    ...over,
  });
  return {
    k, probe, timers,
    get now() { return now; },
    setValid(v: boolean | null) { valid = v; k.sessionChanged(v); },
    /** Moves the clock and runs the timers that are due (in order), awaiting each. */
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const t = timers[0];
        if (!t || t.at > end) break;
        timers.shift(); now = t.at; t.fn();
        for (let i = 0; i < 50 && k.state === 'checking'; i++) await new Promise(r => setImmediate(r));
        expect(k.state).not.toBe('checking');
      }
      now = end;
    },
  };
}

describe('session keep-alive scheduling', () => {
  it('waits the interval ±20% (jitter drawn per wait)', () => {
    expect(rig({ random: () => 0 }).k.nextDelay()).toBe(12 * MIN);
    expect(rig({ random: () => 1 }).k.nextDelay()).toBe(18 * MIN);
    expect(rig({ random: () => 0.5 }).k.nextDelay()).toBe(15 * MIN);
    const seen = new Set<number>();
    const r = rig({ random: Math.random });
    for (let i = 0; i < 200; i++) { const d = r.k.nextDelay(); expect(d).toBeGreaterThanOrEqual(12 * MIN); expect(d).toBeLessThanOrEqual(18 * MIN); seen.add(d); }
    expect(seen.size).toBeGreaterThan(50);
  });

  it('is off unless enabled, and then never schedules or checks', async () => {
    const r = rig({ enabled: false });
    r.setValid(true); r.k.touch();
    expect(r.k.state).toBe('off'); expect(r.timers).toHaveLength(0);
    await r.advance(10 * 60 * MIN);
    expect(r.probe).not.toHaveBeenCalled();
  });

  it('waits for a valid session before scheduling', () => {
    const r = rig();
    r.setValid(null);
    expect(r.k.state).toBe('waiting_for_session'); expect(r.timers).toHaveLength(0);
    r.setValid(true);
    expect(r.k.state).toBe('scheduled'); expect(r.k.nextAt).toBe(r.now + 15 * MIN);
  });

  it('counts from the last Continente request: every request starts the wait again', async () => {
    const r = rig();
    r.setValid(true);
    await r.advance(10 * MIN);
    r.k.touch();                                     // an agent call at +10 min
    expect(r.k.nextAt).toBe(r.now + 15 * MIN);
    await r.advance(14 * MIN);
    expect(r.probe).not.toHaveBeenCalled();
    await r.advance(1 * MIN);
    expect(r.probe).toHaveBeenCalledOnce();
    // The check is itself a request: the next one is one interval after it, so gaps never exceed interval + jitter.
    expect(r.k.nextAt).toBe(r.now + 15 * MIN);
    await r.advance(15 * MIN);
    expect(r.probe).toHaveBeenCalledTimes(2);
    expect(r.timers).toHaveLength(1);
  });

  it('never leaves a gap above interval + 20% over a long idle period (the Cesto 2.0.4 gap bug)', async () => {
    const r = rig({ random: Math.random });
    r.setValid(true);
    const at: number[] = [r.now];
    r.probe.mockImplementation(async () => { at.push(r.now); return true; });
    await r.advance(5 * 60 * MIN);
    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeLessThanOrEqual(18 * MIN);
    expect(at.length).toBeGreaterThan(15);
  });

  it('stops at the first expired result and does not check again until the session is valid again', async () => {
    const r = rig();
    r.setValid(true);
    r.probe.mockResolvedValueOnce(false);
    await r.advance(15 * MIN);
    expect(r.probe).toHaveBeenCalledOnce();
    expect(r.k.state).toBe('stopped_expired'); expect(r.timers).toHaveLength(0);
    r.k.touch();                                     // agent calls while expired do not restart it
    await r.advance(3 * 60 * MIN);
    expect(r.probe).toHaveBeenCalledOnce();
    r.setValid(true);                                // e.g. signed in on the add-on page
    expect(r.k.state).toBe('scheduled');
  });

  it('keeps the stop when the check result already reached the session tracker', async () => {
    const r = rig();
    r.setValid(true);
    r.probe.mockImplementationOnce(async () => { r.setValid(false); return false; });
    await r.advance(15 * MIN);
    expect(r.k.state).toBe('stopped_expired'); expect(r.timers).toHaveLength(0);
  });

  it('tries again after the next interval when a check fails', async () => {
    const r = rig();
    r.setValid(true);
    r.probe.mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce(null);
    await r.advance(15 * MIN);
    expect(r.k.state).toBe('scheduled');
    await r.advance(15 * MIN);
    expect(r.k.state).toBe('scheduled');
    expect(r.probe).toHaveBeenCalledTimes(2);
  });

  it('stops max_hours after the sign-in and starts again after a new sign-in', async () => {
    let signedIn: number | null = null;
    const r = rig({ signedInAt: () => signedIn, maxSessionMs: 6 * 60 * MIN });
    signedIn = r.now;
    r.setValid(true);
    await r.advance(6 * 60 * MIN + 20 * MIN);
    expect(r.k.state).toBe('stopped_max_hours');
    const checks = r.probe.mock.calls.length;
    expect(checks).toBeGreaterThanOrEqual(23); expect(checks).toBeLessThanOrEqual(25);
    await r.advance(60 * MIN);
    expect(r.probe).toHaveBeenCalledTimes(checks);
    signedIn = r.now;                                // an unattended or page sign-in saved a new session.json
    r.k.touch();
    expect(r.k.state).toBe('scheduled');
  });

  it('without a known sign-in time, counts max_hours from when the session was first seen valid', async () => {
    const r = rig({ maxSessionMs: 1 * 60 * MIN });
    r.setValid(true);
    await r.advance(70 * MIN);
    expect(r.k.state).toBe('stopped_max_hours');
  });

  it('max_hours 0 means no limit', async () => {
    const r = rig({ maxSessionMs: 0, signedInAt: () => 0 });
    r.setValid(true);
    await r.advance(48 * 60 * MIN);
    expect(r.k.state).toBe('scheduled');
    expect(r.probe.mock.calls.length).toBeGreaterThan(180);
  });

  it('waits while a sign-in on the add-on page is open', async () => {
    let signingIn = true;
    const r = rig({ signingIn: () => signingIn });
    r.setValid(true);
    await r.advance(16 * MIN);
    expect(r.probe).not.toHaveBeenCalled(); expect(r.k.state).toBe('scheduled');
    signingIn = false;
    await r.advance(15 * MIN);
    expect(r.probe).toHaveBeenCalledOnce();
  });

  it('stop() cancels the timer', () => {
    const r = rig();
    r.setValid(true); r.k.stop();
    expect(r.timers).toHaveLength(0);
    r.setValid(true);
    expect(r.timers).toHaveLength(0);
  });

  it('reports its status without secrets', () => {
    const r = rig();
    r.setValid(true);
    expect(r.k.status()).toEqual({ enabled: true, state: 'scheduled', next_at: new Date(r.now + 15 * MIN).toISOString(), checks: 0 });
  });
});

describe('keep-alive priority', () => {
  it('background jobs run only when no agent call is waiting, and never interrupt one', async () => {
    const q = new SerialQueue(50);
    const order: string[] = [];
    let release!: () => void;
    const first = q.run(() => new Promise<void>(r => { release = () => { order.push('running'); r(); }; }));
    const bg = q.run(async () => { order.push('background'); }, 'background');
    const normal = q.run(async () => { order.push('normal'); });
    const prio = q.run(async () => { order.push('priority'); }, 'priority');
    expect(q.waiting()).toEqual({ priority: 1, normal: 1, background: 1 });
    release();
    await Promise.all([first, bg, normal, prio]);
    expect(order).toEqual(['running', 'priority', 'normal', 'background']);
  });
});

describe('the keep-alive check never signs in', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'cmcp-ka-'));

  it('the check process and the server with unattended_sign_in off get an empty password; sign-in on the page keeps it', () => {
    expect(probeEnv('/d')).toEqual({ CONTINENTE_DATA_DIR: '/d', CONTINENTE_PASSWORD: '', CONTINENTE_UPDATE_CHECK: '0' });
    expect(upstreamEnv('/d', false)).toEqual({ CONTINENTE_DATA_DIR: '/d', CONTINENTE_PASSWORD: '' });
    expect(upstreamEnv('/d', true)).toEqual({ CONTINENTE_DATA_DIR: '/d' });
    expect(upstreamEnv('/d')).not.toHaveProperty('CONTINENTE_PASSWORD');
    expect(loginEnv('/d', ':99')).not.toHaveProperty('CONTINENTE_PASSWORD');
    // No email in the environment: continentept-mcp keeps reading it from credentials.env, so the saved session matches.
    expect(probeEnv('/d')).not.toHaveProperty('CONTINENTE_EMAIL');
  });

  it('calls only get_cart, in a process without a password, and closes it', async () => {
    const d = dir(); const log = join(d, 'calls.jsonl');
    const ups: StdioUpstream[] = [];
    const make = () => { const u = new StdioUpstream({ command: process.execPath, args: [FAKE], env: { ...probeEnv(d), FAKE_MCP_LOG: log }, maxRestarts: 0 }); ups.push(u); return u; };
    const seen: CallToolResult[] = [];
    expect(await probeSession(make, r => seen.push(r))).toBe(true);
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { name: string; password: string });
    expect(calls).toEqual([expect.objectContaining({ name: 'get_cart', password: 'empty' })]);
    expect(seen).toHaveLength(1);
    expect((ups[0] as unknown as { client?: unknown }).client).toBeUndefined();
  });

  it('reports an expired session as false', async () => {
    const d = dir();
    const make = () => new StdioUpstream({ command: process.execPath, args: [FAKE], env: { ...probeEnv(d), FAKE_MCP_MODE: 'not_authenticated' }, maxRestarts: 0 });
    expect(await probeSession(make, () => undefined)).toBe(false);
  });

  it('gives up after the timeout and closes the process', async () => {
    const close = vi.fn(async () => undefined);
    const hung: Upstream = { listTools: async () => [], callTool: () => new Promise(() => undefined), close };
    expect(await probeSession(() => hung, () => undefined, 20)).toBeNull();
    expect(close).toHaveBeenCalledOnce();
    const failing: Upstream = { listTools: async () => [], callTool: async () => { throw new Error('exit'); }, close };
    expect(await probeSession(() => failing, () => undefined)).toBeNull();
  });

  // With the pinned continentept-mcp installed (CI contract job): its own settings loader sees no password.
  const root = (() => { try { return execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(); } catch { return ''; } })();
  const upstreamConfig = join(root, 'continentept-mcp', 'dist', 'config.js');
  it.skipIf(!existsSync(upstreamConfig) && !process.env.REQUIRE_UPSTREAM)('continentept-mcp reads an empty password (no sign-in) while credentials.env has one', async () => {
    const { loadSettings, hasCredentials } = await import(pathToFileURL(upstreamConfig).href) as {
      loadSettings: (env: NodeJS.ProcessEnv) => { email: string; password: string }; hasCredentials: (s: unknown) => boolean };
    const d = dir(); mkdirSync(join(d, 'c'));
    writeFileSync(join(d, 'c', 'credentials.env'), "CONTINENTE_EMAIL='user@example.com'\nCONTINENTE_PASSWORD='secret'\n");
    const base = { HOME: d } as NodeJS.ProcessEnv;
    const probe = loadSettings({ ...base, ...probeEnv(join(d, 'c')) });
    expect(probe.email).toBe('user@example.com');
    expect(probe.password).toBe('');
    expect(hasCredentials(probe)).toBe(false);
    expect(hasCredentials(loadSettings({ ...base, ...upstreamEnv(join(d, 'c'), false) }))).toBe(false);
    expect(hasCredentials(loadSettings({ ...base, ...upstreamEnv(join(d, 'c'), true) }))).toBe(true);
    expect(hasCredentials(loadSettings({ ...base, ...loginEnv(join(d, 'c'), ':99') }))).toBe(true);
  });
});

describe('session evidence', () => {
  it('only signed-in requests count as a valid session; not_authenticated from anything counts as expired', () => {
    expect(sessionEvidence(ok(), 'get_cart')).toBe(true);
    expect(sessionEvidence(ok(), 'search_products')).toBeNull();
    expect(sessionEvidence(ok(), 'get_session_status')).toBeNull();
    expect(sessionEvidence(ok(), 'list_favorites')).toBeNull();
    expect(sessionEvidence(expired(), 'search_products')).toBe(false);
    const t = new SessionTracker();
    t.observe(ok('search_products'), 'search_products');
    expect(t.valid).toBeNull();
    t.observe(ok(), 'get_cart'); expect(t.valid).toBe(true);
    t.observe(ok('search_products'), 'search_products'); expect(t.valid).toBe(true);
    t.observe(expired(), 'get_cart'); expect(t.valid).toBe(false);
    t.observe(ok('get_product'), 'get_product'); expect(t.valid).toBe(false);
  });
});

describe('unattended_sign_in option', () => {
  const opts = (o: unknown) => { const d = mkdtempSync(join(tmpdir(), 'cmcp-opt-')); writeFileSync(join(d, 'o.json'), JSON.stringify(o)); return loadConfig({ OPTIONS_PATH: join(d, 'o.json'), SHARE_DIR: '' }); };
  it('defaults: keep-alive off, 15 min, 6 h, unattended sign-in on (as before), no sensor', () => {
    expect(opts({})).toMatchObject({ sessionKeepalive: false, sessionKeepaliveMinutes: 15, sessionKeepaliveMaxHours: 6, unattendedSignIn: true, sessionSensor: false });
  });
  it('reads the options and rejects out-of-range values', () => {
    expect(opts({ session_keepalive: true, session_keepalive_minutes: 10, session_keepalive_max_hours: 0, unattended_sign_in: false, session_sensor: true }))
      .toMatchObject({ sessionKeepalive: true, sessionKeepaliveMinutes: 10, sessionKeepaliveMaxHours: 0, unattendedSignIn: false, sessionSensor: true });
    for (const v of [9, 46, 15.5, '15', null]) expect(intOption(v, KEEPALIVE_MINUTES)).toBe(15);
    for (const v of [-1, 73, 2.5]) expect(intOption(v, KEEPALIVE_MAX_HOURS)).toBe(6);
    expect(opts({ unattended_sign_in: 'false' }).unattendedSignIn).toBe(true);
  });
  it('with no password in the server, sign-in errors ask to sign in on the page, not to save the account again', () => {
    const missing: CallToolResult = { content: [{ type: 'text', text: 'Sign-in required' }], isError: true, structuredContent: { result: {
      status: 'error', error: { code: 'not_authenticated', message: 'Sign-in required: set CONTINENTE_EMAIL and CONTINENTE_PASSWORD' },
      signIn: { credentials: 'missing', action: 'configure_credentials' } } } };
    expect(JSON.stringify(haSignIn(missing, false))).toContain('no Continente account is saved');
    const saved = JSON.stringify(haSignIn(missing, true));
    expect(saved).not.toContain('no Continente account is saved');
    expect(saved).toContain('sign in there');
    expect(saved).not.toMatch(/CONTINENTE_PASSWORD|signIn/);
  });
});

describe('Home Assistant notification and sensor', () => {
  const TOKEN = 'supervisor-token-value';
  function ha(sensor = false, status = 200) {
    const calls: { url: string; init: RequestInit }[] = [];
    let code = status;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(url), init: init! }); return new Response('{}', { status: code }); }) as unknown as typeof fetch;
    const timers: (() => void)[] = [];
    const log: string[] = [];
    const n = new HaSessionNotifier({ token: TOKEN, slug: () => 'abc123_continente_mcp', sensor, fetchImpl, log: l => log.push(l), setTimer: fn => { timers.push(fn); return timers.length; }, clearTimer: () => undefined });
    return { n, calls, timers, log, setStatus: (c: number) => { code = c; } };
  }
  const paths = (c: { url: string }[]) => c.map(x => x.url.replace(CORE_API, ''));

  it('creates the notification at once when the session drops, once, and dismisses it when valid again', async () => {
    const h = ha();
    await h.n.update(false);
    await h.n.update(false);
    expect(paths(h.calls)).toEqual(['/services/persistent_notification/create']);
    const body = JSON.parse(String(h.calls[0]!.init.body));
    expect(body.notification_id).toBe(NOTIFICATION_ID);
    expect(body.title).toBe('Continente: sessão terminada');
    expect(body.message).toContain('(/hassio/ingress/abc123_continente_mcp)');
    expect(body.message).toContain('(/hassio/addon/abc123_continente_mcp/info)');
    expect(body.message).toMatch(/inicie sessão/);
    await h.n.update(true);
    await h.n.update(true);
    expect(paths(h.calls)).toEqual(['/services/persistent_notification/create', '/services/persistent_notification/dismiss']);
    expect(JSON.parse(String(h.calls[1]!.init.body))).toEqual({ notification_id: NOTIFICATION_ID });
  });

  it('dismisses a notification left from before a restart on the first valid session; unknown does nothing', async () => {
    const h = ha();
    await h.n.update(null);
    expect(h.calls).toHaveLength(0);
    await h.n.update(true);
    expect(paths(h.calls)).toEqual(['/services/persistent_notification/dismiss']);
  });

  it('sends the token only to the Core API through the Supervisor, and never logs it', async () => {
    const h = ha(true, 401);
    await h.n.update(false);
    for (const c of h.calls) {
      expect(c.url.startsWith('http://supervisor/core/api/')).toBe(true);
      expect((c.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    }
    expect(h.log.length).toBeGreaterThan(0);
    for (const l of h.log) expect(l).not.toContain(TOKEN);
    expect(h.log[0]).toBe('[ha] POST /services/persistent_notification/create -> 401');
  });

  it('retries until Home Assistant answers', async () => {
    const h = ha(false, 502);
    await h.n.update(false);
    expect(h.timers).toHaveLength(1);
    h.setStatus(200);
    h.timers[0]!();
    await vi.waitFor(() => expect(h.calls).toHaveLength(2));
    await h.n.update(false);
    expect(h.calls).toHaveLength(2);
  });

  it('publishes binary_sensor.continente_mcp_session only when session_sensor is on', async () => {
    const off = ha(false);
    await off.n.update(true);
    expect(paths(off.calls)).not.toContain(`/states/${SENSOR_ENTITY}`);
    const on = ha(true);
    await on.n.update(null); await on.n.update(true); await on.n.update(false);
    const states = on.calls.filter(c => c.url.endsWith(`/states/${SENSOR_ENTITY}`)).map(c => JSON.parse(String(c.init.body)));
    expect(states.map(s => s.state)).toEqual(['unknown', 'on', 'off']);
    expect(states[0].attributes).toMatchObject({ device_class: 'connectivity' });
  });

  it('links only to relative Home Assistant paths (no host names)', () => {
    expect(addonLinks(null)).toEqual({ page: '/hassio/dashboard', info: '/hassio/dashboard' });
    expect(addonLinks('../evil')).toEqual({ page: '/hassio/dashboard', info: '/hassio/dashboard' });
    expect(expiredNotification('a1_continente_mcp').message).not.toMatch(/https?:\/\//);
  });
});
