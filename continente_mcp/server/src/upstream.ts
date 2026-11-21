import { EventEmitter } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { childEnv } from './config.js';
import { isCartChange } from './policy.js';

export interface CallOptions {
  /** MCP request timeout for this call (the SDK default is 60 s). */
  timeoutMs?: number;
}

export interface Upstream {
  listTools(): Promise<Tool[]>;
  callTool(name: string, args: Record<string, unknown>, options?: CallOptions): Promise<CallToolResult>;
  close(): Promise<void>;
}

export interface StdioOptions {
  command: string;
  args?: string[];
  /** Added to the allowlisted environment (`childEnv`): the child never gets the add-on's whole environment. */
  env?: Record<string, string>;
  maxRestarts?: number;
}

/** The upstream result envelope: `structuredContent.result` with a `status` and maybe an `error.code`. */
export const resultOf = (r: CallToolResult): { status?: string; error?: { code?: string } } | undefined =>
  (r.structuredContent as { result?: { status?: string; error?: { code?: string } } } | undefined)?.result;

/**
 * continentept-mcp as a supervised child process over stdio. If it exits, the next call starts a new
 * one. A cart change is never retried: it may already have reached Continente.
 */
export class StdioUpstream implements Upstream {
  private client?: Client;
  private connecting?: Promise<Client>;
  private tools?: Tool[];
  private failures = 0;
  /** Bumped by close(): a connection still opening when close() was called is closed as soon as it opens. */
  private generation = 0;

  constructor(private readonly options: StdioOptions) {}

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    const generation = this.generation;
    const connecting = (async () => {
      const transport = new StdioClientTransport({
        command: this.options.command, args: this.options.args ?? [], env: childEnv(this.options.env), stderr: 'inherit',
      });
      const client = new Client({ name: 'continente-mcp-ha', version: '1.0.0' });
      transport.onclose = () => { if (this.client === client) this.client = undefined; };
      try { await client.connect(transport); } catch (e) { await client.close().catch(() => undefined); throw e; }
      if (generation !== this.generation) {
        await client.close().catch(() => undefined);
        throw new Error('The upstream was closed while it was starting');
      }
      this.client = client;
      return client;
    })().finally(() => { if (this.connecting === connecting) this.connecting = undefined; });
    this.connecting = connecting;
    return connecting;
  }

  async listTools(): Promise<Tool[]> {
    if (this.tools) return this.tools;
    const client = await this.connect();
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do { const r = await client.listTools(cursor ? { cursor } : {}); tools.push(...r.tools); cursor = r.nextCursor; } while (cursor);
    this.tools = tools;
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>, options: CallOptions = {}): Promise<CallToolResult> {
    const max = this.options.maxRestarts ?? 3;
    for (;;) {
      try {
        const client = await this.connect();
        const res = (await client.callTool({ name, arguments: args }, undefined, options.timeoutMs ? { timeout: options.timeoutMs } : undefined)) as CallToolResult;
        this.failures = 0;
        return res;
      } catch (error) {
        this.client = undefined;
        if (++this.failures > max || isCartChange(name)) throw error;
      }
    }
  }

  async close(): Promise<void> {
    this.generation++;
    this.connecting = undefined;
    const c = this.client;
    this.client = undefined;
    await c?.close().catch(() => undefined);
  }

  /** True while a child process is connected or starting (tests). */
  get open(): boolean { return !!this.client || !!this.connecting; }
}

/**
 * Tools that always make a signed-in request to Continente: a success from one of them shows the session is valid,
 * and the request keeps it alive. Catalogue tools (search, products, labels, choose_products) also work signed out;
 * `list_favorites` and `get_order` can answer from a cache, and `get_session_status` makes no request at all, so
 * their successes say nothing about the session.
 */
export const SIGNED_IN_TOOLS: ReadonlySet<string> = new Set(['get_cart', 'preview_cart_changes', 'add_cart_item', 'set_cart_item_quantity',
  'remove_cart_item', 'clear_cart', 'list_orders', 'list_frequently_bought_products']);

/** true: signed in; false: not signed in (`not_authenticated`); null: this result says nothing about the session. */
export function sessionEvidence(r: CallToolResult, tool: string): boolean | null {
  const res = resultOf(r);
  if (res?.error?.code === 'not_authenticated') return false;
  return SIGNED_IN_TOOLS.has(tool) && res?.status !== undefined && res.status !== 'error' ? true : null;
}

/** Tracks the Continente session from every result. Emits `session` (boolean) on changes. */
export class SessionTracker extends EventEmitter {
  valid: boolean | null = null;
  checkedAt: string | null = null;
  observe(r: CallToolResult, tool: string): void {
    const next = sessionEvidence(r, tool);
    if (next === null) return;
    this.checkedAt = new Date().toISOString();
    if (next !== this.valid) { this.valid = next; this.emit('session', next); }
  }
  reset(): void { this.valid = null; this.emit('session', null); }
}
