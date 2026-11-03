import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { INGRESS_ADMIN, INGRESS_USER, LAN, setup } from './helpers.js';

describe('admin API and ingress page', () => {
  it('is reachable only through ingress, by HA administrators', async () => {
    const { app } = setup();
    for (const url of ['/', '/api/admin/status', '/web/app.js', '/vnc/vnc.html']) {
      expect((await app.inject({ url, ...LAN })).statusCode).toBe(403);
      expect((await app.inject({ url, ...INGRESS_USER })).statusCode).toBe(403);
    }
    expect((await app.inject({ url: '/api/admin/status', ...INGRESS_ADMIN })).statusCode).toBe(200);
    expect((await app.inject({ url: '/', ...INGRESS_ADMIN })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/admin/tokens', ...LAN, headers: { 'content-type': 'application/json' }, payload: { name: 'x' } })).statusCode).toBe(403);
  });

  it('requires a JSON body for admin writes (no cross-site form posts)', async () => {
    const { app } = setup();
    const r = await app.inject({ method: 'POST', url: '/api/admin/tokens', remoteAddress: '127.0.0.1', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'name=x' });
    expect(r.statusCode).toBe(415);
  });

  it('creates a named token shown once, stores only its hash, and revokes it', async () => {
    const { app, dir, log } = setup();
    const r = await app.inject({ method: 'POST', url: '/api/admin/tokens', ...INGRESS_ADMIN, payload: { name: 'Claude', priority: false } });
    expect(r.statusCode).toBe(201);
    expect(r.headers['cache-control']).toBe('no-store');
    const { token, record } = r.json();
    expect(token).toMatch(/^cmcp_[A-Za-z0-9_-]{43}$/);
    const file = readFileSync(join(dir, 'tokens.json'), 'utf8');
    expect(file).not.toContain(token);
    expect(file).toContain(createHash('sha256').update(token).digest('hex'));
    expect(statSync(join(dir, 'tokens.json')).mode & 0o777).toBe(0o600);
    expect(log.join('\n')).not.toContain(token);
    const status = await app.inject({ url: '/api/admin/status', ...INGRESS_ADMIN });
    expect(status.body).not.toContain(token);
    expect(status.json().tokens.map((t: { name: string }) => t.name)).toEqual(['Claude']);
    expect((await app.inject({ method: 'POST', url: '/api/admin/tokens', ...INGRESS_ADMIN, payload: { name: 'claude' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/admin/tokens', ...INGRESS_ADMIN, payload: { name: '<script>' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: `/api/admin/tokens/${record.id}`, remoteAddress: '127.0.0.1', headers: { 'x-remote-user-id': 'u1', 'x-remote-user-groups': 'system-admin' } })).statusCode).toBe(204);
    expect(log).toContain('[tokens] revoked name="Claude"');
  });

  it('approves a token request from another add-on without ever seeing the token', async () => {
    const { app, share, tokens, config } = setup();
    const secret = `cmcp_${randomBytes(32).toString('base64url')}`;
    const hash = createHash('sha256').update(secret).digest('hex');
    mkdirSync(join(config.shareDir!, 'requests'), { recursive: true });
    writeFileSync(join(config.shareDir!, 'requests', 'cesto.json'), JSON.stringify({ name: 'Cesto', hash, priority: true, requested_at: '2026-11-03T00:00:00Z' }));
    const s = (await app.inject({ url: '/api/admin/status', ...INGRESS_ADMIN })).json();
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0].fingerprint).toBe(`${hash.slice(0, 4).toUpperCase()}-${hash.slice(4, 8).toUpperCase()}`);
    expect(tokens.verify(secret)).toBeUndefined();
    const a = await app.inject({ method: 'POST', url: '/api/admin/requests/approve', ...INGRESS_ADMIN, payload: { hash } });
    expect(a.statusCode).toBe(201);
    expect(tokens.verify(secret)?.name).toBe('Cesto');
    expect(tokens.verify(secret)?.priority).toBe(true);
    expect(share.requests()).toEqual([]);
    expect((await app.inject({ method: 'POST', url: '/api/admin/requests/approve', ...INGRESS_ADMIN, payload: { hash } })).statusCode).toBe(404);
  });

  it('health is public and has no secrets', async () => {
    const { app } = setup();
    const h = (await app.inject({ url: '/health', ...LAN })).json();
    expect(Object.keys(h).sort()).toEqual(['addon_slug', 'allow_checkout', 'credentials_configured', 'queue_length', 'session_checked_at', 'session_valid', 'signing_in', 'status', 'upstream', 'version']);
  });

  it('GET /mcp is not allowed', async () => {
    const { app, tokens } = setup();
    const { token } = tokens.create('a');
    expect((await app.inject({ url: '/mcp', ...LAN, headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(405);
  });
});
