// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Settings "back" destination.
 *
 * Phone Settings is usually opened from Account. History-back would return
 * there; native chrome should land on Home instead. Wide web/desktop keeps
 * history-back, with the projects list as the no-history fallback.
 */

export const APP_HOME_HREF = '/(app)'
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

/**
 * Way out of Chat preferences (`/c/settings`).
 *
 * Only used where the app sidebar is not on screen (phones and narrow web);
 * wide web leaves through the sidebar instead. History-back is the right
 * answer when it exists — it returns to the channels panel or chat it was
 * opened from — and a cold deep link has none, so fall back to the workspace
 * rather than the account settings page's projects list.
 */
export function leaveChatPreferences(router: SettingsBackRouter): void {
  if (router.canGoBack()) {
    router.back()
    return
  }
  router.replace(APP_HOME_HREF)
}
