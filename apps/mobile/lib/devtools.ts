// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Dev-only React DevTools bridge for native (iOS / Android).
 *
 * On native, the React DevTools standalone GUI is the only way to attach the
 * Profiler. We connect from the app process to the standalone DevTools server
 * (default `localhost:8097`) using `react-devtools-core`, which is already a
 * transitive dep of `react-native@0.81`.
 *
 * Web does not need this — the browser DevTools React extension hooks in
 * automatically.
 *
 * Workflow:
 *   1. `bun x react-devtools` (or run the standalone Electron app) to open
 *      the GUI on port 8097.
 *   2. `bun run dev:ios` / `dev:android`. When the app boots, this module
 *      runs and the app appears in the DevTools GUI with a working Profiler
 *      tab.
 *
 * Override the host/port via `EXPO_PUBLIC_DEVTOOLS_HOST` and
 * `EXPO_PUBLIC_DEVTOOLS_PORT` if running DevTools on another machine on the
 * LAN (e.g. when the device is real and not the simulator).
 *
 * This module is gated on `__DEV__` AND non-web AND
 * `EXPO_PUBLIC_ENABLE_DEVTOOLS=1`, so production bundles are completely
 * unaffected and dev iOS/Android builds without the env opt-in don't try to
 * dial a (probably-not-running) DevTools server on every boot.
 */
import { Platform } from 'react-native'

declare const __DEV__: boolean

const enabled =
  __DEV__ &&
  Platform.OS !== 'web' &&
  process.env.EXPO_PUBLIC_ENABLE_DEVTOOLS === '1'

if (enabled) {
  try {
    // Lazy-require so the import doesn't blow up if the package is missing
    // (e.g. on platforms where it isn't installed). `react-devtools-core` is
    // shipped as a transitive dep of `react-native@0.81` so it's always
    // resolvable in a normal install.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { connectToDevTools } = require('react-devtools-core')

    const host = process.env.EXPO_PUBLIC_DEVTOOLS_HOST ?? 'localhost'
    const portRaw = process.env.EXPO_PUBLIC_DEVTOOLS_PORT
    const port = portRaw ? Number.parseInt(portRaw, 10) : 8097

    connectToDevTools({ host, port })
    // eslint-disable-next-line no-console
    console.log(`[devtools] Attempting to connect to React DevTools at ${host}:${port}`)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[devtools] react-devtools-core unavailable:', err)
  }
}

export {}
