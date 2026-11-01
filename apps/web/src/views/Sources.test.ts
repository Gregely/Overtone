import type { ConfigField } from '@overtone/shared';
import { describe, expect, it } from 'vitest';
import { buildConfig } from './Sources';

const fields: ConfigField[] = [
  { key: 'url', type: 'url', label: 'URL' },
  { key: 'apiKey', type: 'secret', label: 'API key' },
  { key: 'token', type: 'secret', label: 'Token' },
  { key: 'max', type: 'number', label: 'Max' },
  { key: 'on', type: 'boolean', label: 'On' },
  { key: 'refresh', type: 'secret', label: 'Refresh', hidden: true },
];

describe('buildConfig (source form)', () => {
  it('omits untouched secrets (keep), sends new ones, and null for removal', () => {
    expect(buildConfig(fields, { url: 'https://x', max: '5', on: true }, { apiKey: 'new-key' }, { token: true })).toEqual({
      url: 'https://x',
      apiKey: 'new-key',
      token: null,
      max: 5,
      on: true,
    });
  });

  it('never sends hidden fields', () => {
    expect(buildConfig(fields, {}, { refresh: 'x' }, {})).not.toHaveProperty('refresh');
  });
});
