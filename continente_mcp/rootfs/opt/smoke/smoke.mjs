// Image smoke test: the pinned continentept-mcp answers a read-only search over stdio, the gateway
// starts and refuses /mcp without a token, answers a search through its own continentept-mcp child, and the sign-in
// display (Xvnc, noVNC, headed Chromium) works with the same allowlisted environment the add-on gives its children.
// A fake SUPERVISOR_TOKEN is set and must not reach any child process. Never calls a cart tool and never signs in.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const wait = ms => new Promise(r => setTimeout(r, ms));
const FAKE_TOKEN = 'smoke-fake-supervisor-token';
/** Processes other than `except` whose initial environment holds the fake token. */
const leaks = except => readdirSync('/proc').filter(p => /^\d+$/.test(p) && !except.includes(Number(p))).filter(p => {
  try { return readFileSync(`/proc/${p}/environ`, 'latin1').includes(FAKE_TOKEN); } catch { return false; }
});
const transport = new StdioClientTransport({ command: 'continentept-mcp', env: { ...process.env } });
const client = new Client({ name: 'continente-mcp-ha-smoke', version: '1' });
await client.connect(transport);
const result = await client.callTool({ name: 'search_products', arguments: { query: 'leite', limit: 3 } });
const products = result.structuredContent?.result?.data?.products ?? [];
console.log(JSON.stringify({ isError: !!result.isError, count: products.length }));
await client.close();
if (result.isError || products.length === 0) process.exit(1);

const dataDir = mkdtempSync('/tmp/gw-');
const server = spawn('node', ['dist/index.js'], { cwd: '/opt/server', stdio: 'inherit',
  env: { ...process.env, DATA_DIR: dataDir, OPTIONS_PATH: `${dataDir}/none.json`, PORT: '18100', SHARE_DIR: '',
    INGRESS_ADDRESS: '127.0.0.1', SUPERVISOR_TOKEN: FAKE_TOKEN } });
let health;
for (let i = 0; i < 50 && !health; i++) { await wait(200); health = await fetch('http://127.0.0.1:18100/health').then(r => r.json()).catch(() => undefined); }
const unauth = await fetch('http://127.0.0.1:18100/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(r => r.status).catch(() => 0);
// INGRESS_ADDRESS is this host here, so the page answers like through ingress: 200 (403 from anywhere else).
const page = await fetch('http://127.0.0.1:18100/').then(r => r.status).catch(() => 0);
const admin = await fetch('http://127.0.0.1:18100/api/admin/status').then(r => r.json()).catch(() => undefined);
// A search through the gateway: its continentept-mcp child (and that child's Chromium) run with the allowlisted env.
let viaGateway = -1;
try {
  const created = await fetch('http://127.0.0.1:18100/api/admin/tokens', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'smoke' }) }).then(r => r.json());
  const c = new Client({ name: 'smoke-http', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:18100/mcp'), { requestInit: { headers: { authorization: `Bearer ${created.token}` } } }));
  const r = await c.callTool({ name: 'search_products', arguments: { query: 'leite', limit: 3 } });
  viaGateway = r.isError ? -1 : (r.structuredContent?.result?.data?.products ?? []).length;
  await c.close();
} catch (e) { console.log(String(e).slice(0, 300)); }
const gatewayLeaks = leaks([process.pid, server.pid]);
server.kill();
console.log(JSON.stringify({ health, unauthenticated_mcp: unauth, page_via_ingress_address: page, admin_unattended_sign_in: admin?.unattended_sign_in, search_via_gateway: viaGateway, token_in_children: gatewayLeaks.length }));
// No options file: the defaults (checkout blocked, keep-alive off, unattended sign-in on).
if (!health || health.allow_checkout !== false || health.session_keepalive?.enabled !== false || 'unattended_sign_in' in health
  || admin?.unattended_sign_in !== true || unauth !== 401 || page !== 200 || viaGateway <= 0 || gatewayLeaks.length) process.exit(1);

// The sign-in display with the add-on's child environment (the fake token is still in this process's env).
process.env.SUPERVISOR_TOKEN = FAKE_TOKEN;
const { childEnv } = await import('/opt/server/dist/config.js');
const env = childEnv({ DISPLAY: ':98' });
const xvnc = spawn('Xvnc', [':98', '-geometry', '1024x768', '-depth', '24', '-SecurityTypes', 'None', '-localhost', 'yes', '-rfbport', '5998'], { stdio: 'ignore', env });
const ws = spawn('websockify', ['--web', '/usr/share/novnc', '127.0.0.1:16080', '127.0.0.1:5998'], { stdio: 'ignore', env });
let novnc = 0;
for (let i = 0; i < 30 && novnc !== 200; i++) { await wait(300); novnc = await fetch('http://127.0.0.1:16080/vnc.html').then(r => r.status).catch(() => 0); }
let headed = false;
try {
  const req = createRequire('/usr/local/lib/node_modules/continentept-mcp/package.json');
  let pw; try { pw = req('playwright'); } catch { pw = req('playwright-core'); }
  const browser = await pw.chromium.launch({ headless: false, env });
  const p = await browser.newPage();
  await p.setContent('<p>ok</p>');
  headed = (await p.textContent('p')) === 'ok';
  await browser.close();
} catch (e) { console.log(String(e).slice(0, 500)); }
const displayLeaks = leaks([process.pid]);
xvnc.kill(); ws.kill();
console.log(JSON.stringify({ novnc_status: novnc, headed_chromium: headed, token_in_display_processes: displayLeaks.length }));
process.exit(novnc === 200 && headed && !displayLeaks.length ? 0 : 1);
