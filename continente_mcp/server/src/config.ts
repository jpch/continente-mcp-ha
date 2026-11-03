import { existsSync, readFileSync } from 'node:fs';

export type LogLevel = 'debug' | 'info' | 'warning' | 'error';

export interface Config {
  /** Option `allow_checkout`: expose checkout/payment-like tools. Only an explicit `true` enables it. */
  allowCheckout: boolean;
  logLevel: LogLevel;
  dataDir: string;
  /** Folder shared with other add-ons (`/share/continente-mcp`): endpoint file, token requests, session hand-off. */
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
    dataDir: env.DATA_DIR ?? '/data',
    shareDir: env.SHARE_DIR === '' ? null : (env.SHARE_DIR ?? (existsSync('/share') ? '/share/continente-mcp' : null)),
    port: Number(env.PORT ?? 8100),
    ingressAddress: env.INGRESS_ADDRESS ?? '172.30.32.2',
    addonSlug: addonSlug(env, hostname),
    hostname,
  };
}

/** The Supervisor names an add-on container `<repo>-<slug>` with dashes; `ADDON_SLUG` overrides it. */
export function addonSlug(env: NodeJS.ProcessEnv, hostname: string | null): string | null {
  if (env.ADDON_SLUG && SLUG.test(env.ADDON_SLUG)) return env.ADDON_SLUG;
  const m = /^([a-z0-9]+)-([a-z0-9-]+)$/.exec(hostname ?? '');
  if (!m) return null;
  const slug = `${m[1]}_${m[2]!.replace(/-/g, '_')}`;
  return SLUG.test(slug) ? slug : null;
}
