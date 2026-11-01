/**
 * Capacitor (Android) configuration. The package id / app name / version
 * live in ONE place: ./app.config.json (also read by android/app/build.gradle).
 */
import type { CapacitorConfig } from '@capacitor/cli';
import app from './app.config.json' with { type: 'json' };

const config: CapacitorConfig = {
  appId: app.appId,
  appName: app.appName,
  webDir: 'dist',
  server: {
    // The app is served from http://localhost inside the WebView. This lets it
    // call a plain-HTTP Overtone server on the LAN without enabling WebView
    // "mixed content" (which Capacitor documents as development-only). Which
    // hosts may use cleartext at all is enforced by the network security
    // config (android/app/src/main/res/xml/network_security_config.xml).
    androidScheme: 'http',
  },
  android: {
    allowMixedContent: false,
  },
  plugins: {
    SystemBars: {
      // Edge-to-edge with real env(safe-area-inset-*) values (the docs' recommended mode).
      insetsHandling: 'native',
    },
  },
};

export default config;
