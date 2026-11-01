import { SystemBars, SystemBarsStyle } from '@capacitor/core';
import { isNativeApp } from './platform/server-url';

export type ThemePref = 'system' | 'light' | 'dark';
const KEY = 'overtone.theme';

export function getTheme(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function setTheme(pref: ThemePref): void {
  try {
    if (pref === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    /* ignore */
  }
  applyTheme();
}

const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

export function applyTheme(): void {
  const pref = getTheme();
  const dark = pref === 'dark' || (pref === 'system' && Boolean(media?.matches));
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#111214' : '#f7f7f5');
  // Android: status/navigation bar icons must contrast with the app background.
  if (isNativeApp()) void SystemBars.setStyle({ style: dark ? SystemBarsStyle.Dark : SystemBarsStyle.Light }).catch(() => undefined);
}

/** Follow OS theme changes while on "system". */
export function watchSystemTheme(): void {
  media?.addEventListener('change', () => {
    if (getTheme() === 'system') applyTheme();
  });
}
