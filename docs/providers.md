# Writing a source provider

Providers live in **`packages/core`** (`@overtone/core`) and run both on the
server and inside the Android app (standalone mode). So they **must not use
Node-only APIs**: no `node:*` imports, `Buffer`, `process`, or the
filesystem. Use `Uint8Array`, WebCrypto / `crypto.ts` helpers (`md5Hex`,
`sha256Hex`, `randomId`), and do all network I/O through `ctx.fetch`. Core's
tsconfig has no Node types, so a Node API fails to compile. Platform file
access belongs outside core (server: `apps/server/src/providers/local-folder`;
Android: `apps/web/src/standalone/device-folder.ts`), passed in via
`createBuiltinPlugins({ local: [...] })`.

The authoritative reference is the doc-commented interface in
[`packages/core/src/providers/types.ts`](../packages/core/src/providers/types.ts).
The built-in providers are worked examples: start with
[`subsonic/`](../packages/core/src/providers/subsonic/index.ts) (a server with
its own auth) or
[`debrid/adapters/torbox/`](../packages/core/src/providers/debrid/adapters/torbox/index.ts)
(a debrid adapter with a device login).

A provider is one folder under `packages/core/src/providers/<id>/` that exports
a `ProviderPlugin`. Register it in `createBuiltinPlugins()` in
`packages/core/src/providers/index.ts`.

```ts
/**
 * Example service: lists audio files in the user's account.
 *
 * API docs: https://example.com/api (checked 2026-11-01)
 *  - GET /files → [{ id, name, path, size }]   Bearer auth, 401 = bad token, 429 + Retry-After
 */
import { isAudioFile } from '@overtone/shared';
import { ProviderError } from '../errors.js';
import { httpError, readJson, send } from '../http.js';
import type { ProviderPlugin } from '../types.js';

export const examplePlugin: ProviderPlugin = {
  manifest: {
    id: 'example',                       // kebab-case, persisted, never rename
    name: 'Example',
    description: 'Files from an example service.',
    category: 'server',
    capabilities: { testConnection: true, redirectable: false },
    configSchema: {
      fields: [
        { key: 'url', type: 'url', label: 'Server URL', required: true },
        { key: 'token', type: 'secret', label: 'Token', required: true },  // encrypted, write-only
      ],
    },
  },

  create(config, ctx) {                  // no network I/O here
    const base = String(config.url).replace(/\/+$/, '');
    const auth = { authorization: `Bearer ${config.token}` };
    return {
      async *listLibrary({ signal }) {
        // send(): network failures/timeouts → ProviderError('unavailable'), never a raw TypeError.
        const res = await send(ctx, `${base}/files`, { headers: auth, signal }, 'List files');
        if (res.status === 401) throw new ProviderError('auth', 'List files: token rejected (expired or invalid)');
        if (!res.ok) throw httpError(res, 'List files');   // 429 → rate_limited (with Retry-After), 5xx → unavailable
        const files = await readJson<Array<{ id: string; name: string; size: number; path: string }>>(res, 'List files');
        for (const f of files) if (isAudioFile(f.name)) yield f;
      },
      async resolveStream(fileId) {
        // Credentials in headers → never redirect-safe; the server proxies.
        return { url: `${base}/files/${encodeURIComponent(fileId)}/raw`, headers: auth, redirectSafe: false };
      },
      async testConnection({ signal }) {
        const res = await send(ctx, `${base}/me`, { headers: auth, signal }, 'Connect');
        return res.ok ? { ok: true, message: 'Connected' } : { ok: false, message: httpError(res, 'Connect').message };
      },
    };
  },
};
```

## Rules

1. **Read-only.** List what already exists and resolve it. No search, add,
   upload or download-to-account features. This is a hard project rule.
   Resolve only ids your own `listLibrary` produced, never arbitrary URLs.
2. **Documented APIs only.** Read the service's current official docs. Put
   the doc URL, the date you checked, and the endpoints you use in a comment
   at the top of the adapter.
3. **Audio only.** Filter with `isAudioFile()`.
4. **Stable ids.** `SourceFile.id` must stay the same across scans.
5. **No secrets in errors or logs.** Throw `ProviderError` with a plain
   message. Never interpolate keys, tokens or signed URLs. The context's
   logger also scrubs the source's current secret values as a last resort,
   and the fetch logger never logs query strings.
6. **Use `ctx.fetch`** (via `send()`), not the global `fetch`. It adds the
   User-Agent and timeouts, and retries 429/503 with Retry-After backoff.
   For a POST with no side effects, pass `idempotent: true` so it's retried
   too.
7. **`redirectSafe: true` only** when the URL and headers carry no
   credentials and aren't tied to the server's IP. If in doubt, proxy.
8. **Expiring links:** return `expiresAt`. `ResolveCache` reuses the link
   until shortly before then. On failure, the server calls `resolveStream`
   again with `forceRefresh`, so bypass any cache of your own.
9. **Debrid services** implement the smaller `DebridAdapter` interface
   (`providers/debrid/types.ts`) and are wrapped by `createDebridPlugin()`.
   The wrapper adds audio filtering, tag probing, proxy-only streaming, and
   the account/plan "Test connection" message.

## "Log in with …" (device / PIN login)

Any provider can offer a login button instead of (or as well as) a pasted
key. Declare both halves; the registry rejects one without the other:

```ts
configSchema: {
  fields: [
    { key: 'apiKey', type: 'secret', label: 'API key' },                  // not required: the login can fill it
    { key: 'refreshToken', type: 'secret', label: 'refresh', hidden: true },
  ],
  deviceLogin: { label: 'Log in with Example', help: 'Approve on example.com', replaces: ['apiKey', 'refreshToken'] },
},
deviceFlow: {
  async start(ctx) { /* → { handle, userCode, verificationUrl, verificationUrlComplete?, expiresAt, intervalSeconds } */ },
  async poll(handle, ctx) { /* → { status: 'pending' | 'expired' | 'denied' } | { status: 'complete', secrets: { apiKey, refreshToken } } */ },
},
```

The UI renders the button, the code and the link from the schema; the server
does the polling and stores `secrets` into the `replaces` fields. `handle`
and the secrets never reach the browser. If your tokens rotate, persist new
ones with `ctx.updateSecrets({...})`; see the Real-Debrid adapter.

## Testing

Each adapter has a test file next to it, using:

- `mockHttp()` from `packages/core/src/testing/mock-http.ts`: a route-based
  fetch double that records requests. Build fixtures from the shapes in the
  official docs, with fake ids and keys only.
- `createTestContext({ fetch, retries: true })` from
  `packages/core/src/testing/provider-context.ts`: runs through the real
  retry/backoff layer with a fake clock, so `ctx.delays` shows the backoff.

Cover success, bad key, expired key/token, 429 (one retry then success, and
persistent failure), network failure, and an empty account. See
`providers/debrid/adapters/torbox/torbox.test.ts` for a compact example.
