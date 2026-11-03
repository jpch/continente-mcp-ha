import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { CredentialsStore } from './credentials.js';
import { Gateway } from './gateway.js';
import { LoginService } from './login.js';
import { ToolPolicy } from './policy.js';
import { SerialQueue } from './queue.js';
import { ShareDir } from './share.js';
import { TokenStore } from './tokens.js';
import { SessionTracker, StdioUpstream } from './upstream.js';

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });
const pkg = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as { version: string; tools?: { name: string }[] };
const { version } = pkg(new URL('../package.json', import.meta.url).pathname);
// The reviewed tool contract (also checked against the installed package when the image is built).
const contract = pkg(new URL('../contract/upstream-tools.json', import.meta.url).pathname);
const upstreamVersion = contract.version;
const log = (line: string) => console.log(line);

const continenteDir = join(config.dataDir, 'continente');
const mcpCommand = process.env.MCP_COMMAND ?? 'continentept-mcp';
const upstream = new StdioUpstream({ command: mcpCommand, env: { CONTINENTE_DATA_DIR: continenteDir } });
const queue = new SerialQueue(50);
const session = new SessionTracker();
const policy = new ToolPolicy((contract.tools ?? []).map(t => t.name), () => config.allowCheckout);
const gateway = new Gateway({ upstream, policy, queue, session, auditLog: log, version });
const tokens = new TokenStore(join(config.dataDir, 'tokens.json'));
const credentials = new CredentialsStore(config.dataDir);
const share = config.shareDir ? new ShareDir(config.shareDir) : undefined;

// On-demand sign-in: visible browser on a virtual display, viewed through noVNC on the ingress page.
const VNC_PORT = 5999;
const WS_PORT = 6080;
const login = new LoginService({
  display: { command: 'Xvnc', args: [':99', '-geometry', '1280x860', '-depth', '24', '-SecurityTypes', 'None', '-localhost', 'yes', '-rfbport', String(VNC_PORT), '-AlwaysShared'] },
  websockify: { command: 'websockify', args: ['--web', '/usr/share/novnc', `127.0.0.1:${WS_PORT}`, `127.0.0.1:${VNC_PORT}`] },
  login: { command: mcpCommand, args: ['login', '--show-browser'] },
  env: { DISPLAY: ':99', CONTINENTE_DATA_DIR: continenteDir },
});

// A new session or new credentials are only read by a fresh upstream process.
const restartUpstream = () => { void upstream.close(); };
let lastCheck = 0;
let inFlight: Promise<boolean | null> | undefined;
const checkSession = (): Promise<boolean | null> => {
  if (inFlight) return inFlight;
  if (Date.now() - lastCheck < 60_000) return Promise.resolve(session.valid);
  inFlight = queue.run(async () => { session.observe(await upstream.callTool('get_cart', {})); return session.valid; }, 'normal')
    .catch(() => session.valid)
    .finally(() => { lastCheck = Date.now(); inFlight = undefined; });
  return inFlight;
};
login.on('success', () => { restartUpstream(); lastCheck = 0; void checkSession(); });
login.on('failed', () => log('[login] sign-in did not complete'));
session.on('session', (v: boolean | null) => log(`[session] valid=${v}`));

// One-time hand-off of an existing session (Cesto before 2.0.0) and the endpoint file for other add-ons.
const pollShare = () => {
  if (!share) return;
  try {
    share.writeEndpoint({ slug: config.addonSlug, hostname: config.hostname, port: config.port, version });
    const r = share.importSession(continenteDir);
    if (r !== 'none') {
      log(r === 'imported' ? '[migration] imported a Continente session and credentials handed off by another add-on' : '[migration] ignored a handed-off session: this add-on already has one');
      if (r === 'imported') { restartUpstream(); lastCheck = 0; void checkSession(); }
    }
  } catch (e) { log(`[migration] hand-off failed: ${(e as Error).name}`); }
};
pollShare();
setInterval(pollShare, 5_000).unref();

const app = buildApp({
  config, version, upstreamVersion, tokens, gateway, queue, session, credentials, login, share, checkSession, log,
  onCredentialsChanged: restartUpstream, vncPort: WS_PORT,
});
await app.listen({ host: '0.0.0.0', port: config.port });
log(`[continente-mcp] MCP on :${config.port}/mcp (continentept-mcp ${upstreamVersion}, allow_checkout=${config.allowCheckout}, ${tokens.list().length} agent tokens)`);
void checkSession();

const shutdown = async () => { login.cancel(); await app.close(); await upstream.close(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
