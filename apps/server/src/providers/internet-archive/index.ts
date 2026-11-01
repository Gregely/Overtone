/**
 * Internet Archive — openly licensed audio from archive.org.
 *
 * The library is defined by the user's saved query (e.g. a collection), run
 * through the advancedsearch API and always restricted to `mediatype:audio`
 * items with a Creative Commons or public-domain license. The provider only
 * lists what that query matches; it is not a general "find and add" search.
 *
 * Files are public, so resolved URLs are redirect-safe.
 *
 * Implementation: stage 4.
 */
import { NotImplementedError } from '../errors.js';
import type { ProviderPlugin } from '../types.js';

export const internetArchivePlugin: ProviderPlugin = {
  manifest: {
    id: 'internet-archive',
    name: 'Internet Archive',
    description: 'Public-domain and Creative Commons audio from archive.org.',
    category: 'public',
    capabilities: { testConnection: true, redirectable: true },
    configSchema: {
      fields: [
        {
          key: 'query',
          type: 'string',
          label: 'Collection or query',
          required: true,
          placeholder: 'collection:netlabels',
          help: 'An archive.org collection identifier or advanced-search query. Results are always limited to CC / public-domain audio.',
        },
        {
          key: 'format',
          type: 'select',
          label: 'Preferred format',
          default: 'best',
          options: [
            { value: 'best', label: 'Best available (FLAC → Ogg → MP3)' },
            { value: 'flac', label: 'FLAC only' },
            { value: 'ogg', label: 'Ogg Vorbis' },
            { value: 'mp3', label: 'MP3 (VBR)' },
          ],
        },
        { key: 'maxItems', type: 'number', label: 'Max items', default: 200, min: 1, max: 5000, integer: true },
      ],
    },
  },
  create() {
    throw new NotImplementedError('Internet Archive provider', 4);
  },
};
