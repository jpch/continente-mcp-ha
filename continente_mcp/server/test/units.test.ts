import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHECKOUT_TOOL, NEVER_EXPOSED_TOOL, ToolPolicy } from '../src/policy.js';
import { QueueFullError, SerialQueue } from '../src/queue.js';
import { ShareDir } from '../src/share.js';
import { TokenStore } from '../src/tokens.js';
import { FORBIDDEN, NEVER, diff, report } from '../scripts/upstream-tools.mjs';
import { REVIEWED } from './helpers.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'cmcp-unit-'));

describe('tool policy', () => {
  it('uses the same checkout pattern as the contract check', () => { expect(CHECKOUT_TOOL.source).toBe(FORBIDDEN.source); expect(CHECKOUT_TOOL.flags).toBe(FORBIDDEN.flags); });
  it('uses the same never-exposed pattern as the contract check', () => { expect(NEVER_EXPOSED_TOOL.source).toBe(NEVER.source); expect(NEVER_EXPOSED_TOOL.flags).toBe(NEVER.flags); });
  it('the only checkout-like reviewed tools are the never-exposed coupon tools', () => {
    expect(REVIEWED.filter(n => CHECKOUT_TOOL.test(n)).sort()).toEqual(['list_coupons', 'set_cart_coupons']);
    expect(REVIEWED).toContain('add_cart_item');
  });
  it('coupon and voucher tools are never allowed, not even with allow_checkout on', () => {
    const p = new ToolPolicy([...REVIEWED, 'apply_voucher'], () => true);
    for (const n of ['list_coupons', 'set_cart_coupons', 'apply_voucher', 'LIST_COUPONS']) expect(p.allows(n), n).toBe(false);
    expect(p.allows('get_cart')).toBe(true);
  });
  it('the contract report marks new coupon tools as never exposed', () => {
    const r = report(diff([], [{ name: 'list_coupons', inputSchema: {}, outputSchema: {} }, { name: 'checkout_now', inputSchema: {}, outputSchema: {} }]), '9.9.9');
    expect(r).toContain('`list_coupons` **(coupon/voucher: never exposed');
    expect(r).toContain('`checkout_now` **(checkout/payment-like name: blocked unless');
  });
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
    expect(q.waiting()).toEqual({ priority: 1, normal: 1, background: 0 });
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

describe('shared folder', () => {
  it('deletes a leftover session hand-off from Cesto 1.x without reading it, and never imports it', () => {
    const d = tmp(); const share = new ShareDir(join(d, 'share'));
    expect(share.discardLegacyHandoff()).toBe(false);
    for (const name of ['import', 'import.tmp']) {
      mkdirSync(join(share.dir, name, 'profile'), { recursive: true });
      writeFileSync(join(share.dir, name, 'credentials.env'), "CONTINENTE_EMAIL='a@b.pt'\n");
    }
    writeFileSync(join(share.dir, 'import', 'READY'), '');
    expect(share.discardLegacyHandoff()).toBe(true);
    expect(existsSync(join(share.dir, 'import'))).toBe(false);
    expect(existsSync(join(share.dir, 'import.tmp'))).toBe(false);
    expect(existsSync(join(d, 'continente'))).toBe(false);
    expect('importSession' in share).toBe(false);
  });
  it('removes a symbolic link named import without following it', () => {
    const d = tmp(); const share = new ShareDir(join(d, 'share')); const outside = join(d, 'outside');
    mkdirSync(outside); writeFileSync(join(outside, 'keep'), 'x'); mkdirSync(share.dir, { recursive: true });
    symlinkSync(outside, join(share.dir, 'import'));
    expect(share.discardLegacyHandoff()).toBe(true);
    expect(readFileSync(join(outside, 'keep'), 'utf8')).toBe('x');
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

// The add-on's translations sit outside server/, so the image build (which copies only server/) skips this;
// the repository's contract job runs it.
const translation = (lang: string) => new URL(`../../translations/${lang}.yaml`, import.meta.url);
describe.skipIf(!existsSync(translation('en')))('add-on option texts', () => {
  // The allow_checkout text must not go stale on each upstream bump (1.0.4 still named 0.13.0).
  for (const lang of ['en', 'pt']) {
    it(`${lang}: allow_checkout names no continentept-mcp version`, () => {
      const text = readFileSync(translation(lang), 'utf8');
      const line = text.split('\n').find(l => l.trim().startsWith('description:') && /allow_checkout|checkout|finalizar/i.test(l));
      expect(line).toBeDefined();
      expect(line).not.toMatch(/continentept-mcp\s+\d+\.\d+\.\d+/);
    });
  }
  it('every add-on option has a name in en and pt', () => {
    const config = readFileSync(new URL('../../config.yaml', import.meta.url), 'utf8');
    const schema = config.slice(config.indexOf('\nschema:\n') + 9).split('\n').filter(l => /^  [a-z_]+:/.test(l)).map(l => l.trim().split(':')[0]);
    expect(schema).toContain('session_keepalive');
    for (const lang of ['en', 'pt']) {
      const text = readFileSync(translation(lang), 'utf8');
      for (const key of schema) expect(text, `${lang}: ${key}`).toMatch(new RegExp(`\\n  ${key}:\\n    name: `));
    }
  });
});
