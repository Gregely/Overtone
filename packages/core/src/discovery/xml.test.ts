import { describe, expect, it } from 'vitest';
import { attr, child, childText, children, decodeEntities, parseXml } from './xml.js';

describe('parseXml', () => {
  it('parses a Torznab RSS envelope', () => {
    const root = parseXml(
      `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
        <channel>
          <title>Indexer</title>
          <item>
            <title>Artist - Album (2020) FLAC</title>
            <guid>ABC123</guid>
            <enclosure url="https://x/t.torrent" length="123456" type="application/x-bittorrent" />
            <torznab:attr name="seeders" value="42" />
            <torznab:attr name="peers" value="3" />
          </item>
        </channel>
      </rss>`,
    );

    expect(root.name).toBe('rss');
    expect(attr(root, 'version')).toBe('2.0');
    const channel = child(root, 'channel');
    expect(channel).toBeDefined();
    expect(childText(channel!, 'title')).toBe('Indexer');
    const item = child(channel!, 'item');
    expect(item).toBeDefined();
    expect(childText(item!, 'title')).toBe('Artist - Album (2020) FLAC');
    const enclosure = child(item!, 'enclosure');
    expect(attr(enclosure!, 'url')).toBe('https://x/t.torrent');
    expect(attr(enclosure!, 'length')).toBe('123456');
    // torznab:attr is matched by local name.
    const attrs = children(item!, 'attr');
    expect(attrs).toHaveLength(2);
    expect(attr(attrs[0]!, 'name')).toBe('seeders');
    expect(attr(attrs[0]!, 'value')).toBe('42');
  });

  it('handles self-closing tags and CDATA', () => {
    const root = parseXml(`<r><a/><b><![CDATA[hello & <world>]]></b></r>`);
    const a = child(root, 'a');
    expect(a!.children).toEqual([]);
    expect(childText(root, 'b')).toBe('hello & <world>');
  });

  it('rejects mismatched close tags', () => {
    expect(() => parseXml('<r><a></b></r>')).toThrow();
  });
});

describe('decodeEntities', () => {
  it('decodes named and numeric entities', () => {
    expect(decodeEntities('A &amp; B &lt; C &gt; D &quot; E &apos; F &#65; &#x42;')).toBe('A & B < C > D " E \' F A B');
  });
  it('leaves unknown entities intact', () => {
    expect(decodeEntities('&bogus;')).toBe('&bogus;');
  });
  it('leaves text without entities unchanged', () => {
    expect(decodeEntities('no entities here')).toBe('no entities here');
  });
});
