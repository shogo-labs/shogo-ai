// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

// Sentry wiring for the Electron MAIN process.
//
// The renderer (Expo web build under `apps/mobile/dist`) keeps its own
// `@sentry/react-native` init in `apps/mobile/app/_layout.tsx`, which
// activates whenever `EXPO_PUBLIC_SENTRY_DSN_WEB` was set at web-build
// time. The desktop release workflows inject the desktop project's DSN
// into that `_WEB` slot (sourced from the SHOGO_DESKTOP_SENTRY_DSN
// secret), so renderer events land in the `shogo-desktop` Sentry project
// alongside the main-process events captured here.
//
// The DSN is injected at bundle time by
// `apps/desktop/scripts/bundle-main.mjs` via
// `--define __SHOGO_DESKTOP_SENTRY_DSN__="..."`. The matching `declare`
// below tells TypeScript / tsc to treat it as a build-time constant; the
// `typeof` guard lets the same source file run under plain `tsc` (which
// doesn't know about the define) or in dev where the env var is empty.
// Forks and contributors who never set the build secret get a no-op
// init — we never want to ship unknown events to a Sentry project they
// can't see.
import { app } from 'electron'
import * as Sentry from '@sentry/electron/main'

declare const __SHOGO_DESKTOP_SENTRY_DSN__: string

let initialized = false

// TEMPORARY KILL-SWITCH — main-process Sentry is disabled.
//
// v1.11.13 was the first build to ship a *real* desktop DSN (every prior
// release carried the placeholder `-`, so `isValidSentryDsn()` rejected it and
// `Sentry.init()` never actually ran). With a valid DSN the init path executed
// for the first time on `@sentry/electron@^7.13.0` and the packaged macOS app
// HUNG during top-level module evaluation — zero output to main.log/stdout,
// `app.whenReady()` never fired, the local server never started. The release
// `Boot smoke test` caught it (deterministic across re-runs) and the build was
// never published.
//
// The `import * as Sentry` above is NOT the culprit: it has loaded in every
// shipped build regardless of DSN and those booted fine. The hang is in
// `Sentry.init()` itself, so skipping it restores a bootable app while keeping
// renderer crash reporting (@sentry/react-native in the Expo web build, via
// EXPO_PUBLIC_SENTRY_DSN_WEB) and web/main source-map upload fully intact.
//
// Re-enable (set to false) once main-process init is fixed — almost certainly a
// bump off the EOL v7 line to @sentry/electron v8+, verified against a
// *packaged* build (the hang does not reproduce under `npm run dev`).
//
// `as boolean` keeps tsc from narrowing the literal and flagging the guarded
// init below as unreachable.
const MAIN_PROCESS_SENTRY_DISABLED = true as boolean

function resolveDsn(): string {
  const fromBuild =
    typeof __SHOGO_DESKTOP_SENTRY_DSN__ !== 'undefined'
      ? __SHOGO_DESKTOP_SENTRY_DSN__
      : ''
  if (fromBuild) return fromBuild
  // Local-dev opt-in: developers can run `SHOGO_DESKTOP_SENTRY_DSN=... npm run dev`
  // to verify the integration without rebuilding the bundle.
  return process.env.SHOGO_DESKTOP_SENTRY_DSN || ''
}

// Mirror of the web/mobile-side check in `apps/mobile/app/_layout.tsx`. The
// bundler `--define` step in `scripts/bundle-main.mjs` substitutes
// `__SHOGO_DESKTOP_SENTRY_DSN__` as a raw string, so a placeholder value like
// `-` would otherwise reach `Sentry.init` and trigger `Invalid Sentry Dsn` at
// renderer/main-process boot. Only forward values that match the actual DSN
// shape (`https://<publicKey>@<host>/<projectId>`).
function isValidSentryDsn(value: string): boolean {
  if (!value) return false
  try {
    const u = new URL(value)
    return (
      (u.protocol === 'https:' || u.protocol === 'http:') &&
      !!u.hostname &&
      !!u.username &&
      u.pathname !== '' &&
      u.pathname !== '/'
    )
  } catch {
    return false
  }
}

/**
 * Initialise Sentry for the Electron main process. Safe to call before
 * `app.whenReady()` — `@sentry/electron` is designed to be the first
 * thing the main entry imports, so its uncaughtException /
 * unhandledRejection / Crashpad hooks are installed before any code
 * that might throw.
 *
 * Becomes a no-op when no DSN is available (forks, contributor builds,
 * dev runs without the env var). Safe to call more than once — the
 * first call wins.
 */
export function initSentry(): void {
  if (initialized) return
  // See MAIN_PROCESS_SENTRY_DISABLED above — skips the hanging v7 init while
  // leaving renderer reporting + source-map upload untouched.
  if (MAIN_PROCESS_SENTRY_DISABLED) return
  const dsn = resolveDsn()
  if (!isValidSentryDsn(dsn)) {
    if (dsn && !app.isPackaged) {
      console.warn(
        `[sentry] Ignoring malformed desktop DSN (${JSON.stringify(dsn)}); Sentry disabled.`,
      )
    }
    return
  }

  Sentry.init({
    dsn,
    release: app.getVersion(),
    environment: app.isPackaged ? 'production' : 'development',
    // Errors only — performance traces would multiply event volume for
    // a desktop client that has no obvious latency story to surface.
    // Flip on later if we ever want to profile main-process IPC.
    tracesSampleRate: 0,
    // Don't ask Sentry to attempt to grab the user's IP — desktop is
    // single-user-per-install and the device id tag (set below) gives
    // us all the per-install grouping we need without leaking PII.
    sendDefaultPii: false,
  })
  initialized = true
}

/**
 * Tag every subsequent event with the stable per-install device id so
 * recurring crashes from the same machine collapse into a single
 * Sentry "user" without exposing hostname / email. Call this once
 * after `readConfig()` has materialised the device id (which it does
 * the first time `getDeviceInfo()` runs).
 */
export function setSentryDeviceTag(deviceId: string): void {
  if (!initialized) return
  try {
    Sentry.setTag('deviceId', deviceId)
  } catch {
    // Sentry's setTag is synchronous and shouldn't throw, but we
    // don't want a telemetry hiccup to take down the app.
  }
}
