/**
 * Home Assistant integration (1.0.6): a persistent notification while the Continente session is expired, and an
 * optional `binary_sensor.continente_mcp_session` (option `session_sensor`).
 *
 * Calls go only to the Core API through the Supervisor proxy (`http://supervisor/core/api`, `homeassistant_api: true`)
 * with the add-on's SUPERVISOR_TOKEN. The token is never logged; a failed call logs only the path and the HTTP status.
 * Home Assistant may be restarting: a failed call is retried with a growing delay until the wanted state is reached.
 */
export const CORE_API = 'http://supervisor/core/api';
export const NOTIFICATION_ID = 'continente_mcp_session_expired';
export const SENSOR_ENTITY = 'binary_sensor.continente_mcp_session';

const SLUG = /^[a-z0-9]+_[a-z0-9_]+$/;

/** Relative Home Assistant paths (no host): the add-on page (ingress) and the add-on's info page. */
export function addonLinks(slug: string | null): { page: string; info: string } {
  if (!slug || !SLUG.test(slug)) return { page: '/hassio/dashboard', info: '/hassio/dashboard' };
  return { page: `/hassio/ingress/${slug}`, info: `/hassio/addon/${slug}/info` };
}

export function expiredNotification(slug: string | null): { notification_id: string; title: string; message: string } {
  const { page, info } = addonLinks(slug);
  return {
    notification_id: NOTIFICATION_ID,
    title: 'Continente: sessão terminada',
    message: `A sessão do Continente terminou. Abra a [página do Continente MCP](${page}) e inicie sessão de novo `
      + '(o Continente pode pedir para marcar "Não sou um robô"). Pesquisar produtos continua a funcionar sem sessão.\n\n'
      + `Opções do add-on: [Continente MCP](${info}). Esta notificação desaparece quando a sessão voltar a ser válida.`,
  };
}

export interface HaOptions {
  token: string;
  slug: () => string | null;
  sensor: boolean;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

const RETRY_MS = [15_000, 30_000, 60_000, 120_000, 300_000];

export class HaSessionNotifier {
  private readonly fetch: typeof fetch;
  /** What Home Assistant shows, as far as this process knows (undefined: unknown, e.g. after a restart). */
  private notified: boolean | undefined;
  private sensorState: string | undefined;
  private wanted: boolean | null = null;
  private syncing: Promise<void> | undefined;
  private again = false;
  private retry: unknown;
  private failures = 0;

  constructor(private readonly o: HaOptions) { this.fetch = o.fetchImpl ?? fetch; }

  /** The session changed: show, dismiss or leave the notification, and update the sensor. */
  update(valid: boolean | null): Promise<void> {
    this.wanted = valid;
    return this.sync();
  }

  private sync(): Promise<void> {
    if (this.syncing) { this.again = true; return this.syncing; }
    this.syncing = (async () => {
      do { this.again = false; await this.once(); } while (this.again);
    })().finally(() => { this.syncing = undefined; });
    return this.syncing;
  }

  private async once(): Promise<void> {
    if (this.retry !== undefined) { (this.o.clearTimer ?? ((t: unknown) => clearTimeout(t as NodeJS.Timeout)))(this.retry); this.retry = undefined; }
    const valid = this.wanted;
    let ok = true;
    if (valid === false && this.notified !== true) {
      if (await this.post('/services/persistent_notification/create', expiredNotification(this.o.slug()))) this.notified = true; else ok = false;
    } else if (valid === true && this.notified !== false) {
      // Also clears a notification left from before an add-on restart.
      if (await this.post('/services/persistent_notification/dismiss', { notification_id: NOTIFICATION_ID })) this.notified = false; else ok = false;
    }
    if (this.o.sensor) {
      const state = valid === null ? 'unknown' : valid ? 'on' : 'off';
      if (state !== this.sensorState) {
        const body = { state, attributes: { friendly_name: 'Sessão do Continente', device_class: 'connectivity', icon: 'mdi:cart-outline' } };
        if (await this.post(`/states/${SENSOR_ENTITY}`, body)) this.sensorState = state; else ok = false;
      }
    }
    if (ok) { this.failures = 0; return; }
    const delay = RETRY_MS[Math.min(this.failures++, RETRY_MS.length - 1)]!;
    const t = (this.o.setTimer ?? setTimeout)(() => { this.retry = undefined; void this.sync(); }, delay);
    (t as { unref?: () => void } | undefined)?.unref?.();
    this.retry = t;
  }

  private async post(path: string, body: unknown): Promise<boolean> {
    try {
      const res = await this.fetch(`${CORE_API}${path}`, {
        method: 'POST', headers: { authorization: `Bearer ${this.o.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) this.o.log?.(`[ha] POST ${path} -> ${res.status}`);
      return res.ok;
    } catch (e) {
      this.o.log?.(`[ha] POST ${path} failed: ${(e as Error).name}`);
      return false;
    }
  }
}
