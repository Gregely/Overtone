/**
 * Real-Debrid adapter: lists audio files already in the account and resolves them
 * to direct links. Read-only; never adds content to the account.
 *
 * Implementation (+ device/PIN flow where available): stage 4.
 */
import { NotImplementedError } from '../../../errors.js';
import type { DebridAdapterDefinition } from '../../types.js';

export const realDebridAdapter: DebridAdapterDefinition = {
  id: 'real-debrid',
  name: 'Real-Debrid',
  apiKeyUrl: 'https://real-debrid.com/apitoken',
  create() {
    throw new NotImplementedError('Real-Debrid adapter', 4);
  },
};
