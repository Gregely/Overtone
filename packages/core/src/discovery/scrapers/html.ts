/**
 * Minimal HTML extraction helpers for scrapers. Most torrent sites emit
 * non-well-formed HTML, so we use targeted regex/token helpers rather than a
 * general parser. Each scraper applies site-specific structure on top of these.
 */
import { decodeEntities } from '../xml.js';

/** Strip tags and decode entities (best-effort, for display text). */
export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Extract the href + inner text of every `<a>` tag (case-insensitive). */
export function anchors(html: string): Array<{ href: string; text: string }> {
  const out: Array<{ href: string; text: string }> = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out.push({ href: m[1]!, text: stripTags(m[2]!) });
  return out;
}

/** First capture group of the first regex match, trimmed, or undefined. */
export function extract(html: string, re: RegExp): string | undefined {
  const m = re.exec(html);
  return m?.[1]?.trim() || undefined;
}

/** Parse a "12.3 MB" / "1.2 GB" size string to bytes, or null. */
export function parseSize(text: string | undefined): number | null {
  if (!text) return null;
  const m = /([\d.,]+)\s*(B|KB|MB|GB|TB)/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]!.replace(',', '.'));
  const unit = m[2]!.toUpperCase();
  const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[unit]!;
  return Math.round(n * mult);
}

/** Parse a "1,234" seeders count string to a number, or null. */
export function parseNumber(text: string | undefined): number | null {
  if (!text) return null;
  const n = Number(String(text).replace(/[, ]/g, '').trim());
  return Number.isFinite(n) ? n : null;
}
