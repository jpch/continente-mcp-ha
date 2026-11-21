import { existsSync, readFileSync } from 'node:fs';
import { KEEPALIVE_MAX_HOURS, KEEPALIVE_MINUTES } from './keepalive.js';

export type LogLevel = 'debug' | 'info' | 'warning' | 'error';

export interface Config {
  /** Option `allow_checkout`: expose checkout/payment-like tools. Only an explicit `true` enables it. */
  allowCheckout: boolean;
  logLevel: LogLevel;
  /** Option `session_keepalive` (default off): read-only get_cart after this many idle minutes, see keepalive.ts. */
  sessionKeepalive: boolean;
  /** Option `session_keepalive_minutes`: 10-45, default 15. */
  sessionKeepaliveMinutes: number;
  /** Option `session_keepalive_max_hours`: 0-72 (0 = no limit), default 6. */
  sessionKeepaliveMaxHours: number;
  /**
   * Option `unattended_sign_in` (default on, as before 1.0.6): continentept-mcp may sign in again on its own, in a
   * hidden browser with the saved password, when the session has expired. Off: it never does; only a sign-in on
   * the add-on page signs in.
   */
  unattendedSignIn: boolean;
  /** Option `session_sensor` (default off): publish `binary_sensor.continente_mcp_session` in Home Assistant. */
  sessionSensor: boolean;
  dataDir: string;
  /** Folder shared with other add-ons (`/share/continente-mcp`): endpoint file and token requests. */
  shareDir: string | null;
  port: number;
  /** Source address of the Home Assistant ingress proxy. */
  ingressAddress: string;
  /** This add-on's Supervisor slug (e.g. `75545ee1_continente_mcp`), null outside Home Assistant. */
  addonSlug: string | null;
  hostname: string | null;
}

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warning', 'error'];
const SLUG = /^[a-z0-9]+_[a-z0-9_]+$/;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const optionsPath = env.OPTIONS_PATH ?? '/data/options.json';
  let raw: Record<string, unknown> = {};
  if (existsSync(optionsPath)) raw = JSON.parse(readFileSync(optionsPath, 'utf8')) as Record<string, unknown>;
  const hostname = env.HOSTNAME && /^[a-z0-9-]{1,63}$/.test(env.HOSTNAME) ? env.HOSTNAME : null;
  return {
    allowCheckout: raw.allow_checkout === true,
    logLevel: LOG_LEVELS.includes(raw.log_level as LogLevel) ? (raw.log_level as LogLevel) : 'info',
    sessionKeepalive: raw.session_keepalive === true,
    sessionKeepaliveMinutes: intOption(raw.session_keepalive_minutes, KEEPALIVE_MINUTES),
    sessionKeepaliveMaxHours: intOption(raw.session_keepalive_max_hours, KEEPALIVE_MAX_HOURS),
    unattendedSignIn: raw.unattended_sign_in !== false,
    sessionSensor: raw.session_sensor === true,
    dataDir: env.DATA_DIR ?? '/data',
    shareDir: env.SHARE_DIR === '' ? null : (env.SHARE_DIR ?? (existsSync('/share') ? '/share/continente-mcp' : null)),
    port: Number(env.PORT ?? 8100),
    ingressAddress: env.INGRESS_ADDRESS ?? '172.30.32.2',
    addonSlug: addonSlug(env, hostname),
    hostname,
  };
}

/** An integer option inside its range; anything else (missing, out of range, not an integer) is the default. */
export function intOption(v: unknown, r: { min: number; max: number; default: number }): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= r.min && v <= r.max ? v : r.default;
}

/** The Supervisor names an add-on container `<repo>-<slug>` with dashes; `ADDON_SLUG` overrides it. */
export function addonSlug(env: NodeJS.ProcessEnv, hostname: string | null): string | null {
  if (env.ADDON_SLUG && SLUG.test(env.ADDON_SLUG)) return env.ADDON_SLUG;
  const m = /^([a-z0-9]+)-([a-z0-9-]+)$/.exec(hostname ?? '');
  if (!m) return null;
  const slug = `${m[1]}_${m[2]!.replace(/-/g, '_')}`;
  return SLUG.test(slug) ? slug : null;
}

/**
 * Environment of the continentept-mcp server process. The sign-in (`login --show-browser`) gets the same
 * data directory, so it reads the same `credentials.env` and saves `session.json` for the same account:
 * continentept-mcp (since 0.15.0) only loads a session saved for the configured account, so a sign-in through the
 * add-on page is always one the server then uses (no sign-in loop).
 */
export const upstreamEnv = (continenteDir: string, unattendedSignIn = true): Record<string, string> => ({
  CONTINENTE_DATA_DIR: continenteDir,
  // continentept-mcp reads the email and password from credentials.env, but a variable set in the environment wins,
  // even when empty. An empty password leaves the server without credentials for a sign-in of its own
  // ("Login skipped"), while the email still selects the session saved for that account.
  ...(unattendedSignIn ? {} : { CONTINENTE_PASSWORD: '' }),
});
/**
 * The keep-alive's own short-lived continentept-mcp process: never a password (so it can never sign in, whatever
 * `unattended_sign_in` says) and no npm update check on every start.
 */
export const probeEnv = (continenteDir: string): Record<string, string> => ({
  ...upstreamEnv(continenteDir, false), CONTINENTE_UPDATE_CHECK: '0',
});
/** The sign-in on the add-on page always has the saved password: a person is watching it. */
export const loginEnv = (continenteDir: string, display: string): Record<string, string> => ({ ...upstreamEnv(continenteDir), DISPLAY: display });
export const LOGIN_ARGS = ['login', '--show-browser'];
