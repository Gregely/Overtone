/**
 * AllDebrid adapter: lists audio files already in the account and resolves them
 * to direct links. Read-only; never adds content to the account.
 *
 * Implementation (+ device/PIN flow where available): stage 4.
 */
import { NotImplementedError } from '../../../errors.js';
import type { DebridAdapterDefinition } from '../../types.js';

export const allDebridAdapter: DebridAdapterDefinition = {
  id: 'alldebrid',
  name: 'AllDebrid',
  apiKeyUrl: 'https://alldebrid.com/apikeys/',
  create() {
    throw new NotImplementedError('AllDebrid adapter', 4);
  },
};
