import { describe, expect, it } from 'vitest';
import { parseRange } from './range.js';

describe('parseRange', () => {
  it.each([
    [undefined, 100, undefined],
    ['bytes=0-9', 100, { start: 0, end: 9 }],
    ['bytes=90-', 100, { start: 90, end: 99 }],
    ['bytes=-10', 100, { start: 90, end: 99 }],
    ['bytes=-500', 100, { start: 0, end: 99 }],
    ['bytes=50-5000', 100, { start: 50, end: 99 }],
    ['bytes=100-', 100, null],
    ['bytes=9-3', 100, null],
    ['bytes=-0', 100, null],
    ['bytes=0-1,5-9', 100, undefined],
    ['items=0-1', 100, undefined],
    ['bytes=0-', 0, null],
  ])('%s of %d', (header, size, expected) => {
    expect(parseRange(header, size)).toEqual(expected);
  });
});
