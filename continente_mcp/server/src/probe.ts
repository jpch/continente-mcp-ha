import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { sessionEvidence, type Upstream } from './upstream.js';

/**
 * The keep-alive check: one `get_cart` (read-only) in a fresh continentept-mcp process that has no password
 * (`probeEnv`), so a failed check can never turn into a sign-in. The process is closed afterwards, also on timeout.
 * Returns true (signed in), false (`not_authenticated`) or null (no answer, error, timeout).
 */
export async function probeSession(
  makeUpstream: () => Upstream, observe: (r: CallToolResult) => void, timeoutMs = 90_000,
): Promise<boolean | null> {
  const upstream = makeUpstream();
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); timer.unref?.(); });
    const r = await Promise.race([upstream.callTool('get_cart', {}), timeout]);
    if (!r) return null;
    observe(r);
    return sessionEvidence(r, 'get_cart');
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    await upstream.close();
  }
}
