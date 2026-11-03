import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HASH } from './tokens.js';

/**
 * The folder shared with other add-ons (`/share/continente-mcp`). It never holds a usable secret for
 * long:
 *  - `endpoint.json`: how other add-ons reach this one (slug, host name, port). No secret.
 *  - `requests/<name>.json`: an add-on asks for a token. It generated the token itself and writes only
 *    its SHA-256 hash; an admin approves it on the add-on page. A fake request gives nothing unless an
 *    admin approves it, and the page shows a fingerprint the requester also shows.
 *  - `import/`: one-time hand-off of an existing Continente session and credentials (Cesto before
 *    2.0.0). Imported only when this add-on has none, then deleted at once.
 */
export interface TokenRequest { name: string; hash: string; priority: boolean; requested_at: string | null; fingerprint: string }

const REQUEST_FILE = /^[a-z0-9_-]{1,40}\.json$/;
export const fingerprint = (hash: string) => hash.slice(0, 8).toUpperCase().replace(/(.{4})/, '$1-');

export class ShareDir {
  constructor(readonly dir: string) {}

  private ensure(sub = '') {
    const p = join(this.dir, sub);
    mkdirSync(p, { recursive: true, mode: 0o700 });
    return p;
  }

  writeEndpoint(info: { slug: string | null; hostname: string | null; port: number; version: string }): void {
    this.ensure();
    writeFileSync(join(this.dir, 'endpoint.json'), JSON.stringify({ ...info, mcp_path: '/mcp' }, null, 2) + '\n', { mode: 0o644 });
  }

  requests(): TokenRequest[] {
    const dir = join(this.dir, 'requests');
    if (!existsSync(dir)) return [];
    const out: TokenRequest[] = [];
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (!REQUEST_FILE.test(f) || !lstatSync(p).isFile() || lstatSync(p).size > 4096) continue;
      try {
        const r = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
        if (typeof r.name !== 'string' || typeof r.hash !== 'string' || !HASH.test(r.hash)) continue;
        out.push({ name: r.name.slice(0, 40), hash: r.hash, priority: r.priority === true, requested_at: typeof r.requested_at === 'string' ? r.requested_at.slice(0, 40) : null, fingerprint: fingerprint(r.hash) });
      } catch { /* ignore malformed requests */ }
    }
    return out;
  }

  removeRequest(hash: string): boolean {
    const dir = join(this.dir, 'requests');
    if (!existsSync(dir)) return false;
    let removed = false;
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (!REQUEST_FILE.test(f) || !lstatSync(p).isFile()) continue;
      try { if ((JSON.parse(readFileSync(p, 'utf8')) as { hash?: string }).hash === hash) { rmSync(p); removed = true; } } catch { /* ignore */ }
    }
    return removed;
  }

  /**
   * Moves a handed-off session into `target` when `target` holds none. Only regular files and folders
   * are copied (symbolic links are skipped). The hand-off folder is always deleted.
   */
  importSession(target: string): 'none' | 'imported' | 'skipped' {
    const src = join(this.dir, 'import');
    if (!existsSync(src) || !existsSync(join(src, 'READY'))) return 'none';
    try {
      const hasOwn = existsSync(target) && readdirSync(target).some(f => !f.startsWith('.'));
      if (hasOwn) return 'skipped';
      mkdirSync(target, { recursive: true, mode: 0o700 });
      cpSync(src, target, {
        recursive: true, dereference: false, errorOnExist: false, force: true,
        filter: p => { const s = lstatSync(p); return (s.isFile() || s.isDirectory()) && !p.endsWith('/READY'); },
      });
      chmodSync(target, 0o700);
      const creds = join(target, 'credentials.env');
      if (existsSync(creds)) chmodSync(creds, 0o600);
      return 'imported';
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  }
}
