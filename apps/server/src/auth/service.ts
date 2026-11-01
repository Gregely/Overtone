import type { AuthTokensDto, UserDto } from '@overtone/shared';
import { deriveKey } from '../crypto/keys.js';
import { fakeVerify, hashPassword, verifyPassword } from '../crypto/password.js';
import {
  randomToken,
  sha256Hex,
  signJwt,
  signUrlToken,
  verifyJwt,
  verifyUrlToken,
  type AccessClaims,
} from '../crypto/tokens.js';
import type { Db } from '../db/index.js';
import { ApiError } from '../http/errors.js';

export const ACCESS_TTL_SEC = 15 * 60;
export const REFRESH_TTL_SEC = 30 * 24 * 60 * 60;
export const STREAM_TTL_SEC = 6 * 60 * 60;
/** A just-rotated refresh token reused within this window is treated as a client race, not theft. */
export const REFRESH_REUSE_GRACE_SEC = 20;

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  is_admin: number;
}

interface RefreshRow {
  id: number;
  user_id: number;
  family_id: string;
  device_name: string | null;
  expires_at: number;
  used_at: number | null;
  revoked_at: number | null;
}

export interface AuthOptions {
  masterKey: Buffer;
  multiUser: boolean;
  now?: () => number;
}

export class AuthService {
  readonly #db: Db;
  readonly #accessKey: Buffer;
  readonly #streamKey: Buffer;
  readonly #artworkKey: Buffer;
  readonly #now: () => number;
  readonly multiUser: boolean;

  constructor(db: Db, opts: AuthOptions) {
    this.#db = db;
    this.#accessKey = deriveKey(opts.masterKey, 'access-token');
    this.#streamKey = deriveKey(opts.masterKey, 'stream-token');
    this.#artworkKey = deriveKey(opts.masterKey, 'artwork-token');
    this.#now = opts.now ?? Date.now;
    this.multiUser = opts.multiUser;
  }

  #nowSec(): number {
    return Math.floor(this.#now() / 1000);
  }

  // ── Users ────────────────────────────────────────────────────────────────

  userCount(): number {
    return (this.#db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }

  getUser(id: number): UserDto | null {
    const row = this.#db.prepare('SELECT id, username, is_admin FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return row ? toUserDto(row) : null;
  }

  listUsers(): UserDto[] {
    return (this.#db.prepare('SELECT id, username, is_admin FROM users ORDER BY id').all() as UserRow[]).map(toUserDto);
  }

  /** First-run: create the admin. Only allowed while there are no users. */
  async setup(username: string, password: string, deviceName?: string): Promise<AuthTokensDto> {
    validateCredentials(username, password);
    const hash = await hashPassword(password);
    const created = this.#db.transaction(() => {
      if (this.userCount() > 0) return null;
      return this.#insertUser(username, hash, true);
    })();
    if (!created) throw ApiError.conflict('Setup has already been completed');
    return this.#issueTokens(created, newFamily(), deviceName);
  }

  async createUser(username: string, password: string, isAdmin: boolean): Promise<UserDto> {
    if (!this.multiUser) throw ApiError.forbidden('Multi-user mode is disabled (set OVERTONE_MULTI_USER=true)');
    validateCredentials(username, password);
    const exists = this.#db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
    if (exists) throw ApiError.conflict('Username is taken');
    const hash = await hashPassword(password);
    return this.#insertUser(username, hash, isAdmin);
  }

  deleteUser(id: number, actingUserId: number): void {
    if (id === actingUserId) throw ApiError.badRequest('You cannot delete your own account');
    const target = this.getUser(id);
    if (!target) throw ApiError.notFound('User');
    if (target.isAdmin) {
      const admins = (this.#db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').get() as { n: number }).n;
      if (admins <= 1) throw ApiError.badRequest('Cannot delete the last admin');
    }
    this.#db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }

  async changePassword(userId: number, current: string, next: string): Promise<void> {
    const row = this.#db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined;
    if (!row || !(await verifyPassword(current, row.password_hash))) {
      throw ApiError.unauthorized('invalid_credentials', 'Current password is incorrect');
    }
    validateCredentials(row.username, next);
    const hash = await hashPassword(next);
    this.#db.transaction(() => {
      this.#db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
      // Log out every other session.
      this.#db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(this.#nowSec(), userId);
    })();
  }

  #insertUser(username: string, hash: string, isAdmin: boolean): UserDto {
    const info = this.#db
      .prepare('INSERT INTO users (username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?)')
      .run(username, hash, isAdmin ? 1 : 0, this.#nowSec());
    return { id: Number(info.lastInsertRowid), username, isAdmin };
  }

  // ── Sessions ─────────────────────────────────────────────────────────────

  async login(username: string, password: string, deviceName?: string): Promise<AuthTokensDto> {
    const row = this.#db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
    const ok = row ? await verifyPassword(password, row.password_hash) : await fakeVerify(password);
    if (!row || !ok) throw ApiError.unauthorized('invalid_credentials', 'Wrong username or password');
    return this.#issueTokens(toUserDto(row), newFamily(), deviceName);
  }

  /**
   * Rotate a refresh token. Each refresh token is single-use; presenting one
   * that was already rotated (outside a short grace window) means it leaked,
   * so the whole session family is revoked.
   */
  refresh(refreshToken: string): AuthTokensDto {
    const now = this.#nowSec();
    const result = this.#db.transaction((): AuthTokensDto | ApiError => {
      const row = this.#db
        .prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?')
        .get(sha256Hex(refreshToken)) as RefreshRow | undefined;
      if (!row || row.revoked_at !== null) return ApiError.unauthorized('invalid_refresh_token', 'Session expired, please log in again');
      if (row.used_at !== null) {
        if (now - row.used_at <= REFRESH_REUSE_GRACE_SEC) {
          return ApiError.unauthorized('refresh_race', 'Refresh token was just used; use the newer token');
        }
        this.#revokeFamily(row.family_id, now);
        return ApiError.unauthorized('refresh_token_reused', 'Session revoked, please log in again');
      }
      if (row.expires_at <= now) return ApiError.unauthorized('invalid_refresh_token', 'Session expired, please log in again');
      const user = this.getUser(row.user_id);
      if (!user) return ApiError.unauthorized('invalid_refresh_token', 'Session expired, please log in again');
      this.#db.prepare('UPDATE refresh_tokens SET used_at = ? WHERE id = ?').run(now, row.id);
      return this.#issueTokens(user, row.family_id, row.device_name ?? undefined);
    })();
    if (result instanceof ApiError) throw result;
    return result;
  }

  logout(refreshToken: string): void {
    const row = this.#db
      .prepare('SELECT family_id FROM refresh_tokens WHERE token_hash = ?')
      .get(sha256Hex(refreshToken)) as { family_id: string } | undefined;
    if (row) this.#revokeFamily(row.family_id, this.#nowSec());
  }

  #revokeFamily(familyId: string, now: number): void {
    this.#db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL').run(now, familyId);
  }

  #issueTokens(user: UserDto, familyId: string, deviceName?: string): AuthTokensDto {
    const now = this.#nowSec();
    const accessExp = now + ACCESS_TTL_SEC;
    const refreshExp = now + REFRESH_TTL_SEC;
    const refreshToken = randomToken(32);
    this.#db
      .prepare(
        `INSERT INTO refresh_tokens (user_id, token_hash, family_id, device_name, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(user.id, sha256Hex(refreshToken), familyId, deviceName?.slice(0, 100) ?? null, now, refreshExp);
    // Opportunistic cleanup of long-dead tokens.
    this.#db.prepare('DELETE FROM refresh_tokens WHERE expires_at < ?').run(now - 7 * 24 * 3600);
    return {
      accessToken: signJwt({ sub: user.id, adm: user.isAdmin, iat: now, exp: accessExp }, this.#accessKey),
      accessTokenExpiresAt: new Date(accessExp * 1000).toISOString(),
      refreshToken,
      refreshTokenExpiresAt: new Date(refreshExp * 1000).toISOString(),
      user,
    };
  }

  verifyAccessToken(token: string): AccessClaims | null {
    return verifyJwt(token, this.#accessKey, this.#nowSec());
  }

  // ── URL tokens ───────────────────────────────────────────────────────────

  /** Token for /api/stream/:sourceFileId, scoped to one file and one user. */
  signStreamToken(userId: number, sourceFileId: number): { token: string; expiresAt: Date } {
    const exp = this.#nowSec() + STREAM_TTL_SEC;
    return { token: signUrlToken([userId, sourceFileId, exp], this.#streamKey), expiresAt: new Date(exp * 1000) };
  }

  verifyStreamToken(token: string, sourceFileId: number): { userId: number } | null {
    const f = verifyUrlToken(token, this.#streamKey, 3);
    if (!f) return null;
    const [uid, sfid, exp] = f.map(Number) as [number, number, number];
    if (sfid !== sourceFileId || exp <= this.#nowSec() || !this.getUser(uid)) return null;
    return { userId: uid };
  }

  /**
   * Token for artwork URLs. Expiry is aligned to a day boundary so cover URLs
   * stay byte-identical (and cacheable) for a day; valid for 1–2 days.
   */
  signArtworkToken(userId: number): string {
    const day = 24 * 3600;
    const exp = (Math.floor(this.#nowSec() / day) + 2) * day;
    return signUrlToken([userId, exp], this.#artworkKey);
  }

  verifyArtworkToken(token: string): { userId: number } | null {
    const f = verifyUrlToken(token, this.#artworkKey, 2);
    if (!f) return null;
    const [uid, exp] = f.map(Number) as [number, number];
    if (exp <= this.#nowSec() || !this.getUser(uid)) return null;
    return { userId: uid };
  }
}

function toUserDto(row: Pick<UserRow, 'id' | 'username' | 'is_admin'>): UserDto {
  return { id: row.id, username: row.username, isAdmin: row.is_admin === 1 };
}

function newFamily(): string {
  return randomToken(12);
}

function validateCredentials(username: string, password: string): void {
  const fields: Record<string, string> = {};
  if (!/^[\p{L}\p{N}._-]{1,64}$/u.test(username)) fields.username = 'Use 1–64 letters, numbers, dots, dashes or underscores';
  if (password.length < 8) fields.password = 'Use at least 8 characters';
  if (password.length > 1024) fields.password = 'Too long';
  if (Object.keys(fields).length) throw ApiError.validation(fields);
}
