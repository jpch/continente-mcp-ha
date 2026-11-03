import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { CredentialsStore } from '../src/credentials.js';
import { Gateway } from '../src/gateway.js';
import { ToolPolicy } from '../src/policy.js';
import { SerialQueue } from '../src/queue.js';
import { ShareDir } from '../src/share.js';
import { TokenStore } from '../src/tokens.js';
import { SessionTracker, StdioUpstream } from '../src/upstream.js';
import contract from '../contract/upstream-tools.json' with { type: 'json' };

export const FAKE = fileURLToPath(new URL('./fake-mcp.mjs', import.meta.url));
export const REVIEWED = contract.tools.map(t => t.name);

export function setup(over: Partial<Config> = {}, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cmcp-test-'));
  const config: Config = { allowCheckout: false, logLevel: 'error', dataDir: dir, shareDir: join(dir, 'share'), port: 0, ingressAddress: '127.0.0.1', addonSlug: 'abc_continente_mcp', hostname: 'abc-continente-mcp', ...over };
  const log: string[] = [];
  const upstream = new StdioUpstream({ command: process.execPath, args: [FAKE], env: { FAKE_MCP_LOG: join(dir, 'calls.jsonl'), ...env } });
  const queue = new SerialQueue(50);
  const session = new SessionTracker();
  const extra = env.FAKE_EXTRA_TOOLS ? env.FAKE_EXTRA_TOOLS.split(',') : [];
  const policy = new ToolPolicy([...REVIEWED, ...extra], () => config.allowCheckout);
  const gateway = new Gateway({ upstream, policy, queue, session, auditLog: l => log.push(l), version: 'test' });
  const tokens = new TokenStore(join(dir, 'tokens.json'));
  const share = new ShareDir(config.shareDir!);
  const credentials = new CredentialsStore(dir);
  const app = buildApp({
    config, version: 'test', upstreamVersion: contract.version, tokens, gateway, queue, session, credentials, share,
    checkSession: async () => session.valid, log: l => log.push(l),
  });
  return { dir, config, log, upstream, queue, session, tokens, share, app, calls: join(dir, 'calls.jsonl') };
}

/** Requests from the LAN (direct port), not from Home Assistant ingress. */
export const LAN = { remoteAddress: '192.0.2.20' };
export const INGRESS_ADMIN = { remoteAddress: '127.0.0.1', headers: { 'x-remote-user-id': 'u1', 'x-remote-user-groups': 'system-users,system-admin', 'content-type': 'application/json' } };
export const INGRESS_USER = { remoteAddress: '127.0.0.1', headers: { 'x-remote-user-id': 'u2', 'x-remote-user-groups': 'system-users', 'content-type': 'application/json' } };
