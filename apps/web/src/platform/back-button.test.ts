import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const app = vi.hoisted(() => ({
  handler: null as null | ((e: { canGoBack: boolean }) => void),
  minimizeApp: vi.fn(async () => undefined),
  exitApp: vi.fn(async () => undefined),
}));
vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async (_event: string, fn: (e: { canGoBack: boolean }) => void) => {
      app.handler = fn;
      return { remove: async () => undefined };
    }),
    minimizeApp: app.minimizeApp,
    exitApp: app.exitApp,
  },
}));

import { installBackButton } from './back-button';

describe('Android back button', () => {
  beforeEach(() => {
    (globalThis as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true };
    app.minimizeApp.mockClear();
    app.exitApp.mockClear();
  });
  afterEach(() => {
    delete (globalThis as { Capacitor?: unknown }).Capacitor;
    document.body.innerHTML = '';
  });

  it('closes an open dialog first', () => {
    installBackButton(() => false);
    document.body.innerHTML = '<dialog open></dialog>';
    const cancel = vi.fn();
    document.querySelector('dialog')!.addEventListener('cancel', cancel);
    app.handler!({ canGoBack: true });
    expect(cancel).toHaveBeenCalled();
    expect(app.exitApp).not.toHaveBeenCalled();
  });

  it('navigates back within the app', () => {
    installBackButton(() => false);
    history.pushState({}, '', '/albums/1');
    const back = vi.spyOn(history, 'back').mockImplementation(() => undefined);
    app.handler!({ canGoBack: true });
    expect(back).toHaveBeenCalled();
    back.mockRestore();
  });

  it('at the root: backgrounds the app while playing, exits otherwise', () => {
    let playing = true;
    installBackButton(() => playing);
    history.pushState({}, '', '/');
    app.handler!({ canGoBack: false });
    expect(app.minimizeApp).toHaveBeenCalled();
    playing = false;
    app.handler!({ canGoBack: false });
    expect(app.exitApp).toHaveBeenCalled();
  });

  it('does nothing on the web', () => {
    delete (globalThis as { Capacitor?: unknown }).Capacitor;
    app.handler = null;
    installBackButton(() => false);
    expect(app.handler).toBeNull();
  });
});
