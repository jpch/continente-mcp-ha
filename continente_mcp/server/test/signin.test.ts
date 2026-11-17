import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { HA_SIGN_IN, haSignIn, isSignInError } from '../src/signin.js';

const upstreamError = (result: Record<string, unknown>, text: string): CallToolResult =>
  ({ isError: true, content: [{ type: 'text', text }], structuredContent: { result } });
const signIn = (action: string, credentials = 'configured') => ({
  credentials, action, signInWindow: action === 'confirm_not_a_robot' ? 'not_available' : null,
  settings: { environment: ['CONTINENTE_EMAIL', 'CONTINENTE_PASSWORD'], claudeDesktopExtension: ['email', 'password'] },
  command: 'npx -y continentept-mcp login --show-browser', guide: 'https://example.invalid/guide', publicTools: ['search_products'],
});

describe('Home Assistant sign-in guidance', () => {
  it('missing credentials: save them on the add-on page', () => {
    const r = haSignIn(upstreamError({ status: 'error', error: { code: 'not_authenticated', message: 'Sign-in required: … set CONTINENTE_EMAIL …', retryable: false }, signIn: signIn('configure_credentials', 'missing') }, 'Error (not_authenticated): Sign-in required'));
    const res = (r.structuredContent as { result: { error: { message: string } } }).result;
    expect(res.error.message).toBe(`${HA_SIGN_IN.credentials} ${HA_SIGN_IN.public}`);
    expect((r.content as { text: string }[])[0]!.text).toBe(`Error (not_authenticated): ${HA_SIGN_IN.credentials} ${HA_SIGN_IN.public}`);
  });
  it('an unknown mutation keeps its recovery note and fields', () => {
    const mutation = { outcome: 'unknown', recovery: { action: 'get_cart', automaticReplay: false } };
    const r = haSignIn(upstreamError({ status: 'error', error: { code: 'not_authenticated', message: 'run npx -y continentept-mcp login --show-browser', retryable: false }, mutation, signIn: signIn('check_credentials_or_sign_in') }, 'x'));
    const res = (r.structuredContent as { result: Record<string, unknown> }).result;
    expect(res.mutation).toEqual(mutation);
    expect((r.content as { text: string }[])[0]!.text).toContain('\nThe cart may have changed. Call get_cart before making another change');
  });
  it('an error that only mentions session.json in its text is rewritten too', () => {
    const r = upstreamError({ status: 'error', error: { code: 'upstream_error', message: 'x', retryable: true } }, 'copy session.json to the server');
    expect(isSignInError(r)).toBe(true);
    expect(JSON.stringify(haSignIn(r))).not.toContain('session.json');
    expect((haSignIn(r).structuredContent as { result: { error: { code: string; retryable: boolean } } }).result.error).toMatchObject({ code: 'upstream_error', retryable: true });
  });
  it('leaves successes and unrelated errors untouched', () => {
    const ok: CallToolResult = { content: [{ type: 'text', text: 'ok' }], structuredContent: { result: { status: 'success', data: {} } } };
    expect(haSignIn(ok)).toBe(ok);
    const other = upstreamError({ status: 'error', error: { code: 'not_found', message: 'Product not found', retryable: false } }, 'Error (not_found): Product not found');
    expect(haSignIn(other)).toBe(other);
    const raw: CallToolResult = { content: [{ type: 'text', text: 'plain' }] };
    expect(haSignIn(raw)).toBe(raw);
  });
  it('the guidance itself carries none of the upstream hints', () => {
    for (const m of Object.values(HA_SIGN_IN)) expect(m).not.toMatch(/session\.json|npx|--show-browser|CONTINENTE_/);
  });
});
