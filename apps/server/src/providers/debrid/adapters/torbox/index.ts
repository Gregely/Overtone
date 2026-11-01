/**
 * TorBox adapter: lists audio files already in the account and resolves them
 * to direct links. Read-only; never adds content to the account.
 *
 * Implementation (+ device/PIN flow where available): stage 4.
 */
import { NotImplementedError } from '../../../errors.js';
import type { DebridAdapterDefinition } from '../../types.js';

export const torBoxAdapter: DebridAdapterDefinition = {
  id: 'torbox',
  name: 'TorBox',
  apiKeyUrl: 'https://torbox.app/settings',
  create() {
    throw new NotImplementedError('TorBox adapter', 4);
  },
};
