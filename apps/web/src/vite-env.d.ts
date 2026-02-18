/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string
  readonly VITE_BETTER_AUTH_URL?: string
  readonly VITE_WORKSPACE?: string
  readonly VITE_DOCS_URL?: string
  readonly VITE_DOCS_URL?: string
  readonly VITE_HOTJAR_SITE_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
