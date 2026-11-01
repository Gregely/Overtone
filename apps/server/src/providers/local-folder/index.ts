/**
 * LocalFolder — plays files from a directory on the server (e.g. the
 * /music volume in Docker). Watches for changes; streams via file:// URLs that
 * the streaming layer serves with HTTP Range support.
 *
 * Implementation: stage 2.
 */
import { NotImplementedError } from '../errors.js';
import type { ProviderPlugin } from '../types.js';

export type LocalFolderConfig = {
  path: string;
  watch: boolean;
  followSymlinks: boolean;
};

export const localFolderPlugin: ProviderPlugin<LocalFolderConfig> = {
  manifest: {
    id: 'local-folder',
    name: 'Local folder',
    description: 'Music files in a folder on the server.',
    category: 'local',
    capabilities: { watch: true, testConnection: true, redirectable: false },
    configSchema: {
      fields: [
        {
          key: 'path',
          type: 'path',
          label: 'Folder',
          required: true,
          default: '/music',
          help: 'Absolute path as seen by the server. In Docker this is the mounted /music volume.',
        },
        { key: 'watch', type: 'boolean', label: 'Watch for changes', default: true },
        { key: 'followSymlinks', type: 'boolean', label: 'Follow symbolic links', default: false },
      ],
    },
  },
  create() {
    throw new NotImplementedError('LocalFolder provider', 2);
  },
};
