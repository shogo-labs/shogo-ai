// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Deploy-time environment for the studio web image.
 *
 * The web image is built once and promoted unchanged from staging to
 * production, so per-environment values can't be inlined by Metro. The nginx
 * entrypoint (apps/mobile/docker/40-shogo-runtime-env.sh) writes them into
 * index.html as `window.__SHOGO_ENV__` at container start. Native, desktop and
 * local dev builds never get that global and fall back to the build-time
 * `EXPO_PUBLIC_*` values.
 */

export interface RuntimeEnv {
  appEnv?: string
  apiUrl?: string
  appVersion?: string
}

declare global {
  // eslint-disable-next-line no-var
  var __SHOGO_ENV__: RuntimeEnv | undefined
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function injected(): RuntimeEnv {
  const value = globalThis.__SHOGO_ENV__
  return value && typeof value === 'object' ? value : {}
}

export function getRuntimeAppEnv(): string {
  return nonEmpty(injected().appEnv) ?? nonEmpty(process.env.EXPO_PUBLIC_APP_ENV) ?? 'development'
}

export function getRuntimeApiUrl(): string | undefined {
  return nonEmpty(injected().apiUrl) ?? nonEmpty(process.env.EXPO_PUBLIC_API_URL)
}

/** The release a promoted image is serving; differs from the version baked at build time. */
export function getRuntimeAppVersion(): string | undefined {
  return nonEmpty(injected().appVersion) ?? nonEmpty(process.env.EXPO_PUBLIC_APP_VERSION)
}
