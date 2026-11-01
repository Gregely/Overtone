import { describe, expect, it } from 'vitest';
import { normalizeServerUrl } from './server-url';

describe('normalizeServerUrl', () => {
  it.each([
    ['192.168.1.5:4800', 'http://192.168.1.5:4800'],
    ['localhost:4800', 'http://localhost:4800'],
    ['raspberrypi.local:4800/', 'http://raspberrypi.local:4800'],
    ['music.example.com', 'https://music.example.com'],
    ['https://music.example.com/overtone/', 'https://music.example.com/overtone'],
    ['https://music.example.com/api', 'https://music.example.com'],
    ['  http://pi:4800  ', 'http://pi:4800'],
    ['pi.tailnet-abc.ts.net', 'https://pi.tailnet-abc.ts.net'],
    ['', null],
    ['ftp://x', null],
  ])('%j → %j', (input, expected) => expect(normalizeServerUrl(input)).toBe(expected));
});
