import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface AgentToken {
  id: string;
  name: string;
  /** SHA-256 (hex) of the token. The plain token is never stored. */
  hash: string;
  /** Calls with this token jump ahead of other agents in the queue (Cesto). */
  priority: boolean;
  created_at: string;
  last_used_at: string | null;
  /** `page`: created on the add-on page; `request`: approved request from another add-on. */
  source: 'page' | 'request';
}
export type PublicToken = Omit<AgentToken, 'hash'>;

export class TokenError extends Error {
  constructor(readonly key: string) { super(key); }
}

export const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');
export const TOKEN_PREFIX = 'cmcp_';
const NAME = /^[\p{L}\p{N} ._-]{1,40}$/u;
export const HASH = /^[0-9a-f]{64}$/;

export function validName(name: unknown): string {
  if (typeof name !== 'string' || !NAME.test(name.trim())) throw new TokenError('error.invalid_name');
  return name.trim();
}

/**
 * Per-agent tokens in `<dataDir>/tokens.json` (0600). Only SHA-256 hashes are stored: tokens are
 * 256-bit random values, so a plain hash is enough and a leaked file reveals no usable token.
 */
export class TokenStore {
  private tokens: AgentToken[] = [];
  private byHash = new Map<string, AgentToken>();
  private dirtyUse = false;

  constructor(private readonly file: string, private readonly now: () => Date = () => new Date()) {
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { tokens?: AgentToken[] };
      this.tokens = (raw.tokens ?? []).filter(t => t && HASH.test(t.hash) && typeof t.name === 'string');
    }
    this.index();
  }

  private index() { this.byHash = new Map(this.tokens.map(t => [t.hash, t])); }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ tokens: this.tokens }, null, 2) + '\n', { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
    this.dirtyUse = false;
  }

  list(): PublicToken[] { return this.tokens.map(({ hash: _h, ...t }) => t); }

  private assertFreeName(name: string) {
    if (this.tokens.some(t => t.name.toLowerCase() === name.toLowerCase())) throw new TokenError('error.name_taken');
  }

  /** Creates a token; the plain value is returned once and never stored. */
  create(name: unknown, priority = false): { token: string; record: PublicToken } {
    const n = validName(name);
    this.assertFreeName(n);
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const record = this.add(n, hashToken(token), priority, 'page');
    return { token, record };
  }

  /** Adds an approved request: the requester generated the token and sent only its hash. */
  addHash(name: unknown, hash: string, priority: boolean): PublicToken {
    const n = validName(name);
    if (!HASH.test(hash)) throw new TokenError('error.invalid_request');
    if (this.byHash.has(hash)) throw new TokenError('error.token_exists');
    this.assertFreeName(n);
    return this.add(n, hash, priority, 'request');
  }

  private add(name: string, hash: string, priority: boolean, source: AgentToken['source']): PublicToken {
    const t: AgentToken = { id: randomBytes(6).toString('hex'), name, hash, priority: priority === true, created_at: this.now().toISOString(), last_used_at: null, source };
    this.tokens.push(t);
    this.index();
    this.save();
    const { hash: _h, ...pub } = t;
    return pub;
  }

  revoke(id: unknown): PublicToken | undefined {
    const i = this.tokens.findIndex(t => t.id === id);
    if (i < 0) return undefined;
    const [t] = this.tokens.splice(i, 1);
    this.index();
    this.save();
    const { hash: _h, ...pub } = t!;
    return pub;
  }

  has(hash: string): boolean { return this.byHash.has(hash); }

  /** The token's agent, or undefined. last_used_at is written at most once a minute. */
  verify(token: unknown): PublicToken | undefined {
    if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX) || token.length > 100) return undefined;
    const t = this.byHash.get(hashToken(token));
    if (!t) return undefined;
    const now = this.now();
    if (!t.last_used_at || now.getTime() - Date.parse(t.last_used_at) > 60_000) { t.last_used_at = now.toISOString(); this.dirtyUse = true; }
    if (this.dirtyUse) this.save();
    const { hash: _h, ...pub } = t;
    return pub;
  }
}
