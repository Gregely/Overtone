import { App } from '@capacitor/app';
import { isNativeApp } from './server-url';

/**
 * Android back button: close an open dialog, else go back in the app's
 * history, else leave the app. When music is playing we move the app to the
 * background instead of exiting, so playback (and the JS queue) continue.
 */
export function installBackButton(isPlaying: () => boolean): () => void {
  if (!isNativeApp()) return () => undefined;
  const handle = App.addListener('backButton', ({ canGoBack }) => {
    const dialog = document.querySelector<HTMLDialogElement>('dialog[open]');
    if (dialog) {
      dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
      return;
    }
    if (canGoBack && location.pathname !== '/') {
      history.back();
      return;
    }
    if (isPlaying()) void App.minimizeApp();
    else void App.exitApp();
  });
  return () => void handle.then((h) => h.remove());
}
