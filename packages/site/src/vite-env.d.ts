/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Both come from packages/site/.env. */
  readonly VITE_PUBLIC_POSTHOG_KEY: string;
  readonly VITE_PUBLIC_POSTHOG_HOST: string;
}
