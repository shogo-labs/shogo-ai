// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Web app-activity source registration.
 *
 * Uses `document.visibilitychange` (tab becomes visible) and `window.focus`
 * (browser window gains focus) to notify `subscribeAppActivity` subscribers
 * in `@shogo/shared-app`. Both events fire for the same user action on most
 * browsers; `subscribeAppActivity` consumers are expected to be idempotent /
 * throttled (which `useBillingData` is — 60s minimum between fetches).
 *
 * This file is the web counterpart to `register-app-activity.native.ts`,
 * following the `.native.ts` split convention used throughout this package
 * (e.g. `app-install-heartbeat.ts` / `app-install-heartbeat.native.ts`).
 */
import { useEffect } from "react"
import { registerAppActivitySource } from "@shogo/shared-app/lib/app-activity"

/** Call once from the signed-in root layout. No-op on unmount (root never unmounts). */
export function useRegisterAppActivity(): void {
  useEffect(
    () =>
      registerAppActivitySource((cb) => {
        const onVisible = () => {
          if (typeof document !== "undefined" && document.visibilityState === "visible") cb()
        }
        const onFocus = () => cb()
        if (typeof document !== "undefined") {
          document.addEventListener("visibilitychange", onVisible)
        }
        if (typeof window !== "undefined") {
          window.addEventListener("focus", onFocus)
        }
        return () => {
          if (typeof document !== "undefined") {
            document.removeEventListener("visibilitychange", onVisible)
          }
          if (typeof window !== "undefined") {
            window.removeEventListener("focus", onFocus)
          }
        }
      }),
    [],
  )
}
