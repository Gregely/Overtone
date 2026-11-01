/**
 * Tiny, valid audio files with tags, generated in-memory for tests (no binary
 * fixtures in the repo).
 */

export interface FixtureTags {
  title?: string;
  artist?: string;
  albumArtist?: string;
  album?: string;
  track?: string; // "3" or "3/12"
  disc?: string;
  year?: string;
  mbRecordingId?: string;
  mbReleaseId?: string;
}

/** 8 kHz mono 8-bit PCM WAV with a LIST/INFO tag chunk. */
export function makeWav(tags: FixtureTags = {}, seconds = 1): Buffer {
  const rate = 8000;
  const data = Buffer.alloc(rate * seconds, 0x80);
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0); // PCM
  fmt.writeUInt16LE(1, 2); // mono
  fmt.writeUInt32LE(rate, 4);
  fmt.writeUInt32LE(rate, 8); // byte rate
  fmt.writeUInt16LE(1, 12); // block align
  fmt.writeUInt16LE(8, 14); // bits

  const info: Buffer[] = [Buffer.from('INFO')];
  const add = (id: string, v?: string) => {
    if (!v) return;
    let body = Buffer.from(`${v}\0`, 'utf8');
    if (body.length % 2) body = Buffer.concat([body, Buffer.alloc(1)]);
    info.push(chunk(id, body));
  };
  add('INAM', tags.title);
  add('IART', tags.artist);
  add('IPRD', tags.album);
  add('ITRK', tags.track);
  add('ICRD', tags.year);

  const body = Buffer.concat([Buffer.from('WAVE'), chunk('fmt ', fmt), chunk('data', data), chunk('LIST', Buffer.concat(info))]);
  return Buffer.concat([Buffer.from('RIFF'), u32le(body.length), body]);
}

/** MPEG-1 Layer III (128 kbps, 44.1 kHz) silence with an ID3v2.3 tag. */
export function makeMp3(tags: FixtureTags = {}, frames = 40): Buffer {
  const frameLen = 417; // 144 * 128000 / 44100
  const frame = Buffer.alloc(frameLen, 0);
  frame.writeUInt32BE(0xfffb9000, 0);
  const audio = Buffer.concat(Array.from({ length: frames }, () => frame));

  const f: Buffer[] = [];
  const text = (id: string, v?: string) => v && f.push(id3Frame(id, Buffer.concat([Buffer.from([3]), Buffer.from(v, 'utf8')])));
  const txxx = (desc: string, v?: string) =>
    v && f.push(id3Frame('TXXX', Buffer.concat([Buffer.from([3]), Buffer.from(`${desc}\0${v}`, 'utf8')])));
  text('TIT2', tags.title);
  text('TPE1', tags.artist);
  text('TPE2', tags.albumArtist);
  text('TALB', tags.album);
  text('TRCK', tags.track);
  text('TPOS', tags.disc);
  text('TYER', tags.year);
  txxx('MusicBrainz Album Id', tags.mbReleaseId);
  if (tags.mbRecordingId) {
    f.push(id3Frame('UFID', Buffer.concat([Buffer.from('http://musicbrainz.org\0', 'latin1'), Buffer.from(tags.mbRecordingId, 'latin1')])));
  }
  const frameData = Buffer.concat(f);
  const header = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, ...syncsafe(frameData.length)]);
  return Buffer.concat([header, frameData, audio]);
}

function chunk(id: string, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from(id, 'latin1'), u32le(body.length), body]);
}

function u32le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}

function id3Frame(id: string, body: Buffer): Buffer {
  const h = Buffer.alloc(10);
  h.write(id, 0, 'latin1');
  h.writeUInt32BE(body.length, 4);
  return Buffer.concat([h, body]);
}

function syncsafe(n: number): number[] {
  return [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f];
}
