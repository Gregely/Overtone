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
  // Never log bridge traffic. With logging on (the default for debug builds)
  // Capacitor prints every plugin call's options and result to the console,
  // which ends up in logcat: that would include request URLs, auth headers,
  // device-login tokens and Keystore-stored values.
  loggingBehavior: 'none',
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
    // Standalone mode calls CapacitorHttp.request() directly for provider
    // traffic (no CORS). The global fetch/XHR patch stays off.
    CapacitorHttp: { enabled: false },
    CapacitorSQLite: {
      // The library database isn't encrypted: secrets never go into it (they
      // live in Keystore-backed storage). No biometric gate.
      androidIsEncryption: false,
      androidBiometric: { biometricAuth: false },
    },
    SystemBars: {
      // Edge-to-edge with real env(safe-area-inset-*) values (the docs' recommended mode).
      insetsHandling: 'native',
    },
  },
};

export default config;
