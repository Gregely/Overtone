/**
 * Audio file helpers shared by the server (scanner, providers) and clients.
 * Providers MUST only surface files for which {@link isAudioFile} is true.
 */

export const AUDIO_MIME_TYPES: Readonly<Record<string, string>> = {
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  m4b: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  alac: 'audio/mp4',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg; codecs=opus',
  wav: 'audio/wav',
  wave: 'audio/wav',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
  ape: 'audio/x-ape',
  wv: 'audio/x-wavpack',
  wma: 'audio/x-ms-wma',
  dsf: 'audio/x-dsf',
  mka: 'audio/x-matroska',
  webm: 'audio/webm',
};

export const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set(Object.keys(AUDIO_MIME_TYPES));

/** Lower-case extension without the dot, or '' if none. Handles paths and URLs. */
export function fileExtension(name: string): string {
  const withoutQuery = name.replace(/[?#].*$/, '');
  const base = withoutQuery.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/**
 * True when the name has a known audio extension. `mp4` is accepted because
 * many stores use it for AAC audio; video detection is left to the scanner probe.
 */
export function isAudioFile(name: string): boolean {
  return AUDIO_EXTENSIONS.has(fileExtension(name));
}

export function audioMimeType(name: string): string | undefined {
  return AUDIO_MIME_TYPES[fileExtension(name)];
}
