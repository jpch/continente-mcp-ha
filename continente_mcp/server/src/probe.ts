import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { sessionEvidence, type Upstream } from './upstream.js';

/** The whole check, process start included. The MCP request itself gets a few seconds less, so it ends first. */
export const PROBE_TIMEOUT_MS = 60_000;
export const PROBE_REQUEST_TIMEOUT_MS = 55_000;

export interface ProbeTarget {
  upstream: Upstream;
  /** Called when the check timed out or failed: close a separate process, or restart a hung main process. */
  abandon: () => Promise<void>;
  /** Called after every check: close a separate process; nothing for the main one. */
  done: () => Promise<void>;
}

/**
 * The keep-alive check: one `get_cart` (read-only). It runs either in a short-lived continentept-mcp process with
 * no password, or in the main process when that one has no password either (`unattended_sign_in` off): in both
 * cases a failed check can never turn into a sign-in. Returns true (signed in), false (`not_authenticated`) or
 * null (no answer, error, timeout). The call is never retried (`retries: 0`); on timeout or error the process is
 * closed (`abandon`), which also stops anything still running for it.
 */
export async function probeSession(
  target: () => ProbeTarget, observe: (r: CallToolResult) => void, timeoutMs = PROBE_TIMEOUT_MS,
  requestTimeoutMs = Math.min(PROBE_REQUEST_TIMEOUT_MS, timeoutMs),
): Promise<boolean | null> {
  const t = target();
  let timer: NodeJS.Timeout | undefined;
  let failed = false;
  try {
    const timeout = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); timer.unref?.(); });
    const r = await Promise.race([t.upstream.callTool('get_cart', {}, { timeoutMs: requestTimeoutMs, retries: 0 }), timeout]);
    if (!r) { failed = true; return null; }
    observe(r);
    return sessionEvidence(r, 'get_cart');
  } catch {
    failed = true;
    return null;
  } finally {
    clearTimeout(timer);
    if (failed) await t.abandon().catch(() => undefined);
    await t.done().catch(() => undefined);
  }
}

/** A separate continentept-mcp process for one check; always closed afterwards. */
export const separateProcess = (upstream: Upstream): ProbeTarget => ({ upstream, abandon: () => upstream.close(), done: () => upstream.close() });

/** The main continentept-mcp process; restarted only when the check hung or failed. */
export const mainProcess = (upstream: Upstream): ProbeTarget => ({ upstream, abandon: () => upstream.close(), done: async () => undefined });
