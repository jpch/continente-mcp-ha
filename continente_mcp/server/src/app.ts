import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.js';
import { CredentialsError, type CredentialsStore } from './credentials.js';
import type { Gateway } from './gateway.js';
import type { LoginService } from './login.js';
import type { SerialQueue } from './queue.js';
import type { ShareDir } from './share.js';
import { HASH, TokenError, type PublicToken, type TokenStore } from './tokens.js';
import type { SessionTracker } from './upstream.js';
import { registerWeb } from './web.js';

declare module 'fastify' { interface FastifyRequest { agent?: PublicToken } }

export interface AppDeps {
  config: Config;
  version: string;
  upstreamVersion: string;
  tokens: TokenStore;
  gateway: Gateway;
  queue: SerialQueue;
  session: SessionTracker;
  credentials: CredentialsStore;
  login?: LoginService;
  share?: ShareDir;
  /** Read-only session check (get_cart through the queue). */
  checkSession: () => Promise<boolean | null>;
  /** Credentials changed: the upstream process must start again to read them. */
  onCredentialsChanged?: () => void;
  /** Token created/revoked/approved: one log line, never the token. */
  log: (line: string) => void;
  webDir?: string;
  vncPort?: number;
}

const apiError = (code: string, key: string) => ({ error: { code, message_key: key } });

/** `Authorization: Bearer cmcp_…`, or `X-Continente-MCP-Token` when Home Assistant needs the Authorization header. */
export function presentedToken(req: FastifyRequest): string | undefined {
  const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
  if (m?.[1]?.startsWith('cmcp_')) return m[1];
  const h = req.headers['x-continente-mcp-token'];
  return typeof h === 'string' ? h.trim() : undefined;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  const { config, tokens } = deps;
  const isIngressAddress = (ip: string | undefined) => ip === config.ingressAddress || ip === `::ffff:${config.ingressAddress}`;

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0]!;
    if (path === '/health') return;
    if (path === '/mcp') {
      const agent = tokens.verify(presentedToken(req));
      if (!agent) return reply.code(401).header('www-authenticate', 'Bearer realm="continente-mcp"').send(apiError('unauthorized', 'error.unauthorized'));
      req.agent = agent;
      return;
    }
    // The page, noVNC and the admin API: Home Assistant ingress only, HA administrators only.
    if (!isIngressAddress(req.ip)) return reply.code(403).send(apiError('forbidden', 'error.ingress_only'));
    const groups = req.headers['x-remote-user-groups'];
    if (req.headers['x-remote-user-id'] && !(typeof groups === 'string' && groups.split(',').includes('system-admin')))
      return reply.code(403).send(apiError('forbidden', 'error.admin_only'));
    // Cross-site form posts cannot set a JSON content type without a CORS preflight, which is never allowed.
    if (path.startsWith('/api/admin/') && (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') && !(req.headers['content-type'] ?? '').startsWith('application/json'))
      return reply.code(415).send(apiError('invalid_request', 'error.json_required'));
  });

  app.addHook('onSend', async (_req, reply) => { reply.header('cache-control', 'no-store'); reply.header('x-content-type-options', 'nosniff'); reply.header('referrer-policy', 'no-referrer'); });

  const status = () => ({
    status: 'ok',
    version: deps.version,
    upstream: { package: 'continentept-mcp', version: deps.upstreamVersion },
    session_valid: deps.session.valid,
    session_checked_at: deps.session.checkedAt,
    signing_in: deps.login?.active ?? false,
    credentials_configured: deps.credentials.status().configured,
    allow_checkout: config.allowCheckout,
    queue_length: deps.queue.length,
    addon_slug: config.addonSlug,
  });
  app.get('/health', async () => status());

  // MCP endpoint: streamable HTTP, stateless, JSON responses.
  app.post('/mcp', async (req, reply) => {
    reply.hijack();
    await deps.gateway.handle(req.agent!, req.raw, reply.raw, req.body);
  });
  const methodNotAllowed = async (_req: FastifyRequest, reply: import('fastify').FastifyReply) => reply.code(405).header('allow', 'POST').send(apiError('method_not_allowed', 'error.method_not_allowed'));
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  const pendingRequests = () => (deps.share?.requests() ?? []).filter(r => {
    if (tokens.has(r.hash)) { deps.share?.removeRequest(r.hash); return false; }
    return true;
  }).map(({ hash, ...r }) => ({ ...r, hash }));

  const loginStatus = () => ({ state: deps.login?.state ?? 'idle', started_at: deps.login?.startedAt ?? null, available: !!deps.login });

  app.get('/api/admin/status', async () => ({
    ...status(), credentials: deps.credentials.status(), login: loginStatus(), tokens: tokens.list(), requests: pendingRequests(),
  }));

  app.post<{ Body: { name?: unknown; priority?: unknown } }>('/api/admin/tokens', async (req, reply) => {
    const { token, record } = tokens.create(req.body?.name, req.body?.priority === true);
    deps.log(`[tokens] created name="${record.name}" priority=${record.priority}`);
    return reply.code(201).send({ token, record });
  });
  app.delete<{ Params: { id: string } }>('/api/admin/tokens/:id', async (req, reply) => {
    const t = tokens.revoke(req.params.id);
    if (!t) return reply.code(404).send(apiError('not_found', 'error.not_found'));
    deps.log(`[tokens] revoked name="${t.name}"`);
    return reply.code(204).send();
  });

  app.post<{ Body: { hash?: unknown; priority?: unknown } }>('/api/admin/requests/approve', async (req, reply) => {
    const hash = req.body?.hash;
    const r = typeof hash === 'string' && HASH.test(hash) ? pendingRequests().find(x => x.hash === hash) : undefined;
    if (!r) return reply.code(404).send(apiError('not_found', 'error.not_found'));
    const priority = typeof req.body?.priority === 'boolean' ? req.body.priority : r.priority;
    const record = tokens.addHash(r.name, r.hash, priority);
    deps.share?.removeRequest(r.hash);
    deps.log(`[tokens] approved request name="${record.name}" priority=${record.priority}`);
    return reply.code(201).send({ record });
  });
  app.post<{ Body: { hash?: unknown } }>('/api/admin/requests/reject', async (req, reply) => {
    const hash = req.body?.hash;
    if (typeof hash !== 'string' || !HASH.test(hash) || !deps.share?.removeRequest(hash)) return reply.code(404).send(apiError('not_found', 'error.not_found'));
    deps.log('[tokens] rejected a token request');
    return reply.code(204).send();
  });

  app.put<{ Body: { email?: unknown; password?: unknown } }>('/api/admin/credentials', async (req, reply) => {
    deps.credentials.save(req.body?.email, req.body?.password);
    deps.onCredentialsChanged?.();
    return reply.code(204).send();
  });
  app.delete('/api/admin/credentials', async (_req, reply) => {
    if (!deps.credentials.remove()) return reply.code(404).send(apiError('not_found', 'error.credentials_missing'));
    deps.onCredentialsChanged?.();
    return reply.code(204).send();
  });

  app.get('/api/admin/login', async () => loginStatus());
  app.post('/api/admin/login', async (_req, reply) => {
    if (!deps.login) return reply.code(503).send(apiError('unavailable', 'error.login_unavailable'));
    if (!deps.credentials.status().configured) return reply.code(409).send(apiError('credentials_missing', 'error.credentials_missing'));
    deps.login.start();
    return reply.code(202).send(loginStatus());
  });
  app.delete('/api/admin/login', async (_req, reply) => { deps.login?.cancel(); return reply.code(204).send(); });
  app.post('/api/admin/session/check', async () => ({ session_valid: await deps.checkSession() }));

  registerWeb(app, {
    webDir: deps.webDir ?? fileURLToPath(new URL('../web', import.meta.url)),
    vncPort: deps.vncPort ?? 6080,
    isIngressAddress,
    vncActive: () => deps.login?.active ?? false,
  });

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof TokenError) return reply.code(error.key === 'error.name_taken' || error.key === 'error.token_exists' ? 409 : 400).send(apiError('invalid_request', error.key));
    if (error instanceof CredentialsError) return reply.code(400).send(apiError('invalid_request', error.key));
    const code = (error as { statusCode?: number }).statusCode ?? 500;
    if (code < 500) return reply.code(code).send(apiError('invalid_request', 'error.invalid_request'));
    console.error(`[http] internal error: ${(error as Error).name}`);
    return reply.code(500).send(apiError('internal', 'error.internal'));
  });
  return app;
}
