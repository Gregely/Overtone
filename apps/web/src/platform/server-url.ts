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

/** Private / local-network host (RFC 1918, loopback, CGNAT/Tailscale, link-local, local names). */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || /^fe80:/.test(h) || /^f[cd][0-9a-f]{2}:/.test(h)) return true;
  if (/^(localhost|[^.]+)$/.test(h) && !/^\d+$/.test(h)) return true; // single-label names ("pi")
  if (/\.(local|lan|home|internal|home\.arpa|ts\.net)$/.test(h)) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
}

/**
 * The Android app only allows unencrypted HTTP to local-network servers (the
 * network security config enforces the same at the OS level). Returns a
 * user-facing message when the URL isn't allowed, else null.
 */
export function cleartextProblem(url: string): string | null {
  const u = new URL(url);
  if (u.protocol !== 'http:' || isPrivateHost(u.hostname)) return null;
  return `Unencrypted http:// is only allowed to local-network addresses. Use https:// for ${u.hostname} (for example via Tailscale or a reverse proxy).`;
}
