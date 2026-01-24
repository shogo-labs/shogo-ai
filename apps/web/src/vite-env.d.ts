/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string
  readonly VITE_BETTER_AUTH_URL?: string
  readonly VITE_WORKSPACE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
