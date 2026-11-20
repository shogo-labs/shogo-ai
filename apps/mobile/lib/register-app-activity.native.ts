// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Native (iOS / Android) app-activity source registration.
 *
 * Uses `AppState` to detect when the app moves to the foreground, then
 * notifies all `subscribeAppActivity` subscribers in `@shogo/shared-app`.
 *
 * Pattern follows `apps/mobile/lib/app-install-heartbeat.native.ts`.
 */
import { useEffect } from "react"
import { AppState, AppStateStatus } from "react-native"
import { registerAppActivitySource } from "@shogo/shared-app/lib/app-activity"

/** Call once from the signed-in root layout. No-op on unmount (root never unmounts). */
export function useRegisterAppActivity(): void {
  useEffect(
    () =>
      registerAppActivitySource((cb) => {
        const sub = AppState.addEventListener("change", (state: AppStateStatus) => {
          if (state === "active") cb()
        })
        return () => sub.remove()
      }),
    [],
  )
}
