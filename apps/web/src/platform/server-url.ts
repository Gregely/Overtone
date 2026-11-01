/** True inside the Capacitor Android/iOS shell (stage 5). */
export function isNativeApp(): boolean {
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return cap?.isNativePlatform?.() === true;
}

/**
 * The server to talk to when the user hasn't chosen one. The web build is
 * normally served by the Overtone server itself, so same-origin is right; the
 * native app's origin is https://localhost, which is never the server.
 */
export function defaultServerUrl(): string | null {
  if (isNativeApp()) return null;
  return typeof location !== 'undefined' ? location.origin : null;
}

/**
 * Accepts what people actually type ("192.168.1.5:4800", "music.example.com/",
 * "https://x/api") and returns a clean origin+path without trailing slash, or
 * null if it can't be a URL.
 */
export function normalizeServerUrl(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    const isLocal = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1|[^.]+\.local\b|[^.:/]+(:\d+)?(\/|$))/i.test(s);
    s = `${isLocal ? 'http' : 'https'}://${s}`;
  }
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const path = u.pathname.replace(/\/+$/, '').replace(/\/api$/, '');
    return `${u.protocol}//${u.host}${path}`;
  } catch {
    return null;
  }
}
