import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { isCartChange, isCheckoutTool, type ToolPolicy } from './policy.js';
import { QueueFullError, type SerialQueue } from './queue.js';
import { resultOf, type SessionTracker, type Upstream } from './upstream.js';
import type { PublicToken } from './tokens.js';

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly limit: number, private readonly windowMs: number, private readonly now: () => number = Date.now) {}
  take(key: string): boolean {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter(x => t - x < this.windowMs);
    if (recent.length >= this.limit) { this.hits.set(key, recent); return false; }
    recent.push(t);
    this.hits.set(key, recent);
    return true;
  }
}

export interface GatewayOptions {
  upstream: Upstream;
  policy: ToolPolicy;
  queue: SerialQueue;
  session: SessionTracker;
  /** One line per cart change and per refused checkout-like call. Never tokens or credentials. */
  auditLog: (line: string) => void;
  version: string;
  callsPerMinute?: number;
}

const errorResult = (code: string, message: string): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: { code, message } }) }],
  structuredContent: { result: { status: 'error', error: { code, message } } },
  isError: true,
});

const safeId = (v: unknown) => (typeof v === 'string' && /^[\w-]{1,40}$/.test(v) ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '-');
const describeArgs = (args: Record<string, unknown>) => {
  const parts: string[] = [];
  if ('productId' in args) parts.push(`product=${safeId(args.productId)}`);
  if ('quantity' in args) parts.push(`quantity=${typeof args.quantity === 'number' && Number.isFinite(args.quantity) ? args.quantity : '-'}`);
  if ('cartItemId' in args) parts.push(`cart_item=${safeId(args.cartItemId)}`);
  return parts.join(' ');
};

/**
 * MCP over streamable HTTP (stateless: a fresh server per request, JSON responses). Tools are the
 * upstream tools the policy allows; every call goes through the single serial queue.
 */
export class Gateway {
  private readonly limiter: RateLimiter;
  constructor(private readonly o: GatewayOptions) { this.limiter = new RateLimiter(o.callsPerMinute ?? 120, 60_000); }

  async call(agent: PublicToken, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const who = `agent="${agent.name}"`;
    if (!this.o.policy.allows(name)) {
      if (isCheckoutTool(String(name))) this.o.auditLog(`[policy] ${who} refused tool=${safeId(name)} (allow_checkout is off)`);
      return errorResult('tool_not_available', `Tool ${String(name).slice(0, 80)} is not available`);
    }
    if (!this.limiter.take(agent.id)) return errorResult('rate_limited', 'Too many calls; wait a minute');
    const started = Date.now();
    let result: CallToolResult;
    try {
      result = await this.o.queue.run(() => this.o.upstream.callTool(name, args), agent.priority ? 'priority' : 'normal');
    } catch (e) {
      if (isCartChange(name)) this.o.auditLog(`[cart] ${who} tool=${name} ${describeArgs(args)} status=failed ms=${Date.now() - started}`);
      if (e instanceof QueueFullError) return errorResult('busy', e.message);
      return errorResult('upstream_unavailable', 'The Continente MCP did not answer');
    }
    this.o.session.observe(result);
    if (isCartChange(name)) {
      const res = resultOf(result);
      this.o.auditLog(`[cart] ${who} tool=${name} ${describeArgs(args)} status=${safeId(res?.status ?? (result.isError ? 'error' : 'unknown'))}${res?.error?.code ? ` error=${safeId(res.error.code)}` : ''} ms=${Date.now() - started}`);
    }
    return result;
  }

  async tools() {
    const all = await this.o.queue.run(() => this.o.upstream.listTools(), 'priority');
    return all.filter(t => this.o.policy.allows(t.name));
  }

  private server(agent: PublicToken): Server {
    const server = new Server({ name: 'continente-mcp-ha', version: this.o.version }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await this.tools() }));
    server.setRequestHandler(CallToolRequestSchema, async req => {
      const args = req.params.arguments && typeof req.params.arguments === 'object' ? req.params.arguments as Record<string, unknown> : {};
      return this.call(agent, req.params.name, args);
    });
    return server;
  }

  async handle(agent: PublicToken, req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    const server = this.server(agent);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }
}
