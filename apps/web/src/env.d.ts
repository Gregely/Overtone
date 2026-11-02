/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Registered Premiumize OAuth client id (enables "Log in with Premiumize" in standalone builds). */
  readonly VITE_PREMIUMIZE_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
