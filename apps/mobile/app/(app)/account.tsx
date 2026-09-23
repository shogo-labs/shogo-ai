// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Phone account screen. Replaces the drawer popover so workspace, billing,
 * and sign-out get a full page. Wide web still uses the AccountMenu popover.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { Pressable, ScrollView, Text, View } from "react-native"
import { useRouter } from "expo-router"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { observer } from "mobx-react-lite"
import { ArrowLeft } from "lucide-react-native"
import { useBillingData } from "@shogo/shared-app/hooks"
import { useAuth } from "../../contexts/auth"
import { useDomainActions, useDomainHttp, useProjectCollection, useWorkspaceCollection } from "../../contexts/domain"
import { usePostHogSafe } from "../../contexts/posthog"
import { useResolvedTheme } from "../../contexts/theme"
import { AccountMenuBody } from "../../components/layout/sidebar/AccountMenu"
import { CreateWorkspaceModal } from "../../components/layout/sidebar/CreateWorkspaceModal"
import { NativeAccountSettingsSheet } from "../../components/settings/NativeAccountSettingsSheet"
import { AccountSheetChromeProvider } from "../../components/settings/account-sheet-chrome"
import {
  accountSettingsSheetTitle,
  type AccountSettingsSheetTab,
} from "../../components/settings/account-settings-sheets"
import { useActiveWorkspace } from "../../hooks/useActiveWorkspace"
import { useHasAdminAccess } from "../../hooks/useHasAdminAccess"
import { useWorkspacePlans } from "../../hooks/useWorkspacePlans"
import { EVENTS, trackEvent } from "../../lib/analytics"
import { api } from "../../lib/api"
import { nativePhoneCanvas, NATIVE_ACCOUNT_SCROLL_EXTRA_PAD, NATIVE_ACCOUNT_TITLE_CLASS, NATIVE_PHONE_CONTROL_SIZE } from "../../lib/native-phone-layout"
import { PHONE_DENSITY } from "../../lib/phone-density"
import { usePlatformConfig } from "../../lib/platform-config"
import { usePhoneOnlyRoute } from "../../lib/use-phone-only-route"
import {
  reloadAfterWorkspaceSwitch,
  scheduleWorkspaceSwitch,
} from "../../lib/switch-workspace"
import { setActiveWorkspaceId } from "../../lib/workspace-store"
import { SettingsContent } from "./settings"

function noopAccountClose() {}

export default observer(function AccountPage() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const isSupported = usePhoneOnlyRoute()
  const isDark = useResolvedTheme() === "dark"
  const pageBg = nativePhoneCanvas(isDark)
  const { user, signOut } = useAuth()
  const { features, localMode } = usePlatformConfig()
  const workspaces = useWorkspaceCollection()
  const projects = useProjectCollection()
  const actions = useDomainActions()
  const http = useDomainHttp()
  const posthog = usePostHogSafe()
  const currentWorkspace = useActiveWorkspace()
  const hasAdminAccess = useHasAdminAccess(user?.id)
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<AccountSettingsSheetTab | null>(null)
  const [pendingWorkspaceId, setPendingWorkspaceId] = useState<string | null>(null)

  const allWorkspaces = workspaces?.all ?? []
  // Whether the user already has a `kind: 'personal'` workspace. `false`
  // surfaces the free "Create personal space" CTA — see
  // `WorkspaceMenuSectionProps.hasPersonalWorkspace` for why this can't
  // just be `allWorkspaces.length === 0` (a user's original signup
  // workspace may have been mis-backfilled to `kind: 'team'`).
  const hasPersonalWorkspace = allWorkspaces.some(
    (w: { kind?: string }) => w.kind === "personal",
  )
  // See `AppSidebar.tsx`'s `hasTeamWorkspace` for the free-vs-paid gate this drives.
  const hasTeamWorkspace = allWorkspaces.some(
    (w: { kind?: string }) => w.kind === "team",
  )
  const workspaceIds = useMemo(
    () => allWorkspaces.map((w: { id: string }) => w.id),
    [allWorkspaces],
  )
  const displayWorkspace = useMemo(() => {
    if (!pendingWorkspaceId) return currentWorkspace
    return allWorkspaces.find((w: { id: string }) => w.id === pendingWorkspaceId) ?? currentWorkspace
  }, [allWorkspaces, currentWorkspace, pendingWorkspaceId])
  const billingData = useBillingData(features.billing ? displayWorkspace?.id : undefined)
  const allPlans = useWorkspacePlans(workspaceIds, !!features.billing)
  const workspacePlan = displayWorkspace?.id ? (allPlans[displayWorkspace.id] ?? null) : null

  useEffect(() => {
    workspaces.loadAll().catch(() => undefined)
  }, [workspaces])

  useEffect(() => {
    if (pendingWorkspaceId && currentWorkspace?.id === pendingWorkspaceId) {
      setPendingWorkspaceId(null)
    }
  }, [currentWorkspace?.id, pendingWorkspaceId])

  const go = useCallback(
    (href: string) => {
      router.push(href as never)
    },
    [router],
  )

  const closeAccount = useCallback(() => {
    if (router.canGoBack()) router.back()
    else router.replace("/(app)" as never)
  }, [router])

  const handleSwitchWorkspace = useCallback(
    (workspaceId: string) => {
      if (workspaceId === (pendingWorkspaceId ?? currentWorkspace?.id)) return
      setPendingWorkspaceId(workspaceId)
      trackEvent(posthog, EVENTS.WORKSPACE_SWITCHED)
      scheduleWorkspaceSwitch(workspaceId, projects, reloadAfterWorkspaceSwitch)
    },
    [currentWorkspace?.id, pendingWorkspaceId, posthog, projects],
  )

  const handleCreateWorkspace = useCallback(() => {
    if (hasTeamWorkspace) {
      router.push("/(app)/new-workspace" as never)
      return
    }
    setCreateWorkspaceOpen(true)
  }, [hasTeamWorkspace, router])

  const handleCreateWorkspaceSubmit = useCallback(
    async (name: string) => {
      if (!user?.id) return
      try {
        const created = await actions.createWorkspace(name, undefined, user.id)
        if (created?.id) {
          trackEvent(posthog, EVENTS.WORKSPACE_CREATED)
          setActiveWorkspaceId(created.id)
          await workspaces.loadAll()
          projects.clear()
          await projects.loadAll({ workspaceId: created.id })
        }
      } catch (err) {
        console.warn("Failed to create workspace:", err)
      }
    },
    [actions, posthog, projects, user?.id, workspaces],
  )

  const handleCreatePersonalWorkspace = useCallback(async () => {
    try {
      const newWorkspace = await api.createPersonalWorkspace(http)
      if (newWorkspace?.id) {
        trackEvent(posthog, EVENTS.WORKSPACE_CREATED)
        setActiveWorkspaceId(newWorkspace.id)
        await workspaces.loadAll()
        projects.clear()
        await projects.loadAll({ workspaceId: newWorkspace.id })
        // Land the user in their new space instead of leaving them on the
        // Account page — home reactively renders the personal-workspace
        // "companion" experience once `currentWorkspace.kind === 'personal'`.
        router.push("/(app)" as never)
      }
    } catch (err) {
      console.warn("Failed to create personal workspace:", err)
    }
  }, [http, posthog, projects, workspaces, router])

  const handleSignOut = useCallback(async () => {
    trackEvent(posthog, EVENTS.SIGN_OUT)
    try {
      await signOut()
    } catch {}
  }, [posthog, signOut])

  const closeSettingsSheet = useCallback(() => setSettingsTab(null), [])

  if (!isSupported) return null

  return (
    <View className="flex-1 bg-background" style={{ flex: 1, paddingTop: insets.top, backgroundColor: pageBg }}>
      <View className="border-b border-border/70 bg-card">
        <View className="self-center flex-row items-center gap-2 px-4 py-2" style={{ width: '100%', maxWidth: 680 }}>
          <Pressable
            onPress={closeAccount}
            accessibilityRole="button"
            accessibilityLabel="Back"
            hitSlop={8}
            className="items-center justify-center rounded-full active:bg-muted"
            style={{ width: NATIVE_PHONE_CONTROL_SIZE, height: NATIVE_PHONE_CONTROL_SIZE }}
          >
            <ArrowLeft size={PHONE_DENSITY.icon.md} className="text-foreground" />
          </Pressable>
          <View className="min-w-0 flex-1">
            <Text className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground" numberOfLines={1}>
              {displayWorkspace?.name || 'Workspace'}
            </Text>
            <Text className={`${NATIVE_ACCOUNT_TITLE_CLASS} font-semibold text-foreground`}>Account</Text>
          </View>
        </View>
      </View>
      <ScrollView
        className="flex-1"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: 16,
          paddingBottom: insets.bottom + NATIVE_ACCOUNT_SCROLL_EXTRA_PAD,
          alignItems: 'center',
        }}
      >
        <View style={{ width: '100%', maxWidth: 680 }}>
          <AccountMenuBody
            user={user}
            onSignOut={handleSignOut}
            onNavigate={go}
            isSuperAdmin={hasAdminAccess}
            workspaces={allWorkspaces}
            currentWorkspace={displayWorkspace}
            billingData={billingData}
            workspacePlan={workspacePlan}
            allPlans={allPlans}
            showBilling={features.billing}
            onSwitchWorkspace={handleSwitchWorkspace}
            onCreateWorkspace={handleCreateWorkspace}
            hasPersonalWorkspace={hasPersonalWorkspace}
            onCreatePersonalWorkspace={handleCreatePersonalWorkspace}
            localMode={localMode}
            onClose={noopAccountClose}
            isNative
            onOpenNativeSettingsTab={setSettingsTab}
          />
        </View>
      </ScrollView>
      <NativeAccountSettingsSheet
        visible={settingsTab != null}
        title={settingsTab ? accountSettingsSheetTitle(settingsTab) : ""}
        onClose={closeSettingsSheet}
      >
        {settingsTab ? (
          <SettingsContent
            activeTab={settingsTab}
            localMode={localMode || !features.billing}
          />
        ) : null}
      </NativeAccountSettingsSheet>
      <AccountSheetChromeProvider>
        <CreateWorkspaceModal
          visible={createWorkspaceOpen}
          onClose={() => setCreateWorkspaceOpen(false)}
          onSubmit={handleCreateWorkspaceSubmit}
        />
      </AccountSheetChromeProvider>
    </View>
  )
})
