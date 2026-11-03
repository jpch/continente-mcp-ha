import { readFileSync, existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { setup, REVIEWED } from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

async function start(over = {}, env: Record<string, string> = {}) {
  const s = setup(over, env);
  await s.app.listen({ host: '127.0.0.1', port: 0 });
  const port = (s.app.server.address() as { port: number }).port;
  cleanups.push(async () => { await s.app.close(); await s.upstream.close(); });
  const connect = async (headers: Record<string, string>) => {
    const client = new Client({ name: 'test-agent', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers } }));
    cleanups.push(() => client.close());
    return client;
  };
  return { ...s, port, connect };
}
const calls = (file: string) => existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as { name: string }) : [];

describe('MCP over streamable HTTP', () => {
  it('refuses requests without a valid token', async () => {
    const s = await start();
    for (const auth of [undefined, 'Bearer cmcp_wrong', 'Bearer something']) {
      const r = await fetch(`http://127.0.0.1:${s.port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
      expect(r.status).toBe(401);
    }
    expect(calls(s.calls)).toEqual([]);
  });

  it('lists the reviewed tools and lets any token read and change the cart, logging the agent name', async () => {
    const s = await start();
    const { token } = s.tokens.create('Claude desktop');
    const client = await s.connect({ authorization: `Bearer ${token}` });
    const tools = (await client.listTools()).tools.map(t => t.name).sort();
    expect(tools).toEqual([...REVIEWED].sort());
    const search = await client.callTool({ name: 'search_products', arguments: { query: 'leite' } });
    expect(search.isError).toBeFalsy();
    const add = await client.callTool({ name: 'add_cart_item', arguments: { productId: '4421406', quantity: 2 } });
    expect(add.isError).toBeFalsy();
    expect(calls(s.calls).map(c => c.name)).toEqual(['search_products', 'add_cart_item']);
    const cart = s.log.filter(l => l.startsWith('[cart]'));
    expect(cart).toHaveLength(1);
    expect(cart[0]).toMatch(/^\[cart\] agent="Claude desktop" tool=add_cart_item product=4421406 quantity=2 status=success ms=\d+$/);
    expect(s.log.join('\n')).not.toContain(token);
  });

  it('accepts the X-Continente-MCP-Token header (for Home Assistant ingress)', async () => {
    const s = await start();
    const { token } = s.tokens.create('remote agent');
    const client = await s.connect({ 'x-continente-mcp-token': token });
    expect((await client.listTools()).tools.length).toBe(REVIEWED.length);
  });

  it('hides and refuses checkout-like tools unless allow_checkout is on', async () => {
    const env = { FAKE_EXTRA_TOOLS: 'checkout_cart,pay_order' };
    const off = await start({}, env);
    const { token } = off.tokens.create('agent');
    const c = await off.connect({ authorization: `Bearer ${token}` });
    const names = (await c.listTools()).tools.map(t => t.name);
    expect(names).not.toContain('checkout_cart');
    expect(names).not.toContain('pay_order');
    const r = await c.callTool({ name: 'checkout_cart', arguments: {} });
    expect(r.isError).toBe(true);
    expect(calls(off.calls).map(x => x.name)).not.toContain('checkout_cart');
    expect(off.log.some(l => l.startsWith('[policy] agent="agent" refused tool=checkout_cart'))).toBe(true);

    const on = await start({ allowCheckout: true }, env);
    const t2 = on.tokens.create('agent').token;
    const c2 = await on.connect({ authorization: `Bearer ${t2}` });
    expect((await c2.listTools()).tools.map(t => t.name)).toContain('checkout_cart');
    expect((await c2.callTool({ name: 'checkout_cart', arguments: {} })).isError).toBeFalsy();
    expect(on.log.some(l => l.startsWith('[cart] agent="agent" tool=checkout_cart'))).toBe(true);
  });

  it('never exposes a tool outside the reviewed contract, even with allow_checkout', async () => {
    const s = await start({ allowCheckout: true });
    const { token } = s.tokens.create('agent');
    const c = await s.connect({ authorization: `Bearer ${token}` });
    const r = await c.callTool({ name: 'delete_account', arguments: {} });
    expect(r.isError).toBe(true);
    expect(calls(s.calls)).toEqual([]);
  });

  it('a revoked token stops working at once', async () => {
    const s = await start();
    const { token, record } = s.tokens.create('agent');
    const c = await s.connect({ authorization: `Bearer ${token}` });
    await c.listTools();
    s.tokens.revoke(record.id);
    await expect(c.listTools()).rejects.toThrow();
  });

  it('tracks the session from upstream results', async () => {
    const s = await start({}, { FAKE_MCP_MODE: 'not_authenticated' });
    const { token } = s.tokens.create('agent');
    const c = await s.connect({ authorization: `Bearer ${token}` });
    await c.callTool({ name: 'get_cart', arguments: {} });
    expect(s.session.valid).toBe(false);
    const h = await fetch(`http://127.0.0.1:${s.port}/health`).then(r => r.json());
    expect(h.session_valid).toBe(false);
    expect(h.allow_checkout).toBe(false);
  });
});
