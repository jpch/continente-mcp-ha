import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHECKOUT_TOOL, ToolPolicy } from '../src/policy.js';
import { QueueFullError, SerialQueue } from '../src/queue.js';
import { ShareDir } from '../src/share.js';
import { TokenStore } from '../src/tokens.js';
import { FORBIDDEN } from '../scripts/upstream-tools.mjs';
import { REVIEWED } from './helpers.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'cmcp-unit-'));

describe('tool policy', () => {
  it('uses the same checkout pattern as the contract check', () => { expect(CHECKOUT_TOOL.source).toBe(FORBIDDEN.source); expect(CHECKOUT_TOOL.flags).toBe(FORBIDDEN.flags); });
  it('the reviewed continentept-mcp tools contain no checkout-like tool', () => { expect(REVIEWED.filter(n => CHECKOUT_TOOL.test(n))).toEqual([]); expect(REVIEWED).toContain('add_cart_item'); });
  it('allows reviewed tools, blocks checkout-like ones by default', () => {
    let allow = false;
    const p = new ToolPolicy([...REVIEWED, 'checkout'], () => allow);
    expect(p.allows('get_cart')).toBe(true);
    expect(p.allows('clear_cart')).toBe(true);
    expect(p.allows('checkout')).toBe(false);
    expect(p.allows('unknown_tool')).toBe(false);
    allow = true;
    expect(p.allows('checkout')).toBe(true);
    expect(p.allows('pay_now')).toBe(false);
  });
});

describe('serial queue', () => {
  it('runs one job at a time, priority first', async () => {
    const q = new SerialQueue(10);
    const order: string[] = [];
    let release!: () => void;
    const first = q.run(() => new Promise<void>(r => { release = r; order.push('first'); }));
    const normal = q.run(async () => { order.push('normal'); });
    const prio = q.run(async () => { order.push('priority'); }, 'priority');
    expect(q.waiting()).toEqual({ priority: 1, normal: 1 });
    release();
    await Promise.all([first, normal, prio]);
    expect(order).toEqual(['first', 'priority', 'normal']);
  });
  it('rejects when too many calls wait', async () => {
    const q = new SerialQueue(1);
    let release!: () => void;
    const a = q.run(() => new Promise<void>(r => { release = r; }));
    const b = q.run(async () => {});
    await expect(q.run(async () => {})).rejects.toBeInstanceOf(QueueFullError);
    release(); await Promise.all([a, b]);
  });
});

describe('token store', () => {
  it('persists hashes only, verifies and revokes', () => {
    const d = tmp();
    const s = new TokenStore(join(d, 'tokens.json'));
    const { token, record } = s.create('Cesto', true);
    expect(readFileSync(join(d, 'tokens.json'), 'utf8')).not.toContain(token);
    const again = new TokenStore(join(d, 'tokens.json'));
    expect(again.verify(token)?.name).toBe('Cesto');
    expect(again.verify(token + 'x')).toBeUndefined();
    expect(again.verify('Bearer')).toBeUndefined();
    again.revoke(record.id);
    expect(new TokenStore(join(d, 'tokens.json')).verify(token)).toBeUndefined();
  });
});

describe('session hand-off', () => {
  const handoff = (share: string) => {
    const imp = join(share, 'import');
    mkdirSync(join(imp, 'profile'), { recursive: true });
    writeFileSync(join(imp, 'credentials.env'), "CONTINENTE_EMAIL='a@b.pt'\n");
    writeFileSync(join(imp, 'profile', 'cookies'), 'c');
    return imp;
  };
  it('imports into an empty data folder and deletes the hand-off', () => {
    const d = tmp(); const share = new ShareDir(join(d, 'share')); const target = join(d, 'continente');
    const imp = handoff(share.dir);
    expect(share.importSession(target)).toBe('none');
    writeFileSync(join(imp, 'READY'), '');
    symlinkSync('/etc/passwd', join(imp, 'link'));
    expect(share.importSession(target)).toBe('imported');
    expect(readFileSync(join(target, 'profile', 'cookies'), 'utf8')).toBe('c');
    expect(statSync(join(target, 'credentials.env')).mode & 0o777).toBe(0o600);
    expect(existsSync(join(target, 'link'))).toBe(false);
    expect(existsSync(join(target, 'READY'))).toBe(false);
    expect(existsSync(imp)).toBe(false);
  });
  it('never overwrites an existing session', () => {
    const d = tmp(); const share = new ShareDir(join(d, 'share')); const target = join(d, 'continente');
    mkdirSync(target); writeFileSync(join(target, 'credentials.env'), 'own');
    const imp = handoff(share.dir); writeFileSync(join(imp, 'READY'), '');
    expect(share.importSession(target)).toBe('skipped');
    expect(readFileSync(join(target, 'credentials.env'), 'utf8')).toBe('own');
    expect(existsSync(imp)).toBe(false);
  });
  it('writes an endpoint file without secrets and ignores malformed requests', () => {
    const d = tmp(); const share = new ShareDir(join(d, 'share'));
    share.writeEndpoint({ slug: 'x_continente_mcp', hostname: 'x-continente-mcp', port: 8100, version: '1.0.0' });
    expect(JSON.parse(readFileSync(join(share.dir, 'endpoint.json'), 'utf8'))).toEqual({ slug: 'x_continente_mcp', hostname: 'x-continente-mcp', port: 8100, version: '1.0.0', mcp_path: '/mcp' });
    mkdirSync(join(share.dir, 'requests'));
    writeFileSync(join(share.dir, 'requests', 'bad.json'), '{"name":"x","hash":"nothex"}');
    writeFileSync(join(share.dir, 'requests', '../evil.json'.replace('../', 'x')), 'not json');
    expect(share.requests()).toEqual([]);
  });
});
