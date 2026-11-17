/**
 * The sign-in on the add-on page and the server must agree on the Continente account (continentept-mcp
 * 0.15.0 binds the saved session to the configured account). Runs against the real, installed package
 * (`CONTINENTEPT_MCP_DIR`, else the global npm install the CI contract job makes); never signs in and
 * never opens a browser. `REQUIRE_UPSTREAM=1` turns a missing package into a failure (CI).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { LOGIN_ARGS, loginEnv, upstreamEnv } from '../src/config.js';
import { CredentialsStore } from '../src/credentials.js';
import contract from '../contract/upstream-tools.json' with { type: 'json' };

const globalRoot = () => { try { return execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(); } catch { return ''; } };
const pkgDir = process.env.CONTINENTEPT_MCP_DIR || join(globalRoot(), 'continentept-mcp');
const present = existsSync(join(pkgDir, 'dist', 'stores', 'files.js'));
if (process.env.REQUIRE_UPSTREAM === '1' && !present) throw new Error(`continentept-mcp not found in ${pkgDir}`);

interface Settings { email: string; cookieFile: string; credentialsFile: string }
type Store = { save(c: unknown[]): Promise<void>; load(): Promise<{ ok: boolean; error?: { code: string } }> };
const COOKIE = { name: 'sid', value: 'x', domain: '.continente.pt', path: '/', expires: 2e9, httpOnly: true, secure: true, sameSite: 'Lax' };

type Files = { accountKey(email: string): string | null; FileCookieStore: new (file: string, account: string | null) => Store };

describe.skipIf(!present)('sign-in through the add-on page with the pinned continentept-mcp (account-bound session)', () => {
  let version = '';
  let loadSettings: (env: Record<string, string>) => Settings;
  let files: Files;
  beforeAll(async () => {
    version = (JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { version: string }).version;
    ({ loadSettings } = await import(pathToFileURL(join(pkgDir, 'dist', 'config.js')).href) as { loadSettings(env: Record<string, string>): Settings });
    files = await import(pathToFileURL(join(pkgDir, 'dist', 'stores', 'files.js')).href) as Files;
  });
  /** What a process started by the add-on resolves: no Continente variables in the add-on's own environment. */
  const resolve = (env: Record<string, string>) => loadSettings({ PATH: process.env.PATH ?? '', HOME: tmpdir(), ...env });
  const storeFor = (s: Settings) => new files.FileCookieStore(s.cookieFile, files.accountKey(s.email));
  const setupDir = () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cmcp-bind-'));
    const continente = join(dataDir, 'continente');
    new CredentialsStore(dataDir).save('someone@example.com', 'p@ss word');
    return { dataDir, continente };
  };

  it('is the pinned version', () => { expect(version).toBe(contract.version); });

  it('the login and the server read the same credentials.env and session.json', () => {
    const { continente } = setupDir();
    const login = resolve(loginEnv(continente, ':99'));
    const server = resolve(upstreamEnv(continente));
    expect(login.credentialsFile).toBe(join(continente, 'credentials.env'));
    expect(server).toMatchObject({ credentialsFile: login.credentialsFile, cookieFile: login.cookieFile, email: 'someone@example.com' });
    expect(LOGIN_ARGS).toEqual(['login', '--show-browser']);
  });

  it('a session saved by the add-on page sign-in is used by the server (no sign-in loop)', async () => {
    const { continente } = setupDir();
    await storeFor(resolve(loginEnv(continente, ':99'))).save([COOKIE]);
    const saved = readFileSync(join(continente, 'session.json'), 'utf8');
    expect(saved).not.toContain('someone@example.com');
    expect(await storeFor(resolve(upstreamEnv(continente))).load()).toMatchObject({ ok: true });
  });

  it('a session saved before 0.15 is not used once: one sign-in on the add-on page replaces it', async () => {
    const { continente } = setupDir();
    writeFileSync(join(continente, 'session.json'), JSON.stringify([COOKIE]));
    const server = storeFor(resolve(upstreamEnv(continente)));
    expect(await server.load()).toMatchObject({ ok: false, error: { code: 'not_authenticated' } });
    await storeFor(resolve(loginEnv(continente, ':99'))).save([COOKIE]);
    expect(await server.load()).toMatchObject({ ok: true });
  });

  it('after the saved account changes, the old session is not used for the new account', async () => {
    const { dataDir, continente } = setupDir();
    await storeFor(resolve(loginEnv(continente, ':99'))).save([COOKIE]);
    new CredentialsStore(dataDir).save('other@example.com', 'secret');
    expect(await storeFor(resolve(upstreamEnv(continente))).load()).toMatchObject({ ok: false, error: { code: 'not_authenticated' } });
  });
});
