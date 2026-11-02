/**
 * Save / open a small text file (library exports). Android: the system
 * "save to" / "open" pickers (Storage Access Framework). Browser: a download
 * link and a file input.
 */
import { AppStorage } from '../standalone/plugins';
import { isNativeApp } from './server-url';

export async function saveTextFile(name: string, text: string, mimeType = 'application/json'): Promise<boolean> {
  if (isNativeApp()) return (await AppStorage.saveDocument({ name, mimeType, text })).saved;
  const url = URL.createObjectURL(new Blob([text], { type: mimeType }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}

export async function openTextFile(accept = 'application/json,.json'): Promise<{ name: string; text: string } | null> {
  if (isNativeApp()) {
    const r = await AppStorage.openDocument({ mimeTypes: ['application/json', 'text/plain', 'application/octet-stream'] });
    return r.text === null ? null : { name: r.name ?? 'library.json', text: r.text };
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = async () => {
      const f = input.files?.[0];
      resolve(f ? { name: f.name, text: await f.text() } : null);
    };
    input.click();
  });
}
