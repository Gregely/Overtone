/**
 * Premiumize.me adapter: lists audio files already in the account and resolves them
 * to direct links. Read-only; never adds content to the account.
 *
 * Implementation (+ device/PIN flow where available): stage 4.
 */
import { NotImplementedError } from '../../../errors.js';
import type { DebridAdapterDefinition } from '../../types.js';

export const premiumizeAdapter: DebridAdapterDefinition = {
  id: 'premiumize',
  name: 'Premiumize.me',
  apiKeyUrl: 'https://www.premiumize.me/account',
  create() {
    throw new NotImplementedError('Premiumize.me adapter', 4);
  },
};
