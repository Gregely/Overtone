import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/index.js';
import { ApiError } from '../http/errors.js';
import { ACCESS_TTL_SEC, AuthService, REFRESH_REUSE_GRACE_SEC, STREAM_TTL_SEC } from './service.js';

let now = Date.UTC(2026, 0, 1);
const tick = (sec: number) => (now += sec * 1000);

function make(multiUser = false) {
  return new AuthService(openDatabase(':memory:'), { masterKey: randomBytes(32), multiUser, now: () => now });
}

const code = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    return (e as ApiError).code;
  }
  return 'no error';
};

describe('AuthService', () => {
  let auth: AuthService;
  beforeEach(() => {
    now = Date.UTC(2026, 0, 1);
    auth = make();
  });

  it('allows setup exactly once and returns an admin session', async () => {
    const t = await auth.setup('greg', 'password1');
    expect(t.user).toEqual({ id: 1, username: 'greg', isAdmin: true });
    expect(auth.verifyAccessToken(t.accessToken)).toMatchObject({ sub: 1, adm: true });
    expect(await code(auth.setup('other', 'password2'))).toBe('conflict');
  });

  it('validates credentials', async () => {
    expect(await code(auth.setup('greg', 'short'))).toBe('validation_failed');
    expect(await code(auth.setup('bad name!', 'password1'))).toBe('validation_failed');
  });

  it('logs in case-insensitively and rejects wrong passwords uniformly', async () => {
    await auth.setup('Greg', 'password1');
    expect((await auth.login('greg', 'password1')).user.username).toBe('Greg');
    expect(await code(auth.login('greg', 'nope-nope'))).toBe('invalid_credentials');
    expect(await code(auth.login('nobody', 'password1'))).toBe('invalid_credentials');
  });

  it('expires access tokens', async () => {
    const t = await auth.setup('greg', 'password1');
    tick(ACCESS_TTL_SEC + 1);
    expect(auth.verifyAccessToken(t.accessToken)).toBeNull();
  });

  it('rotates refresh tokens on every use', async () => {
    const t1 = await auth.setup('greg', 'password1');
    const t2 = auth.refresh(t1.refreshToken);
    expect(t2.refreshToken).not.toBe(t1.refreshToken);
    const t3 = auth.refresh(t2.refreshToken);
    expect(auth.verifyAccessToken(t3.accessToken)).toMatchObject({ sub: 1 });
  });

  it('treats a quick double-refresh as a race, not theft', async () => {
    const t1 = await auth.setup('greg', 'password1');
    const t2 = auth.refresh(t1.refreshToken);
    tick(REFRESH_REUSE_GRACE_SEC - 1);
    expect(await code(() => auth.refresh(t1.refreshToken))).toBe('refresh_race');
    expect(auth.refresh(t2.refreshToken).refreshToken).toBeTruthy(); // session survives
  });

  it('revokes the whole session family when an old refresh token is replayed', async () => {
    const t1 = await auth.setup('greg', 'password1');
    const other = await auth.login('greg', 'password1'); // a second device
    const t2 = auth.refresh(t1.refreshToken);
    tick(REFRESH_REUSE_GRACE_SEC + 1);
    expect(await code(() => auth.refresh(t1.refreshToken))).toBe('refresh_token_reused');
    expect(await code(() => auth.refresh(t2.refreshToken))).toBe('invalid_refresh_token');
    expect(auth.refresh(other.refreshToken).user.id).toBe(1); // other device unaffected
  });

  it('logout revokes the session; password change revokes all sessions', async () => {
    const t1 = await auth.setup('greg', 'password1');
    const t2 = await auth.login('greg', 'password1');
    auth.logout(t1.refreshToken);
    expect(await code(() => auth.refresh(t1.refreshToken))).toBe('invalid_refresh_token');
    await auth.changePassword(1, 'password1', 'password2');
    expect(await code(() => auth.refresh(t2.refreshToken))).toBe('invalid_refresh_token');
    expect((await auth.login('greg', 'password2')).user.id).toBe(1);
  });

  it('refuses extra users unless multi-user is enabled', async () => {
    await auth.setup('greg', 'password1');
    expect(await code(auth.createUser('sam', 'password1', false))).toBe('forbidden');
    const multi = make(true);
    await multi.setup('greg', 'password1');
    const sam = await multi.createUser('sam', 'password1', false);
    expect(sam.isAdmin).toBe(false);
    expect(await code(multi.createUser('SAM', 'password1', false))).toBe('conflict');
    expect(await code(() => multi.deleteUser(1, 1))).toBe('bad_request');
    multi.deleteUser(sam.id, 1);
    expect(multi.listUsers()).toHaveLength(1);
  });

  it('scopes stream tokens to one file, one live user, and a lifetime', async () => {
    await auth.setup('greg', 'password1');
    const { token } = auth.signStreamToken(1, 42);
    expect(auth.verifyStreamToken(token, 42)).toEqual({ userId: 1 });
    expect(auth.verifyStreamToken(token, 43)).toBeNull();
    tick(STREAM_TTL_SEC + 1);
    expect(auth.verifyStreamToken(token, 42)).toBeNull();
  });

  it('keeps artwork tokens stable within a day and rejects deleted users', async () => {
    const multi = make(true);
    await multi.setup('greg', 'password1');
    const sam = await multi.createUser('sam', 'password1', false);
    const a = multi.signArtworkToken(sam.id);
    tick(60);
    expect(multi.signArtworkToken(sam.id)).toBe(a);
    expect(multi.verifyArtworkToken(a)).toEqual({ userId: sam.id });
    multi.deleteUser(sam.id, 1);
    expect(multi.verifyArtworkToken(a)).toBeNull();
  });
});
