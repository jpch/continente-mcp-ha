import { EventEmitter } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { isCartChange } from './policy.js';

export interface Upstream {
  listTools(): Promise<Tool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

export interface StdioOptions { command: string; args?: string[]; env?: Record<string, string>; maxRestarts?: number }

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

  constructor(private readonly options: StdioOptions) {}

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const transport = new StdioClientTransport({
        command: this.options.command, args: this.options.args ?? [],
        env: { ...(process.env as Record<string, string>), ...this.options.env }, stderr: 'inherit',
      });
      const client = new Client({ name: 'continente-mcp-ha', version: '1.0.0' });
      transport.onclose = () => { if (this.client === client) this.client = undefined; };
      await client.connect(transport);
      this.client = client;
      return client;
    })().finally(() => { this.connecting = undefined; });
    return this.connecting;
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

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const max = this.options.maxRestarts ?? 3;
    for (;;) {
      try {
        const client = await this.connect();
        const res = (await client.callTool({ name, arguments: args })) as CallToolResult;
        this.failures = 0;
        return res;
      } catch (error) {
        this.client = undefined;
        if (++this.failures > max || isCartChange(name)) throw error;
      }
    }
  }

  async close(): Promise<void> { const c = this.client; this.client = undefined; await c?.close().catch(() => undefined); }
}

/** Tracks the Continente session from every result. Emits `session` (boolean) on changes. */
export class SessionTracker extends EventEmitter {
  valid: boolean | null = null;
  checkedAt: string | null = null;
  observe(r: CallToolResult): void {
    const res = resultOf(r);
    const next = res?.error?.code === 'not_authenticated' ? false : res?.status && res.status !== 'error' ? true : this.valid;
    this.checkedAt = new Date().toISOString();
    if (next !== this.valid) { this.valid = next; this.emit('session', next); }
  }
  reset(): void { this.valid = null; this.emit('session', null); }
}
