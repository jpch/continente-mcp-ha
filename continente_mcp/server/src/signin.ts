import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Sign-in guidance for agents on Home Assistant.
 *
 * continentept-mcp's sign-in errors tell the reader to run `npx -y continentept-mcp login --show-browser`
 * or to copy `session.json` into the server's data directory. Neither works in this add-on: the only
 * way to sign in is the add-on page (noVNC). Every sign-in error is rewritten before an agent sees it:
 * the message and the text say to open the Continente MCP add-on page, and the upstream `signIn`
 * details (terminal command, environment variables, guide link) are dropped. `signIn` is optional in
 * the upstream output schema, the error code, `retryable` and any `mutation` are kept as they were, so
 * the result still matches the reviewed contract.
 */
export const HA_SIGN_IN = {
  credentials: 'Sign-in needed: no Continente account is saved in the Continente MCP add-on. Ask the user to open the '
    + 'Continente MCP add-on page in Home Assistant, save the Continente email and password there and sign in. Then try again.',
  sign_in: 'Sign-in needed: ask the user to open the Continente MCP add-on page in Home Assistant and sign in there '
    + '(Continente may ask them to tick "Não sou um robô"). Then try again.',
  public: 'Searching and product details work without signing in.',
} as const;

/** Upstream sign-in hints that must never reach an agent here. */
const UPSTREAM_HINT = /session\.json|continentept-mcp login|--show-browser|CONTINENTE_(EMAIL|PASSWORD|DATA_DIR)|claude desktop/i;

interface ErrorEnvelope {
  status: 'error';
  error: { code?: unknown; message?: unknown; [k: string]: unknown };
  mutation?: { outcome?: unknown; recovery?: { action?: unknown } };
  signIn?: { action?: unknown; credentials?: unknown };
  [k: string]: unknown;
}

const envelope = (r: CallToolResult): ErrorEnvelope | null => {
  const res = (r.structuredContent as { result?: unknown } | undefined)?.result as ErrorEnvelope | undefined;
  return res && typeof res === 'object' && res.status === 'error' && res.error && typeof res.error === 'object' ? res : null;
};

const texts = (r: CallToolResult) => (Array.isArray(r.content) ? r.content : [])
  .map(c => (c && typeof c === 'object' && (c as { type?: unknown }).type === 'text' ? String((c as { text?: unknown }).text ?? '') : '')).join('\n');

/** True when `r` is an upstream sign-in error (or any error that carries an upstream sign-in hint). */
export function isSignInError(r: CallToolResult): boolean {
  const e = envelope(r);
  if (!e) return false;
  return e.signIn !== undefined || e.error.code === 'not_authenticated'
    || UPSTREAM_HINT.test(String(e.error.message ?? '')) || UPSTREAM_HINT.test(texts(r));
}

/** The same note continentept-mcp appends after a cart tool error. */
const mutationNote = (m: ErrorEnvelope['mutation']) => {
  if (!m) return '';
  if (m.outcome === 'unknown') {
    const action = m.recovery?.action === 'get_cart' || m.recovery?.action === 'list_coupons' ? m.recovery.action : 'get_cart';
    return `\nThe cart may have changed. Call ${action} before making another change; do not repeat this request automatically.`;
  }
  return '\nThe cart was not changed.';
};

/** Rewrites an upstream sign-in error for Home Assistant; any other result is returned unchanged. */
export function haSignIn(r: CallToolResult): CallToolResult {
  if (!isSignInError(r)) return r;
  const e = envelope(r)!;
  const missing = e.signIn?.action === 'configure_credentials' || e.signIn?.credentials === 'missing';
  const message = `${missing ? HA_SIGN_IN.credentials : HA_SIGN_IN.sign_in} ${HA_SIGN_IN.public}`;
  const { signIn: _dropped, ...rest } = e;
  const result = { ...rest, error: { ...e.error, message } };
  const code = typeof e.error.code === 'string' && /^[a-z_]{1,40}$/.test(e.error.code) ? e.error.code : 'not_authenticated';
  return {
    ...r,
    isError: true,
    content: [{ type: 'text', text: `Error (${code}): ${message}${mutationNote(e.mutation)}` }],
    structuredContent: { ...(r.structuredContent as object), result },
  };
}
