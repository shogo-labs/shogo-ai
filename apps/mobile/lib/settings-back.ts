// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Settings "back" destination.
 *
 * Phone Settings is usually opened from Account. History-back would return
 * there; native chrome should land on Home instead. Wide web/desktop keeps
 * history-back, with the projects list as the no-history fallback.
 *
 * Home is the explicit `/(app)/home` route: the landing (`/`) is the
 * workspace agent on a fresh chat, which is not a place to drop someone
 * coming out of Settings.
 */

export const APP_HOME_HREF = '/(app)/home'
export const SETTINGS_WIDE_FALLBACK_HREF = '/(app)/projects'

export type SettingsBackRouter = {
  canGoBack: () => boolean
  back: () => void
  replace: (href: string) => void
}

export function leaveSettings(
  router: SettingsBackRouter,
  nativePhone: boolean,
): void {
  if (nativePhone) {
    router.replace(APP_HOME_HREF)
    return
  }
  if (router.canGoBack()) {
    router.back()
    return
  }
  router.replace(SETTINGS_WIDE_FALLBACK_HREF)
}
