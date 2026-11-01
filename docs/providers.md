# Writing a source provider

> Seeded in stage 1, expanded in stage 6. The authoritative reference is the
> doc-commented interface in [`apps/server/src/providers/types.ts`](../apps/server/src/providers/types.ts).

A provider is one folder under `apps/server/src/providers/<id>/` exporting a
`ProviderPlugin`, registered in `apps/server/src/providers/index.ts`.

```ts
import { isAudioFile } from '@overtone/shared';
import { ProviderError } from '../errors.js';
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
        { key: 'token', type: 'secret', label: 'Token', required: true },  // encrypted, never sent to clients
      ],
    },
  },

  create(config, ctx) {                  // no network I/O here
    const base = String(config.url);
    const auth = { Authorization: `Bearer ${config.token}` };
    return {
      async *listLibrary({ signal }) {
        const res = await ctx.fetch(`${base}/files`, { headers: auth, signal });
        if (!res.ok) throw ProviderError.fromStatus(res.status, 'list files');
        for (const f of (await res.json()) as Array<{ id: string; name: string; size: number; path: string }>) {
          if (isAudioFile(f.name)) yield f;
        }
      },
      async resolveStream(fileId) {
        // Credentials in headers → never redirect-safe; the server proxies.
        return { url: `${base}/files/${encodeURIComponent(fileId)}/raw`, headers: auth, redirectSafe: false };
      },
      async testConnection({ signal }) {
        const res = await ctx.fetch(`${base}/me`, { headers: auth, signal });
        return res.ok ? { ok: true, message: 'Connected' } : { ok: false, message: `HTTP ${res.status}` };
      },
    };
  },
};
```

## Rules

1. **Read-only.** List what exists and resolve it. No search, add, or download
   features. This is a hard project rule.
2. **Audio only.** Filter with `isAudioFile()`.
3. **Stable ids.** `SourceFile.id` must stay the same across scans.
4. **No secrets in errors or logs.** Throw `ProviderError` with a plain message.
   Never interpolate keys, tokens, or signed URLs.
5. **Use `ctx.fetch`**, not global `fetch`, so tests can mock it and logging stays
   redacted.
6. **`redirectSafe: true` only** if the URL and headers carry no credentials.
7. **Debrid services** implement the smaller `DebridAdapter` interface
   (`providers/debrid/types.ts`) and get wrapped by `createDebridPlugin()`.

## Testing

Use `createTestContext({ fetch })` from `apps/server/src/testing/provider-context.ts`
with a mocked `fetch`. See `providers/debrid/bridge.test.ts` for the pattern.
