import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from './app.js';
import { LOGIN_ARGS, loadConfig, loginEnv, probeEnv, takeSupervisorToken, upstreamEnv } from './config.js';
import { CredentialsStore } from './credentials.js';
import { Gateway } from './gateway.js';
import { HaSessionNotifier } from './ha.js';
import { SessionKeepAlive } from './keepalive.js';
import { LoginService } from './login.js';
import { mainProcess, probeSession, separateProcess } from './probe.js';
import { ToolPolicy } from './policy.js';
import { SerialQueue } from './queue.js';
import { ShareDir } from './share.js';
import { TokenStore } from './tokens.js';
import { SIGNED_IN_TOOLS, SessionTracker, StdioUpstream } from './upstream.js';

// First of all: the Supervisor token is read once and removed from the environment, so no child process
// (continentept-mcp, the keep-alive check, the sign-in, Xvnc, websockify, Chromium) can inherit it. Children get an
// allowlisted environment anyway (childEnv in config.ts).
const supervisorToken = takeSupervisorToken();
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
const upstream = new StdioUpstream({ command: mcpCommand, env: upstreamEnv(continenteDir, config.unattendedSignIn) });
const queue = new SerialQueue(50);
const session = new SessionTracker();
const policy = new ToolPolicy((contract.tools ?? []).map(t => t.name), () => config.allowCheckout);
const credentials = new CredentialsStore(config.dataDir);
// Defined below; agent calls reach it only after the server listens.
let keepAlive: SessionKeepAlive | undefined;
const gateway = new Gateway({
  upstream, policy, queue, session, auditLog: log, version,
  // Only results of requests that surely reach Continente with the session restart the keep-alive wait.
  onUpstreamCall: tool => { if (SIGNED_IN_TOOLS.has(tool)) keepAlive?.touch(); }, credentialsSaved: () => credentials.status().configured,
});
const tokens = new TokenStore(join(config.dataDir, 'tokens.json'));
const share = config.shareDir ? new ShareDir(config.shareDir) : undefined;

// On-demand sign-in: visible browser on a virtual display, viewed through noVNC on the ingress page.
const VNC_PORT = 5999;
const WS_PORT = 6080;
const login = new LoginService({
  display: { command: 'Xvnc', args: [':99', '-geometry', '1280x860', '-depth', '24', '-SecurityTypes', 'None', '-localhost', 'yes', '-rfbport', String(VNC_PORT), '-AlwaysShared'] },
  websockify: { command: 'websockify', args: ['--web', '/usr/share/novnc', `127.0.0.1:${WS_PORT}`, `127.0.0.1:${VNC_PORT}`] },
  login: { command: mcpCommand, args: LOGIN_ARGS },
  env: loginEnv(continenteDir, ':99'),
});

// A new session or new credentials are only read by a fresh upstream process.
const restartUpstream = () => { void upstream.close(); };
let lastCheck = 0;
let inFlight: Promise<boolean | null> | undefined;
const checkSession = (): Promise<boolean | null> => {
  if (inFlight) return inFlight;
  if (Date.now() - lastCheck < 60_000) return Promise.resolve(session.valid);
  inFlight = queue.run(async () => {
    session.observe(await upstream.callTool('get_cart', {}), 'get_cart');
    keepAlive?.touch();
    return session.valid;
  }, 'normal')
    .catch(() => session.valid)
    .finally(() => { lastCheck = Date.now(); inFlight = undefined; });
  return inFlight;
};
login.on('success', () => { restartUpstream(); lastCheck = 0; void checkSession(); });
login.on('failed', () => log('[login] sign-in did not complete'));

// Session keep-alive (option session_keepalive, off by default): read-only, background lane, never signs in.
/** session.json is written only by a sign-in (on the page or unattended), so its time is the sign-in time. */
const signedInAt = () => { try { return statSync(join(continenteDir, 'session.json')).mtimeMs; } catch { return null; } };
keepAlive = new SessionKeepAlive({
  enabled: config.sessionKeepalive,
  intervalMs: config.sessionKeepaliveMinutes * 60_000,
  maxSessionMs: config.sessionKeepaliveMaxHours * 3_600_000,
  sessionValid: () => session.valid,
  signedInAt,
  signingIn: () => login.active,
  // unattended_sign_in off: the main process has no password, so the check goes through it and refreshes exactly
  // the browser session agents use. On: a separate process without a password, so the check itself can never
  // trigger the main process's unattended sign-in.
  probe: () => queue.run(() => probeSession(
    () => config.unattendedSignIn
      ? separateProcess(new StdioUpstream({ command: mcpCommand, env: probeEnv(continenteDir), maxRestarts: 0 }))
      : mainProcess(upstream),
    r => session.observe(r, 'get_cart'),
  ), 'background'),
  log,
});

// The session-expired notification (and the optional binary_sensor) in Home Assistant.
const ha = supervisorToken ? new HaSessionNotifier({ token: supervisorToken, slug: () => config.addonSlug, sensor: config.sessionSensor, log }) : undefined;
// Home Assistant restart check (only while there is something to show again).
if (ha) setInterval(() => { void ha.watch(); }, 30_000).unref();

session.on('session', (v: boolean | null) => {
  log(`[session] valid=${v}`);
  keepAlive?.sessionChanged(v);
  void ha?.update(v);
});

// The endpoint file for other add-ons. A leftover session hand-off from Cesto before 2.0.0 is deleted unread.
const pollShare = () => {
  if (!share) return;
  try {
    share.writeEndpoint({ slug: config.addonSlug, hostname: config.hostname, port: config.port, version });
    if (share.discardLegacyHandoff()) log('[share] deleted a leftover session hand-off folder without reading it (no longer used)');
  } catch (e) { log(`[share] shared folder update failed: ${(e as Error).name}`); }
};
pollShare();
setInterval(pollShare, 5_000).unref();

const app = buildApp({
  config, version, upstreamVersion, tokens, gateway, queue, session, credentials, login, share, checkSession, log,
  onCredentialsChanged: restartUpstream, vncPort: WS_PORT, keepAlive, haNotification: () => ha?.working ?? false,
});
await app.listen({ host: '0.0.0.0', port: config.port });
log(`[continente-mcp] MCP on :${config.port}/mcp (continentept-mcp ${upstreamVersion}, allow_checkout=${config.allowCheckout}, ${tokens.list().length} agent tokens)`);
log(`[continente-mcp] session_keepalive=${config.sessionKeepalive}${config.sessionKeepalive ? ` every ${config.sessionKeepaliveMinutes} min ±20%, max ${config.sessionKeepaliveMaxHours} h, check in the ${config.unattendedSignIn ? 'separate' : 'main'} process` : ''}, unattended_sign_in=${config.unattendedSignIn}, ha_notification=${!!ha}, session_sensor=${config.sessionSensor && !!ha}`);
void checkSession();

const shutdown = async () => { keepAlive?.stop(); login.cancel(); await app.close(); await upstream.close(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
