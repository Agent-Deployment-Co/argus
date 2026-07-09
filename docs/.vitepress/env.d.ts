// The PUBLIC_* PostHog vars Vite inlines into the docs build. Optional: absent
// in local dev and any unconfigured build, where analytics stays a no-op.
// (Declared here rather than via `vite/client` so it resolves even though the
// docs/ tree is built by Vite and lives outside the root tsconfig.)
interface ImportMetaEnv {
  readonly PUBLIC_POSTHOG_PROJECT_TOKEN?: string
  readonly PUBLIC_POSTHOG_HOST?: string
  readonly [key: string]: string | boolean | undefined
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
