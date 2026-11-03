// Image smoke test: the pinned continentept-mcp answers a read-only search over stdio, the gateway
// starts and refuses /mcp without a token, and the sign-in display (Xvnc, noVNC, headed Chromium) works.
// Never calls a cart tool and never signs in.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const wait = ms => new Promise(r => setTimeout(r, ms));
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
  env: { ...process.env, DATA_DIR: dataDir, OPTIONS_PATH: `${dataDir}/none.json`, PORT: '18100', SHARE_DIR: '' } });
let health;
for (let i = 0; i < 50 && !health; i++) { await wait(200); health = await fetch('http://127.0.0.1:18100/health').then(r => r.json()).catch(() => undefined); }
const unauth = await fetch('http://127.0.0.1:18100/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(r => r.status).catch(() => 0);
const page = await fetch('http://127.0.0.1:18100/').then(r => r.status).catch(() => 0);
server.kill();
console.log(JSON.stringify({ health, unauthenticated_mcp: unauth, page_from_lan: page }));
if (!health || health.allow_checkout !== false || unauth !== 401 || page !== 403) process.exit(1);

const xvnc = spawn('Xvnc', [':98', '-geometry', '1024x768', '-depth', '24', '-SecurityTypes', 'None', '-localhost', 'yes', '-rfbport', '5998'], { stdio: 'ignore' });
const ws = spawn('websockify', ['--web', '/usr/share/novnc', '127.0.0.1:16080', '127.0.0.1:5998'], { stdio: 'ignore' });
let novnc = 0;
for (let i = 0; i < 30 && novnc !== 200; i++) { await wait(300); novnc = await fetch('http://127.0.0.1:16080/vnc.html').then(r => r.status).catch(() => 0); }
let headed = false;
try {
  const req = createRequire('/usr/local/lib/node_modules/continentept-mcp/package.json');
  let pw; try { pw = req('playwright'); } catch { pw = req('playwright-core'); }
  const browser = await pw.chromium.launch({ headless: false, env: { ...process.env, DISPLAY: ':98' } });
  const p = await browser.newPage();
  await p.setContent('<p>ok</p>');
  headed = (await p.textContent('p')) === 'ok';
  await browser.close();
} catch (e) { console.log(String(e).slice(0, 500)); }
xvnc.kill(); ws.kill();
console.log(JSON.stringify({ novnc_status: novnc, headed_chromium: headed }));
process.exit(novnc === 200 && headed ? 0 : 1);
