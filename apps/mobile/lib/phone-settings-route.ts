// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Phone Settings deep links resolve to the Account screen.
 *
 * `/(app)/settings` is the wide/tablet page. On a handset or narrow web every
 * existing `/settings?tab=…` link redirects into `/(app)/account`, which hosts
 * the same `SettingsContent` in `NativeAccountSettingsSheet` — so the ~15 call
 * sites keep working unchanged and the legacy page chrome (AppHeader, TabBar,
 * AppSidebar drawer) is never drawn there.
 */
import { Platform } from 'react-native'
import type { AccountSettingsSheetTab } from '../components/settings/account-settings-sheets'
import { isPhoneLayout } from './native-phone-layout'
import { visibleSettingsTabs, type SettingsTabId } from './settings-tabs'
import { resolveActiveWorkspaceId } from './workspace-store'

export type PhoneSettingsParams = Record<string, string | string[] | undefined>

export type PhoneSettingsOptions = {
  /** Mirrors the `localMode` the legacy page hands to `SettingsContent`. */
  localMode?: boolean
  showBilling?: boolean
  /** `Platform.OS` — Compute purchases are hidden on iOS only. */
  platform?: string
  /** Desktop-only tabs (`updates`, `computer-files`) never reach a phone. */
  isDesktop?: boolean
}

export type PhoneSettingsTarget = {
  pathname: '/(app)/account' | '/(app)/analytics'
  params: Record<string, string>
}

/** Tabs the Account sheet must not host — desktop-only surfaces. */
const NOT_SHEET_HOSTED: readonly SettingsTabId[] = ['updates', 'computer-files']

/** True inside the Electron desktop shell (narrow window included). */
export function isDesktopShell(): boolean {
  return (
    Platform.OS === 'web' &&
    typeof window !== 'undefined' &&
    Boolean((window as any).shogoDesktop?.isDesktop)
  )
}

/** True on native handsets and web at or below the phone breakpoint. */
export function isPhoneSettingsSurface(width: number, height: number): boolean {
  return isPhoneLayout(width, height)
}

export function firstPhoneSettingsParam(
  value: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

function isLocalSettingsMode(options: PhoneSettingsOptions): boolean {
  return Boolean(options.localMode) || options.showBilling === false
}

/**
 * Settings tabs the Account sheet can render right now. Everything comes from
 * the same `visibleSettingsTabs` the legacy page uses, minus desktop-only tabs
 * and minus Compute outside its purchase surface (cloud only).
 */
function availableSheetTabs(options: PhoneSettingsOptions): SettingsTabId[] {
  const local = isLocalSettingsMode(options)
  return visibleSettingsTabs({
    localMode: local,
    showBilling: options.showBilling ?? true,
    platform: options.platform,
    isDesktop: options.isDesktop,
  })
    .map((tab) => tab.id)
    .filter((id) => !NOT_SHEET_HOSTED.includes(id))
    .filter((id) => !(id === 'compute' && local))
}

/** A requested tab normalised onto something the sheet shows, else Workspace. */
export function resolvePhoneSettingsTab(
  tab: string | undefined,
  options: PhoneSettingsOptions = {},
): AccountSettingsSheetTab {
  const available = availableSheetTabs(options)
  if (tab && available.includes(tab as SettingsTabId)) {
    return tab as AccountSettingsSheetTab
  }
  return 'workspace'
}

/** The tab `/account` should open, or `null` for the Account home. */
export function phoneSettingsSheetTab(
  params: PhoneSettingsParams,
  options: PhoneSettingsOptions = {},
): AccountSettingsSheetTab | null {
  const tab = firstPhoneSettingsParam(params.tab)
  if (!tab) return null
  // Usage and Cost Optimizer are their own screen, not a settings sheet.
  if (tab === 'analytics' || tab === 'costs') return null
  return resolvePhoneSettingsTab(tab, options)
}

/**
 * Where a phone visit to `/settings` belongs. Every incoming query param is
 * forwarded so the Account screen sees exactly what the legacy page would
 * (`workspace`, `slackLinked`, `whatsNew`, …), with `tab` normalised.
 */
export function phoneSettingsTarget(
  params: PhoneSettingsParams,
  options: PhoneSettingsOptions = {},
): PhoneSettingsTarget {
  const tab = firstPhoneSettingsParam(params.tab)
  if (tab === 'analytics' || tab === 'costs') {
    return {
      pathname: '/(app)/analytics',
      params: { view: tab === 'costs' ? 'costs' : 'usage' },
    }
  }

  const forwarded: Record<string, string> = {}
  for (const [key, value] of Object.entries(params)) {
    if (key === 'tab') continue
    const single = firstPhoneSettingsParam(value)
    if (single) forwarded[key] = single
  }
  if (tab) forwarded.tab = resolvePhoneSettingsTab(tab, options)
  return { pathname: '/(app)/account', params: forwarded }
}

/**
 * `?workspace=<id>` from a settings deep link, resolved against the user's own
 * workspaces. Shared by `/settings` and `/account` so both surfaces switch the
 * active workspace the same way before the tab body renders.
 */
export function resolveRequestedWorkspaceId(
  requested: string | undefined,
  ownWorkspaceIds: readonly string[],
): string | null {
  if (!requested || ownWorkspaceIds.length === 0) return null
  return resolveActiveWorkspaceId(ownWorkspaceIds, requested, { listLoaded: true })
}
