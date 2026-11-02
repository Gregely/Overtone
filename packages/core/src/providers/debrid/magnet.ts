/**
 * Magnet-link helpers shared by debrid adapters (cache checks need an info
 * hash or a magnet URI depending on the service).
 */

/** Extract the lowercase hex info hash from a magnet URI, or null. */
export function magnetInfoHash(magnet: string): string | null {
  const m = /(?:xt=)?urn:btih:([a-fA-F0-9]{40})/.exec(magnet);
  return m ? m[1]!.toLowerCase() : null;
}

/** Build a magnet URI from an info hash (when the indexer only provided the hash). */
export function infoHashToMagnet(infoHash: string): string {
  return `magnet:?xt=urn:btih:${infoHash.toLowerCase()}`;
}

/** Normalize a ref to a single magnet URI, preferring the explicit magnet then the hash. */
export function refToMagnet(ref: { magnet?: string; infoHash?: string }): string | null {
  if (ref.magnet) return ref.magnet;
  if (ref.infoHash) return infoHashToMagnet(ref.infoHash);
  return null;
}

/** Normalize a ref to a lowercase info hash, or null. */
export function refToInfoHash(ref: { magnet?: string; infoHash?: string }): string | null {
  if (ref.infoHash) return ref.infoHash.toLowerCase();
  if (ref.magnet) return magnetInfoHash(ref.magnet);
  return null;
}

/** True for a well-formed BitTorrent magnet URI. */
export function isMagnetUri(s: string): boolean {
  return /^magnet:\?xt=urn:btih:[a-fA-F0-9]{40}(?:&|$)/i.test(s.trim());
}
