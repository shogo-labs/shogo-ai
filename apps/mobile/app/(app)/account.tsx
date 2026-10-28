// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Phone account screen. Replaces the drawer popover so workspace, billing,
 * and sign-out get a full page. Wide web still uses the AccountMenu popover.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { Pressable, Platform, ScrollView, Text, View } from "react-native"
import { useLocalSearchParams, useRouter } from "expo-router"
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
import { useActiveInstance } from "../../contexts/active-instance"
import { useWorkspaceExperience } from "../../hooks/useWorkspaceExperience"
import { useMachineWorkspaces } from "../../hooks/useMachineWorkspaces"
import {
  buildWorkspaceEntries,
  currentWorkspaceKey,
  machineInstanceForEntry,
  type WorkspaceEntry,
} from "../../lib/workspace-entries"
import { useHasAdminAccess } from "../../hooks/useHasAdminAccess"
import { useWorkspacePlans } from "../../hooks/useWorkspacePlans"
import { usePooledWorkspaceCreation } from "../../hooks/usePooledWorkspaceCreation"
import { EVENTS, trackEvent } from "../../lib/analytics"
import { api } from "../../lib/api"
import { workspaceErrorMessage } from "../../lib/workspace-errors"
import { nativePhoneCanvas, NATIVE_ACCOUNT_SCROLL_EXTRA_PAD, NATIVE_ACCOUNT_TITLE_CLASS, NATIVE_PHONE_CONTROL_SIZE } from "../../lib/native-phone-layout"
import { PHONE_DENSITY } from "../../lib/phone-density"
import { usePlatformConfig } from "../../lib/platform-config"
import { usePhoneOnlyRoute } from "../../lib/use-phone-only-route"
import {
  reloadAfterWorkspaceSwitch,
  scheduleWorkspaceSwitch,
} from "../../lib/switch-workspace"
import { setActiveWorkspaceId } from "../../lib/workspace-store"
import {
  isDesktopShell,
  phoneSettingsSheetTab,
  resolveRequestedWorkspaceId,
} from "../../lib/phone-settings-route"
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
  const { instance: activeInstance, setInstance: setActiveInstance, clearInstance } = useActiveInstance()
  const { machines } = useMachineWorkspaces()
  const hasAdminAccess = useHasAdminAccess(user?.id)
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false)
  const params = useLocalSearchParams<{ tab?: string; workspace?: string }>()
  const teamChat = useWorkspaceExperience().kind === "team"
  // Same tab-availability rules the legacy Settings page uses, so a deep link
  // that is not available in this mode/platform opens Workspace instead.
  const settingsOptions = useMemo(
    () => ({
      localMode: localMode || !features.billing,
      showBilling: features.billing,
      platform: Platform.OS,
      isDesktop: isDesktopShell(),
      teamChat,
    }),
    [features.billing, localMode, teamChat],
  )
  const requestedTab = typeof params.tab === "string" ? params.tab : undefined
  const [settingsTab, setSettingsTab] = useState<AccountSettingsSheetTab | null>(
    () => phoneSettingsSheetTab(params, settingsOptions),
  )
  const [pendingWorkspaceId, setPendingWorkspaceId] = useState<string | null>(null)

  const allWorkspaces = workspaces?.all ?? []
  // The account page lists the same workspaces the switcher does, machine ones
  // included (SHO-108): a phone must be able to reach every agent, chat and
  // board running on the user's own computer.
  const entries = buildWorkspaceEntries({ workspaces: allWorkspaces, machines })
  const activeKey = currentWorkspaceKey({
    entries,
    currentWorkspaceId: currentWorkspace?.id,
    activeInstance,
  })
  // Whether the user already has a `kind: 'personal'` workspace. `false`
  // surfaces the free "Create personal space" CTA — see
  // `WorkspaceMenuSectionProps.hasPersonalWorkspace` for why this can't
  // just be `allWorkspaces.length === 0` (a user's original signup
  // workspace may have been mis-backfilled to `kind: 'team'`).
  // Empty means the collection has not loaded yet. Omit the flag so the
  // create-personal CTA stays hidden until the list is known.
  const hasPersonalWorkspace =
    allWorkspaces.length === 0
      ? undefined
      : allWorkspaces.some((w: { kind?: string }) => w.kind === "personal")
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
  const { parent: pooledWorkspaceParent, createPooledWorkspace } = usePooledWorkspaceCreation({
    workspaces: allWorkspaces,
    currentWorkspaceId: currentWorkspace?.id,
    enabled: !!features.billing,
  })

  useEffect(() => {
    if (pendingWorkspaceId && currentWorkspace?.id === pendingWorkspaceId) {
      setPendingWorkspaceId(null)
    }
  }, [currentWorkspace?.id, pendingWorkspaceId])

  // A settings deep link (`/settings?tab=…` redirected here) opens its sheet.
  // The `tab` param is consumed by `closeSettingsSheet`, never on mount: a
  // `setParams` here remounts the route on web and would drop the sheet state
  // (and `?workspace=`) before it renders. `slackLinked` is left for
  // `IntegrationsTab`, which owns and clears it.
  useEffect(() => {
    if (!requestedTab) return
    setSettingsTab(phoneSettingsSheetTab({ tab: requestedTab }, settingsOptions))
  }, [requestedTab, settingsOptions])

  // `?workspace=<id>` switches the active workspace before the tab body renders
  // — it is what makes the Automations/People deep links show the right one.
  useEffect(() => {
    const ownWorkspaceIds =
      workspaces?.all?.map((workspace: { id: string }) => workspace.id) ?? []
    const resolved = resolveRequestedWorkspaceId(
      typeof params.workspace === "string" ? params.workspace : undefined,
      ownWorkspaceIds,
    )
    if (resolved) setActiveWorkspaceId(resolved)
  }, [params.workspace, workspaces?.all])

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

  /**
   * One switch path for both hosts: a cloud row switches the workspace, a
   * machine row mounts that computer's own workspace and lands the same way.
   */
  const handleSelectWorkspaceEntry = useCallback(
    (entry: WorkspaceEntry) => {
      const machine = machineInstanceForEntry(entry, currentWorkspace?.id)
      if (machine) {
        setActiveInstance(machine)
        trackEvent(posthog, EVENTS.WORKSPACE_SWITCHED)
        reloadAfterWorkspaceSwitch()
        return
      }
      if (activeInstance?.source === "machine") clearInstance()
      handleSwitchWorkspace(entry.id)
    },
    [activeInstance, clearInstance, currentWorkspace?.id, handleSwitchWorkspace, posthog, setActiveInstance],
  )

  const handleCreateWorkspace = useCallback(() => {
    // Local mode has no billing gate — always the name modal, never the paid
    // `/(app)/new-workspace` checkout page (its billing route 404s locally).
    if (pooledWorkspaceParent || localMode || !hasTeamWorkspace) {
      setCreateWorkspaceOpen(true)
    } else {
      router.push("/(app)/new-workspace" as never)
    }
  }, [hasTeamWorkspace, localMode, pooledWorkspaceParent, router])

  const handleCreateWorkspaceSubmit = useCallback(
    async (name: string) => {
      if (pooledWorkspaceParent) return createPooledWorkspace(name)
      if (!user?.id) return false
      try {
        const created = await actions.createWorkspace(name, undefined, user.id)
        if (created?.id) {
          trackEvent(posthog, EVENTS.WORKSPACE_CREATED)
          setActiveWorkspaceId(created.id)
          await workspaces.loadAll()
          // Same path as switching to an existing workspace: rebind the shell to
          // the new workspace's data and runtime, don't just highlight it.
          scheduleWorkspaceSwitch(created.id, projects, reloadAfterWorkspaceSwitch)
        }
      } catch (err) {
        console.warn("Failed to create workspace:", err)
        return workspaceErrorMessage(err)
      }
    },
    [actions, createPooledWorkspace, pooledWorkspaceParent, posthog, projects, user?.id, workspaces],
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

  // Clearing the consumed `tab` here (not on mount) keeps the deep-linked
  // sheet open while it renders, and still leaves the Account screen clean:
  // closing it or pressing Back afterwards does not re-open the sheet.
  const closeSettingsSheet = useCallback(() => {
    setSettingsTab(null)
    if (requestedTab) router.setParams({ tab: undefined } as any)
  }, [requestedTab, router])

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
            entries={entries}
            currentKey={activeKey}
            onSelectEntry={handleSelectWorkspaceEntry}
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
            onClose={closeSettingsSheet}
          />
        ) : null}
      </NativeAccountSettingsSheet>
      <AccountSheetChromeProvider>
        <CreateWorkspaceModal
          visible={createWorkspaceOpen}
          onClose={() => setCreateWorkspaceOpen(false)}
          onSubmit={handleCreateWorkspaceSubmit}
          parentName={pooledWorkspaceParent?.name}
        />
      </AccountSheetChromeProvider>
    </View>
  )
})
