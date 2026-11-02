import { describe, expect, it } from 'vitest';
import { anchors, parseNumber, parseSize, stripTags } from './html.js';
import { validateCatalog } from './catalog.js';
import { parseMagnetList } from './magnet-list.js';

describe('html helpers', () => {
  it('strips tags and decodes entities', () => {
    expect(stripTags('<b>Hello &amp; <i>world</i></b>')).toBe('Hello & world');
  });

  it('extracts anchor hrefs and text', () => {
    const a = anchors('<a href="magnet:?xt=urn:btih:abc">Title</a> <a href="/page">Other</a>');
    expect(a).toEqual([
      { href: 'magnet:?xt=urn:btih:abc', text: 'Title' },
      { href: '/page', text: 'Other' },
    ]);
  });

  it('parses sizes and counts', () => {
    expect(parseSize('1.2 GB')).toBe(Math.round(1.2 * 1024 ** 3));
    expect(parseSize('350 MB')).toBe(350 * 1024 ** 2);
    expect(parseSize(undefined)).toBeNull();
    expect(parseNumber('1,234')).toBe(1234);
    expect(parseNumber('n/a')).toBeNull();
  });
});

describe('validateCatalog', () => {
  it('accepts a valid catalogue and drops malformed entries', () => {
    const cat = validateCatalog({
      format: 'overtone-scrapers',
      version: 2,
      scrapers: [
        { id: 'a', version: '1.0.0', enabled: true },
        { id: 'b', version: '2.0.0', enabled: false, minVersion: '0.5.0' },
        { bogus: true },
        42,
      ],
    });
    expect(cat?.scrapers).toEqual([
      { id: 'a', version: '1.0.0', enabled: true },
      { id: 'b', version: '2.0.0', enabled: false, minVersion: '0.5.0' },
    ]);
  });

  it('rejects the wrong format or shape', () => {
    expect(validateCatalog({ format: 'other' })).toBeNull();
    expect(validateCatalog(null)).toBeNull();
    expect(validateCatalog({ format: 'overtone-scrapers', version: 1, scrapers: 'nope' })).toBeNull();
  });
});

describe('parseMagnetList (reference scraper parser)', () => {
  it('extracts magnet hits with title, size and seeders', () => {
    const html = `
      <table>
        <tr><td><a href="magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA">Artist - Album (2020) FLAC</a></td><td>1.2 GB</td><td>seed 42</td><td>leech 3</td></tr>
        <tr><td><a href="magnet:?xt=urn:btih:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB">Other</a></td><td>350 MB</td><td>seed 0</td><td>leech 1</td></tr>
      </table>`;
    const hits = parseMagnetList(html);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({
      title: 'Artist - Album (2020) FLAC',
      infoHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      size: Math.round(1.2 * 1024 ** 3),
      seeders: 42,
      leechers: 3,
    });
    expect(hits[1]!.infoHash).toBe('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  });

  it('ignores rows without a magnet link', () => {
    expect(parseMagnetList('<tr><td><a href="/detail">no magnet</a></td></tr>')).toEqual([]);
  });
});
