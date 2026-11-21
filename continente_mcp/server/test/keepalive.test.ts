import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { childEnv, intOption, loadConfig, loginEnv, probeEnv, takeSupervisorToken, upstreamEnv } from '../src/config.js';
import { LoginService } from '../src/login.js';
import { CORE_API, HaSessionNotifier, NOTIFICATION_ID, SENSOR_ENTITY, addonLinks, expiredNotification } from '../src/ha.js';
import { KEEPALIVE_MAX_HOURS, KEEPALIVE_MINUTES, SessionKeepAlive, type KeepAliveOptions } from '../src/keepalive.js';
import { mainProcess, probeSession, separateProcess } from '../src/probe.js';
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

  it('tries again one interval after a failed check, which does not count as a request', async () => {
    const r = rig();
    r.setValid(true);
    r.k.touch();
    const last = r.k.lastRequestAt;
    r.probe.mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce(null);
    await r.advance(15 * MIN);
    expect(r.k.state).toBe('scheduled');
    expect(r.k.lastRequestAt).toBe(last);
    expect(r.k.nextAt).toBe(r.now + 15 * MIN);
    await r.advance(15 * MIN);
    expect(r.k.lastRequestAt).toBe(last);
    expect(r.probe).toHaveBeenCalledTimes(2);
    await r.advance(15 * MIN);
    expect(r.probe).toHaveBeenCalledTimes(3);
    expect(r.k.lastRequestAt).toBe(r.now);
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

  it('has no "no limit" setting', () => {
    expect(() => rig({ maxSessionMs: 0 })).toThrow(RangeError);
    expect(() => rig({ maxSessionMs: -1 })).toThrow(RangeError);
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

  it('separate process: calls only get_cart, without a password, and closes it', async () => {
    const d = dir(); const log = join(d, 'calls.jsonl');
    const ups: StdioUpstream[] = [];
    const make = () => { const u = new StdioUpstream({ command: process.execPath, args: [FAKE], env: { ...probeEnv(d), FAKE_MCP_LOG: log }, maxRestarts: 0 }); ups.push(u); return separateProcess(u); };
    const seen: CallToolResult[] = [];
    expect(await probeSession(make, r => seen.push(r))).toBe(true);
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { name: string; password: string });
    expect(calls).toEqual([expect.objectContaining({ name: 'get_cart', password: 'empty' })]);
    expect(seen).toHaveLength(1);
    expect(ups[0]!.open).toBe(false);
  });

  it('main process (unattended_sign_in off, so no password there either): the check uses it and leaves it running', async () => {
    const d = dir(); const log = join(d, 'calls.jsonl');
    const main = new StdioUpstream({ command: process.execPath, args: [FAKE], env: { ...upstreamEnv(d, false), FAKE_MCP_LOG: log } });
    expect(await probeSession(() => mainProcess(main), () => undefined)).toBe(true);
    expect(await probeSession(() => mainProcess(main), () => undefined)).toBe(true);
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { name: string; password: string; pid: number });
    expect(calls.map(c => [c.name, c.password])).toEqual([['get_cart', 'empty'], ['get_cart', 'empty']]);
    expect(new Set(calls.map(c => c.pid)).size).toBe(1);
    expect(main.open).toBe(true);
    await main.close();
  });

  it('reports an expired session as false', async () => {
    const d = dir();
    const make = () => separateProcess(new StdioUpstream({ command: process.execPath, args: [FAKE], env: { ...probeEnv(d), FAKE_MCP_MODE: 'not_authenticated' }, maxRestarts: 0 }));
    expect(await probeSession(make, () => undefined)).toBe(false);
  });

  it('gives up after the timeout and closes the process (stub)', async () => {
    const close = vi.fn(async () => undefined);
    const hung: Upstream = { listTools: async () => [], callTool: () => new Promise(() => undefined), close };
    expect(await probeSession(() => separateProcess(hung), () => undefined, 20)).toBeNull();
    expect(close).toHaveBeenCalled();
    const failing: Upstream = { listTools: async () => [], callTool: async () => { throw new Error('exit'); }, close };
    expect(await probeSession(() => separateProcess(failing), () => undefined)).toBeNull();
    // A hung main process is restarted (closed; the next call starts a new one).
    const mainClose = vi.fn(async () => undefined);
    expect(await probeSession(() => mainProcess({ ...hung, close: mainClose }), () => undefined, 20)).toBeNull();
    expect(mainClose).toHaveBeenCalledOnce();
  });

  it('passes the request timeout to the MCP SDK, never above the check timeout', async () => {
    const seen: (number | undefined)[] = [];
    const u: Upstream = { listTools: async () => [], close: async () => undefined, callTool: async (_n, _a, o) => { seen.push(o?.timeoutMs); return ok(); } };
    await probeSession(() => separateProcess(u), () => undefined);
    await probeSession(() => separateProcess(u), () => undefined, 1_000);
    expect(seen).toEqual([55_000, 1_000]);
  });

  const pidsIn = (log: string) => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(l => (JSON.parse(l) as { pid: number }).pid) : []);
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  it('N1: a hung check (probe timeout first) is abandoned, never retried, and leaves no process alive', async () => {
    const d = dir(); const log = join(d, 'calls.jsonl');
    const u = new StdioUpstream({ command: process.execPath, args: [FAKE], env: { ...probeEnv(d), FAKE_MCP_MODE: 'hang', FAKE_MCP_LOG: log } });
    // Request timeout above the check timeout: the abandon path, not the SDK timeout, ends it.
    expect(await probeSession(() => separateProcess(u), () => undefined, 300, 5_000)).toBeNull();
    await new Promise(r => setTimeout(r, 1_000));
    const pids = pidsIn(log);
    expect(pids).toHaveLength(1);
    await vi.waitFor(() => expect(pids.filter(alive)).toEqual([]), { timeout: 6_000 });
    expect(u.open).toBe(false);
  });

  it('N1: a hung check on the main process (SDK timeout first) restarts it without retries or orphans', async () => {
    const d = dir(); const log = join(d, 'calls.jsonl');
    const main = new StdioUpstream({ command: process.execPath, args: [FAKE], env: { ...upstreamEnv(d, false), FAKE_MCP_MODE: 'hang', FAKE_MCP_LOG: log } });
    expect(await probeSession(() => mainProcess(main), () => undefined, 3_000, 200)).toBeNull();
    await new Promise(r => setTimeout(r, 500));
    const pids = pidsIn(log);
    expect(pids).toHaveLength(1);
    await vi.waitFor(() => expect(pids.filter(alive)).toEqual([]), { timeout: 6_000 });
  });

  it('N1: an agent call that keeps timing out retries in new processes and closes every one', async () => {
    const d = dir(); const log = join(d, 'calls.jsonl');
    const u = new StdioUpstream({ command: process.execPath, args: [FAKE], env: { ...upstreamEnv(d), FAKE_MCP_MODE: 'hang', FAKE_MCP_LOG: log } });
    await expect(u.callTool('get_cart', {}, { timeoutMs: 200 })).rejects.toThrow();
    const pids = pidsIn(log);
    expect(new Set(pids).size).toBe(4);              // first try + 3 restarts
    await vi.waitFor(() => expect(pids.filter(alive)).toEqual([]), { timeout: 6_000 });
    expect(u.open).toBe(false);
  }, 30_000);

  it('N1: close() stops the retries of a running call', async () => {
    const d = dir(); const log = join(d, 'calls.jsonl');
    const u = new StdioUpstream({ command: process.execPath, args: [FAKE], env: { ...upstreamEnv(d), FAKE_MCP_MODE: 'hang', FAKE_MCP_LOG: log } });
    const call = u.callTool('get_cart', {}, { timeoutMs: 5_000 });
    await vi.waitFor(() => expect(pidsIn(log)).toHaveLength(1));
    await u.close();
    await expect(call).rejects.toThrow();
    await new Promise(r => setTimeout(r, 500));
    const pids = pidsIn(log);
    expect(pids).toHaveLength(1);
    await vi.waitFor(() => expect(pids.filter(alive)).toEqual([]), { timeout: 6_000 });
  });

  it('a cart change is never retried', async () => {
    const d = dir(); const log = join(d, 'calls.jsonl');
    const u = new StdioUpstream({ command: process.execPath, args: [FAKE], env: { ...upstreamEnv(d), FAKE_MCP_MODE: 'hang', FAKE_MCP_LOG: log } });
    await expect(u.callTool('set_cart_item_quantity', { productId: '1', quantity: 1 }, { timeoutMs: 200 })).rejects.toThrow();
    expect(pidsIn(log)).toHaveLength(1);
  });

  it('a real hung process: the SDK request times out and the process is closed', async () => {
    const d = dir();
    const u = new StdioUpstream({ command: process.execPath, args: [FAKE], env: { ...probeEnv(d), FAKE_MCP_MODE: 'hang' }, maxRestarts: 0 });
    const t0 = Date.now();
    expect(await probeSession(() => separateProcess(u), () => undefined, 3_000, 300)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2_500);
    expect(u.open).toBe(false);
  });

  it('closing while the process is still starting closes it as soon as it is up', async () => {
    const d = dir(); const log = join(d, 'calls.jsonl');
    const u = new StdioUpstream({ command: process.execPath, args: [FAKE], env: { ...probeEnv(d), FAKE_MCP_LOG: log }, maxRestarts: 0 });
    const call = u.callTool('get_cart', {});
    await u.close();
    await expect(call).rejects.toThrow();
    expect(u.open).toBe(false);
    expect(existsSync(log)).toBe(false);
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
    expect(opts({ session_keepalive: true, session_keepalive_minutes: 10, session_keepalive_max_hours: 12, unattended_sign_in: false, session_sensor: true }))
      .toMatchObject({ sessionKeepalive: true, sessionKeepaliveMinutes: 10, sessionKeepaliveMaxHours: 12, unattendedSignIn: false, sessionSensor: true });
    expect(opts({ session_keepalive_max_hours: 0 }).sessionKeepaliveMaxHours).toBe(6);
    for (const v of [9, 46, 15.5, '15', null]) expect(intOption(v, KEEPALIVE_MINUTES)).toBe(15);
    for (const v of [0, -1, 13, 72, 2.5]) expect(intOption(v, KEEPALIVE_MAX_HOURS)).toBe(6);
    expect(intOption(1, KEEPALIVE_MAX_HOURS)).toBe(1);
    expect(intOption(12, KEEPALIVE_MAX_HOURS)).toBe(12);
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
    let route: ((path: string, method: string) => number | undefined) | undefined;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      const status = route?.(String(url).replace(CORE_API, ''), init?.method ?? 'GET') ?? code;
      if (status === 0) throw new TypeError('fetch failed');
      return new Response(status === 204 ? null : '{}', { status });
    }) as unknown as typeof fetch;
    const timers: (() => void)[] = [];
    const log: string[] = [];
    const n = new HaSessionNotifier({ token: TOKEN, slug: () => 'abc123_continente_mcp', sensor, fetchImpl, log: l => log.push(l), setTimer: fn => { timers.push(fn); return timers.length; }, clearTimer: () => undefined });
    return { n, calls, timers, log, setStatus: (c: number) => { code = c; }, setRoute: (r: typeof route) => { route = r; } };
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

  it('reports itself not working after 3 failed calls in a row, and working again after one success', async () => {
    const h = ha(false, 500);
    expect(h.n.working).toBe(true);                 // nothing needed yet
    await h.n.update(false);
    expect(h.n.working).toBe(true);                 // 1 failure
    const next = async () => { h.timers.shift()!(); await vi.waitFor(() => expect(h.timers.length).toBe(1)); };
    await next();
    expect(h.n.working).toBe(true);                 // 2
    await next();
    expect(h.n.working).toBe(false);                // 3
    h.setStatus(200);
    h.timers.shift()!(); await vi.waitFor(() => expect(h.n.working).toBe(true));
  });

  it('after a Home Assistant restart (API down, then up), shows the notification again while the session is expired', async () => {
    const h = ha(false);
    await h.n.update(false);
    expect(h.n.watching).toBe(true);
    await h.n.watch();                               // HA up and running: nothing to do
    expect(paths(h.calls)).toEqual(['/services/persistent_notification/create', '/']);
    h.setStatus(502);                                // Supervisor proxy while Core restarts
    await h.n.watch();
    h.setStatus(200);
    await h.n.watch();
    expect(paths(h.calls).filter(p => p.endsWith('/create'))).toHaveLength(2);
    expect(h.log).toContain('[ha] Home Assistant restarted: showing the session state again');
  });

  it('a notification dismissed by hand while Home Assistant kept running does not come back', async () => {
    const h = ha(false);
    await h.n.update(false);
    for (let i = 0; i < 5; i++) await h.n.watch();   // the user dismissed it; HA stays up
    expect(paths(h.calls).filter(p => p.endsWith('/create'))).toHaveLength(1);
    // Once the session is valid, there is nothing to watch without the sensor.
    await h.n.update(true);
    const n = h.calls.length;
    await h.n.watch();
    expect(h.calls).toHaveLength(n);
  });

  it('with the sensor on, a missing sensor (404) means Home Assistant restarted: sensor and notification come back', async () => {
    const h = ha(true);
    await h.n.update(false);
    await h.n.watch();
    expect(paths(h.calls).filter(p => p.endsWith('/create'))).toHaveLength(1);
    h.setRoute((path, method) => (method === 'GET' && path === `/states/${SENSOR_ENTITY}` ? 404 : undefined));
    await h.n.watch();
    h.setRoute(undefined);
    expect(paths(h.calls).filter(p => p.endsWith('/create'))).toHaveLength(2);
    expect(h.calls.filter(c => c.init.method === 'POST' && c.url.endsWith(`/states/${SENSOR_ENTITY}`))).toHaveLength(2);
    // While valid, only the sensor is restored after a restart; no notification.
    await h.n.update(true);
    h.setRoute((path, method) => (method === 'GET' && path === `/states/${SENSOR_ENTITY}` ? 404 : undefined));
    await h.n.watch();
    expect(paths(h.calls).filter(p => p.endsWith('/create'))).toHaveLength(2);
    expect(JSON.parse(String(h.calls.at(-1)!.init.body)).state).toBe('on');
  });

  it('N2: only notification calls count for working; sensor and watch failures do not', async () => {
    const h = ha(true);
    h.setRoute((path) => (path.startsWith('/states/') || path === '/' ? 500 : undefined));
    await h.n.update(true);                          // dismiss ok, sensor POST fails
    for (let i = 0; i < 5; i++) { h.timers.shift()?.(); await new Promise(r => setImmediate(r)); }
    for (let i = 0; i < 5; i++) await h.n.watch();
    expect(h.n.working).toBe(true);
    h.setRoute(() => 500);
    await h.n.update(false);
    const next = async () => { h.timers.shift()!(); await new Promise(r => setTimeout(r, 5)); };
    await next(); await next();
    expect(h.n.working).toBe(false);
  });

  it('a network error during watch counts as Home Assistant down', async () => {
    const h = ha(false);
    await h.n.update(false);
    h.setRoute(() => 0);
    await h.n.watch();
    h.setRoute(undefined);
    await h.n.watch();
    expect(paths(h.calls).filter(p => p.endsWith('/create'))).toHaveLength(2);
  });

  it('links only to relative Home Assistant paths (no host names)', () => {
    expect(addonLinks(null)).toEqual({ page: '/hassio/dashboard', info: '/hassio/dashboard' });
    expect(addonLinks('../evil')).toEqual({ page: '/hassio/dashboard', info: '/hassio/dashboard' });
    expect(expiredNotification('a1_continente_mcp').message).not.toMatch(/https?:\/\//);
  });
});

describe('child processes never see the Supervisor token', () => {
  const SECRET = 'supervisor-secret-for-test';
  it('takeSupervisorToken reads it once and removes it (and HASSIO_TOKEN) from the environment', () => {
    const env: NodeJS.ProcessEnv = { SUPERVISOR_TOKEN: SECRET, HASSIO_TOKEN: SECRET, PATH: '/bin' };
    expect(takeSupervisorToken(env)).toBe(SECRET);
    expect(env).toEqual({ PATH: '/bin' });
    expect(takeSupervisorToken({})).toBeUndefined();
  });

  it('childEnv keeps only the allowlist', () => {
    const env = { PATH: '/bin', HOME: '/root', LANG: 'C.UTF-8', LC_ALL: 'C', TZ: 'UTC', NODE_ENV: 'production', DISPLAY: ':1',
      PLAYWRIGHT_BROWSERS_PATH: '/opt/pw', CONTINENTE_DATA_DIR: '/d', CONTINENTE_SIGN_IN_WINDOW: '0', XDG_RUNTIME_DIR: '/run', TMPDIR: '/tmp',
      CONTINENTE_PASSWORD: 'p', CONTINENTE_EMAIL: 'e@example.com', CONTINENTE_CREDENTIALS_FILE: '/x', CONTINENTE_BROWSER_IDLE_SECONDS: '1',
      SUPERVISOR_TOKEN: SECRET, HASSIO_TOKEN: SECRET, OPTIONS_PATH: '/data/options.json', AWS_SECRET: 'x', NODE_OPTIONS: '--inspect' };
    const out = childEnv({ EXTRA: '1' }, env);
    expect(Object.keys(out).sort()).toEqual(['CONTINENTE_DATA_DIR', 'CONTINENTE_SIGN_IN_WINDOW', 'DISPLAY', 'EXTRA', 'HOME', 'LANG', 'LC_ALL', 'NODE_ENV', 'PATH', 'PLAYWRIGHT_BROWSERS_PATH', 'TMPDIR', 'TZ', 'XDG_RUNTIME_DIR']);
  });

  it('continentept-mcp (main and keep-alive processes) and the sign-in processes get no token', async () => {
    const d = mkdtempSync(join(tmpdir(), 'cmcp-env-'));
    process.env.SUPERVISOR_TOKEN = SECRET;
    process.env.HASSIO_TOKEN = SECRET;
    try {
      const log = join(d, 'calls.jsonl');
      for (const env of [upstreamEnv(d, true), upstreamEnv(d, false), probeEnv(d)]) {
        const u = new StdioUpstream({ command: process.execPath, args: [FAKE], env: { ...env, FAKE_MCP_LOG: log } });
        await u.callTool('get_cart', {});
        await u.close();
      }
      const calls = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { env: string[] });
      expect(calls).toHaveLength(3);
      for (const c of calls) { expect(c.env).not.toContain('SUPERVISOR_TOKEN'); expect(c.env).not.toContain('HASSIO_TOKEN'); expect(c.env).toContain('CONTINENTE_DATA_DIR'); }

      // LoginService: display, websockify and the sign-in command, each dumping its environment.
      const dump = (name: string) => ({ command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(join(d, name))}, JSON.stringify(process.env)); setTimeout(() => {}, ${name === 'login' ? 0 : 5000})`] });
      const login = new LoginService({ display: dump('display'), websockify: dump('ws'), login: dump('login'), env: loginEnv(d, ':99'), displayDelayMs: 10 });
      const done = new Promise<void>(r => login.once('failed', () => r()).once('success', () => r()));
      login.start();
      await done;
      for (const name of ['display', 'ws', 'login']) {
        await vi.waitFor(() => expect(existsSync(join(d, name))).toBe(true));
        const env = JSON.parse(readFileSync(join(d, name), 'utf8')) as Record<string, string>;
        expect(env.SUPERVISOR_TOKEN, name).toBeUndefined();
        expect(env.HASSIO_TOKEN, name).toBeUndefined();
        expect(env.DISPLAY, name).toBe(':99');
        expect(env.CONTINENTE_DATA_DIR, name).toBe(d);
        expect(env.PATH, name).toBeTruthy();
      }
      expect(JSON.stringify(readFileSync(log, 'utf8'))).not.toContain(SECRET);
    } finally {
      delete process.env.SUPERVISOR_TOKEN;
      delete process.env.HASSIO_TOKEN;
    }
  });
});

describe('what restarts the keep-alive wait', () => {
  it('a signed-in tool that returned a result does; a transport error does not', async () => {
    const { Gateway } = await import('../src/gateway.js');
    const { ToolPolicy } = await import('../src/policy.js');
    const { REVIEWED } = await import('./helpers.js');
    let fail = false;
    const upstream: Upstream = { listTools: async () => [], close: async () => undefined,
      callTool: async n => { if (fail) throw new Error('upstream exited'); return ok(n); } };
    const touched: string[] = [];
    const g = new Gateway({ upstream, policy: new ToolPolicy(REVIEWED, () => false), queue: new SerialQueue(5), session: new SessionTracker(),
      auditLog: () => undefined, version: 't', onUpstreamCall: t => touched.push(t) });
    const agent = { id: 'a', name: 'a', priority: false } as never;
    await g.call(agent, 'get_cart', {});
    fail = true;
    const r = await g.call(agent, 'get_cart', {});
    expect(r.isError).toBe(true);
    expect(touched).toEqual(['get_cart']);
  });
});
