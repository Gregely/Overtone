/**
 * Subsonic / Navidrome / Airsonic / Gonic — any server speaking the Subsonic
 * REST API (v1.16.1). Lists songs via search3/getAlbumList2 paging with tags
 * included, streams via /rest/stream.
 *
 * Stream URLs carry auth params (u/t/s), so they are never redirect-safe:
 * the Overtone server always proxies them.
 *
 * Implementation: stage 4.
 */
import { NotImplementedError } from '../errors.js';
import type { ProviderPlugin } from '../types.js';

export const subsonicPlugin: ProviderPlugin = {
  manifest: {
    id: 'subsonic',
    name: 'Subsonic / Navidrome',
    description: 'A Navidrome, Airsonic, Gonic or other Subsonic-compatible server.',
    category: 'server',
    capabilities: { testConnection: true, redirectable: false },
    configSchema: {
      fields: [
        { key: 'url', type: 'url', label: 'Server URL', required: true, placeholder: 'https://navidrome.example.com' },
        { key: 'username', type: 'string', label: 'Username', required: true },
        { key: 'password', type: 'secret', label: 'Password', required: true },
        {
          key: 'legacyAuth',
          type: 'boolean',
          label: 'Use legacy password auth',
          default: false,
          help: 'Only for servers that do not support token auth (e.g. LDAP-backed). Sends the password hex-encoded.',
        },
      ],
    },
  },
  create() {
    throw new NotImplementedError('Subsonic provider', 4);
  },
};
