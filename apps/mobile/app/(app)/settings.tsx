// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Settings Page - Mobile (Expo)
 *
 * Lovable-style sidebar navigation (desktop) / horizontal tabs (mobile):
 * - Workspace: Name, avatar, danger zone
 * - People: Workspace members
 * - Account: Profile, email, preferences
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  View,
  Text,
  ScrollView,
  Pressable,
  TextInput,
  Modal,
  ActivityIndicator,
  Linking,
  Platform,
  StyleSheet,
  useWindowDimensions,
} from 'react-native'
import { useRouter, useLocalSearchParams } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { observer } from 'mobx-react-lite'
import {
  ArrowLeft,
  Building2,
  Users,
  Shield,
  User,
  ExternalLink,
  Trash2,
  ChevronDown,
  X,
  Search,
  UserPlus,
  Mail,
  BarChart3,
  MessageSquare,
  Zap,
  CreditCard,
  Cloud,
  Server,
  Coins,
  Plug,
  Download,
  Bug,
} from 'lucide-react-native'
import { useAuth } from '../../contexts/auth'
import {
  useDomain,
  useWorkspaceCollection,
  useMemberCollection,
  useInvitationCollection,
  useDomainHttp,
  type IDomainStore,
} from '../../contexts/domain'
import { useDomainActions } from '@shogo/shared-app/domain'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { setActiveWorkspaceId } from '../../lib/workspace-store'
import { api, API_URL } from '../../lib/api'
import { useBillingData } from '@shogo/shared-app/hooks'
import { getIncludedUsdCapacityForDisplay, formatUsd, PLAN_PRICING } from '../../lib/billing-config'
import { usePlatformConfig } from '../../lib/platform-config'
import { SecuritySettingsPanel } from '../../components/security/SecuritySettingsPanel'
import { ComputeTab } from '../../components/settings/ComputeTab'
import { BugReportTab } from '../../components/settings/BugReportTab'
import { IntegrationsTab } from '../../components/settings/IntegrationsTab'
import {
  type AnalyticsPeriod,
  type UsageSummaryData,
  type UsageLogData,
  type ChatAnalyticsData,
  type UsageBreakdownData,
  PeriodSelector,
  StatCard,
  UsageTableSection,
  ChatAnalyticsSection,
  UsageBreakdownSection,
} from '../../components/analytics/SharedAnalytics'
import { DateRangePills } from '../../components/analytics/DateRangePills'
import {
  StackedAreaChart,
  StackedAreaLegend,
  STACKED_PALETTE,
  type StackedSeries,
} from '../../components/analytics/StackedAreaChart'
import { UsageLeaderboard } from '../../components/analytics/UsageLeaderboard'
import { BillingProgressCard } from '../../components/billing/BillingProgressCard'
import { SetSpendLimitDialog } from '../../components/billing/SetSpendLimitDialog'
import { CostAnalyticsTab } from '../../components/analytics/CostAnalyticsTab'
import { useToast, Toast, ToastTitle, ToastDescription } from '@/components/ui/toast'
import { invitationEvents } from '../../lib/invitation-events'
import {
  Card,
  CardContent,
  Button,
  Input,
  Badge,
  Separator,
  Skeleton,
  Switch,
  cn,
} from '@shogo/shared-ui/primitives'
import { useNotifyOnTurnComplete as useNotifyOnTurnCompletePref } from '../../lib/notifications/preferences'
import { useDualPlan } from '../../lib/dual-plan-preference'

const DOCS_URL = 'https://docs.shogo.ai'

type TabId = 'workspace' | 'people' | 'integrations' | 'account' | 'security' | 'billing' | 'compute' | 'analytics' | 'costs' | 'support'

const ALL_TAB_IDS: TabId[] = ['workspace', 'people', 'integrations', 'account', 'security', 'billing', 'compute', 'analytics', 'costs', 'support']

/** Tablet/desktop split: matches `SettingsPage` `isWide` (sidebar layout). */
const SETTINGS_WIDE_BREAKPOINT = 768

interface NavItem {
  id: TabId
  label: string
  icon: React.ElementType
}

const MOBILE_NAV_ITEMS: NavItem[] = [
  { id: 'workspace', label: 'Workspace', icon: Building2 },
  { id: 'people', label: 'People', icon: Users },
  { id: 'integrations', label: 'Integrations', icon: Plug },
  { id: 'account', label: 'Account', icon: User },
  { id: 'compute', label: 'Compute', icon: Server },
  { id: 'billing', label: 'Billing', icon: CreditCard },
  { id: 'analytics', label: 'Usage', icon: BarChart3 },
  { id: 'costs', label: 'Costs', icon: Coins },
]

const LOCAL_NAV_ITEMS: NavItem[] = [
  { id: 'workspace', label: 'Workspace', icon: Building2 },
  { id: 'integrations', label: 'Integrations', icon: Plug },
  { id: 'account', label: 'Account', icon: User },
  { id: 'security', label: 'Security', icon: Shield },
  { id: 'analytics', label: 'Usage', icon: BarChart3 },
  { id: 'costs', label: 'Costs', icon: Coins },
  { id: 'support', label: 'Report Bug', icon: Bug },
]

function TabBar({
  activeTab,
  onTabChange,
  showBilling = true,
  localMode = false,
}: {
  activeTab: TabId
  onTabChange: (tab: TabId) => void
  showBilling?: boolean
  localMode?: boolean
}) {
  const items = (showBilling && !localMode) ? MOBILE_NAV_ITEMS : LOCAL_NAV_ITEMS
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      className="border-b border-border"
      contentContainerClassName="px-4"
      style={{ flexGrow: 0 }}
    >
      {items.map((item) => {
        const Icon = item.icon
        const isActive = activeTab === item.id
        return (
          <Pressable
            key={item.id}
            onPress={() => onTabChange(item.id)}
            className={cn(
              'flex-row items-center gap-2 px-3 py-3 mr-1',
              isActive ? 'border-b-2 border-primary' : ''
            )}
          >
            <Icon
              size={16}
              className={isActive ? 'text-primary' : 'text-muted-foreground'}
            />
            <Text
              className={cn(
                'text-sm font-medium',
                isActive ? 'text-primary' : 'text-muted-foreground'
              )}
            >
              {item.label}
            </Text>
          </Pressable>
        )
      })}
    </ScrollView>
  )
}

interface SidebarItem {
  id: TabId
  label: string
  avatar?: string
}

interface SidebarSection {
  id: string
  label?: string
  items: SidebarItem[]
}

function SettingsSidebar({
  activeTab,
  onTabChange,
  workspaceName,
  userName,
  showBilling = true,
  localMode = false,
}: {
  activeTab: TabId
  onTabChange: (tab: TabId) => void
  workspaceName: string
  userName: string
  showBilling?: boolean
  localMode?: boolean
}) {
  const router = useRouter()

  const workspaceItems: SidebarItem[] = [
    { id: 'workspace', label: workspaceName || 'Workspace', avatar: (workspaceName?.[0] || 'W').toUpperCase() },
    ...(!(localMode || !showBilling) ? [{ id: 'people' as TabId, label: 'People' }] : []),
    { id: 'integrations' as TabId, label: 'Integrations' },
    ...(showBilling
      ? [
          { id: 'compute' as TabId, label: 'Compute' },
          { id: 'billing' as TabId, label: 'Billing' },
          { id: 'analytics' as TabId, label: 'Usage' },
          { id: 'costs' as TabId, label: 'Cost Optimizer' },
        ]
      : [
          { id: 'analytics' as TabId, label: 'Usage' },
          { id: 'costs' as TabId, label: 'Cost Optimizer' },
        ]),
  ]

  const sections: SidebarSection[] = [
    {
      id: 'workspace',
      label: 'Workspace',
      items: workspaceItems,
    },
    {
      id: 'account',
      label: 'Account',
      items: [
        { id: 'account', label: userName || 'Account' },
        ...(!showBilling ? [{ id: 'security' as TabId, label: 'Security' }] : []),
      ],
    },
    ...(localMode ? [{
      id: 'support',
      label: 'Support',
      items: [
        { id: 'support' as TabId, label: 'Report Bug' },
      ],
    }] : []),
  ]

  return (
    <View className="w-[210px] pt-4 pb-3 px-3">
      <Pressable
        onPress={() => router.canGoBack() ? router.back() : router.replace('/(app)/projects')}
        className="flex-row items-center gap-1 px-2 py-1.5 mb-4"
      >
        <ArrowLeft size={14} className="text-muted-foreground" />
        <Text className="text-sm text-muted-foreground">Go back</Text>
      </Pressable>

      {sections.map((section, sectionIdx) => (
        <View key={section.id} className={sectionIdx > 0 ? 'mt-6' : ''}>
          {section.label && (
            <Text className="text-xs font-medium text-muted-foreground px-2 mb-1">
              {section.label}
            </Text>
          )}
          <View className="gap-0.5">
          {section.items.map((item) => {
            const isActive = activeTab === item.id
            return (
              <Pressable
                key={item.id}
                onPress={() => onTabChange(item.id)}
                className={cn(
                  'flex-row items-center gap-2 px-2 py-2 rounded-md',
                  isActive ? 'bg-muted' : ''
                )}
              >
                {item.avatar && (
                  <View className="h-5 w-5 rounded bg-primary items-center justify-center">
                    <Text className="text-[10px] font-semibold text-primary-foreground">
                      {item.avatar}
                    </Text>
                  </View>
                )}
                <Text
                  className={cn(
                    'text-sm flex-1',
                    isActive ? 'text-foreground font-medium' : 'text-muted-foreground'
                  )}
                  numberOfLines={1}
                >
                  {item.label}
                </Text>
              </Pressable>
            )
          })}
          </View>
        </View>
      ))}
    </View>
  )
}

// ============================================================================
// REMOTE ACCESS SECTION (local mode only)
// ============================================================================

function RemoteAccessSection({ workspaceId }: { workspaceId?: string }) {
  const [status, setStatus] = useState<{
    connected: boolean
    keyMask?: string
    cloudUrl?: string
    workspace?: { name: string } | null
  } | null>(null)
  const [loading, setLoading] = useState(true)
  const [apiKey, setApiKey] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)
  const [disconnecting, setDisconnecting] = useState(false)

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/local/shogo-key`, { credentials: 'include' })
      const data = await res.json()
      setStatus(data)
    } catch {
      setStatus({ connected: false })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchStatus()
  }, [fetchStatus])

  const handleConnect = async () => {
    if (!apiKey.trim()) return
    setConnecting(true)
    setConnectError(null)
    try {
      const res = await fetch(`${API_URL}/api/local/shogo-key`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: apiKey.trim() }),
      })
      const data = await res.json()
      if (!data.ok) {
        setConnectError(data.error || 'Failed to connect')
        return
      }
      setApiKey('')
      await fetchStatus()
    } catch (err: any) {
      setConnectError(err.message || 'Network error')
    } finally {
      setConnecting(false)
    }
  }

  const handleDisconnect = async () => {
    setDisconnecting(true)
    try {
      await fetch(`${API_URL}/api/local/shogo-key`, { method: 'DELETE', credentials: 'include' })
      await fetchStatus()
    } catch {}
    setDisconnecting(false)
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6">
          <Skeleton className="h-6 w-40 mb-2" />
          <Skeleton className="h-4 w-60" />
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardContent className="p-0">
        <View className="px-6 py-5">
          <View className="flex-row items-center gap-2 mb-1">
            <Cloud size={18} className="text-primary" />
            <Text className="text-base font-semibold text-foreground">
              Remote Access
            </Text>
          </View>
          <Text className="text-sm text-muted-foreground">
            Connect to Shogo Cloud to control this desktop from your phone or another computer.
          </Text>
        </View>

        <Separator />

        {status?.connected ? (
          <View className="px-6 py-5 gap-4">
            <View className="flex-row items-center gap-2">
              <View className="h-2.5 w-2.5 rounded-full bg-green-500" />
              <Text className="text-sm font-medium text-foreground">Connected to Shogo Cloud</Text>
            </View>

            <View className="gap-2.5">
              <View className="flex-row items-center justify-between">
                <Text className="text-sm text-muted-foreground">API Key</Text>
                <Text className="text-sm font-mono text-foreground">{status.keyMask}</Text>
              </View>
              <View className="flex-row items-center justify-between">
                <Text className="text-sm text-muted-foreground">Cloud URL</Text>
                <Text className="text-sm text-foreground" numberOfLines={1}>{status.cloudUrl}</Text>
              </View>
              {status.workspace?.name && (
                <View className="flex-row items-center justify-between">
                  <Text className="text-sm text-muted-foreground">Workspace</Text>
                  <Text className="text-sm text-foreground">{status.workspace.name}</Text>
                </View>
              )}
            </View>

            <Button
              variant="outline"
              size="sm"
              onPress={handleDisconnect}
              disabled={disconnecting}
              className="self-start"
            >
              <Text className="text-sm font-medium text-foreground">
                {disconnecting ? 'Disconnecting...' : 'Disconnect'}
              </Text>
            </Button>
          </View>
        ) : (
          <View className="px-6 py-5 gap-5">
            <View className="gap-3">
              <Text className="text-sm font-medium text-foreground">
                Connect with API Key
              </Text>
              <Text className="text-xs text-muted-foreground">
                Create an API key from your Shogo Cloud workspace, then paste it here.
              </Text>
              {status?.cloudUrl ? (
                <View className="flex-row items-center justify-between">
                  <Text className="text-xs text-muted-foreground">Cloud URL</Text>
                  <Text className="text-xs text-foreground" numberOfLines={1}>{status.cloudUrl}</Text>
                </View>
              ) : null}
              <View className="gap-2">
                <View>
                  <Text className="text-xs text-muted-foreground mb-1">API Key</Text>
                  <Input
                    value={apiKey}
                    onChangeText={setApiKey}
                    placeholder="shogo_sk_..."
                    autoCapitalize="none"
                    autoCorrect={false}
                    secureTextEntry
                  />
                </View>
              </View>

              {connectError && (
                <Text className="text-xs text-destructive">{connectError}</Text>
              )}

              <Button
                onPress={handleConnect}
                disabled={connecting || !apiKey.trim()}
                size="sm"
                className="self-start"
              >
                <Text className={cn('text-sm font-medium', apiKey.trim() && !connecting ? 'text-primary-foreground' : 'text-muted-foreground')}>
                  {connecting ? 'Connecting...' : 'Connect'}
                </Text>
              </Button>
            </View>
          </View>
        )}
      </CardContent>
    </Card>
  )
}

// ============================================================================
// WORKSPACE SETTINGS TAB
// ============================================================================

const WorkspaceSettingsTab = observer(function WorkspaceSettingsTab() {
  const { width } = useWindowDimensions()
  const isWideNameSection = width >= SETTINGS_WIDE_BREAKPOINT
  const router = useRouter()
  const store = useDomain() as IDomainStore
  const actions = useDomainActions()
  const { user } = useAuth()
  const { features: wsFeatures, localMode } = usePlatformConfig()
  const workspaces = useWorkspaceCollection()
  const members = useMemberCollection()
  const http = useDomainHttp()
  const currentWorkspace = useActiveWorkspace()

  const [name, setName] = useState(currentWorkspace?.name || '')
  const [isSaving, setIsSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle')
  const [isLeaveDialogOpen, setIsLeaveDialogOpen] = useState(false)
  const [isLeaving, setIsLeaving] = useState(false)
  const [leaveError, setLeaveError] = useState<string | null>(null)
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [deleteConfirmText, setDeleteConfirmText] = useState('')

  const originalName = currentWorkspace?.name || ''
  const hasChanges = name !== originalName
  const isValid = name.trim().length > 0 && name.length <= 60

  const currentUserId = user?.id
  const membersAll = Array.isArray(members.all) ? members.all : []
  const workspaceMembers = currentWorkspace?.id
    ? membersAll.filter(
        (m: any) => m.workspaceId === currentWorkspace.id && !m.projectId
      )
    : []
  const currentUserMember = workspaceMembers.find(
    (m: any) => m.userId === currentUserId
  )
  const isOwner = currentUserMember?.role === 'owner'

  const isPersonalWorkspace =
    currentWorkspace?.slug?.includes('personal') ||
    currentWorkspace?.name?.toLowerCase().includes('personal')

  const wsAll = Array.isArray(workspaces.all) ? workspaces.all : []
  const canDelete = isOwner && wsAll.length > 1 && !isPersonalWorkspace
  const deleteConfirmRequired = currentWorkspace?.name || 'delete'
  const isDeleteConfirmed = deleteConfirmText === deleteConfirmRequired

  useEffect(() => {
    setName(currentWorkspace?.name || '')
    setSaveStatus('idle')
  }, [currentWorkspace?.name])

  useEffect(() => {
    if (currentWorkspace?.id) {
      members.loadAll({ workspaceId: currentWorkspace.id }).catch((e) => console.error('[Settings] Failed to load members:', e))
    }
  }, [currentWorkspace?.id])

  const handleSave = async () => {
    if (!hasChanges || !isValid || !currentWorkspace?.id) return
    setIsSaving(true)
    setSaveStatus('idle')
    try {
      await actions.updateWorkspace(currentWorkspace.id, { name: name.trim() })
      setSaveStatus('saved')
      setTimeout(() => setSaveStatus('idle'), 2000)
    } catch (error) {
      console.error('Failed to save workspace name:', error)
      setSaveStatus('error')
    } finally {
      setIsSaving(false)
    }
  }

  const handleDeleteWorkspace = async () => {
    if (!currentWorkspace?.id || !isDeleteConfirmed) return
    setIsDeleting(true)
    try {
      await actions.deleteWorkspace(currentWorkspace.id)
      setIsDeleteDialogOpen(false)
      router.replace('/(app)')
    } catch (error) {
      console.error('Failed to delete workspace:', error)
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <View className="gap-8">
      <View>
        <Text className="text-xl font-semibold text-foreground">
          Workspace settings
        </Text>
        <Text className="text-sm text-muted-foreground mt-1">
          Workspaces allow you to collaborate on projects in real time.
        </Text>
      </View>

      <Card>
        <CardContent className="p-0">
          {/* Name — stacked on narrow viewports; side-by-side on tablet/desktop */}
          {isWideNameSection ? (
            <View className="px-6 py-5 flex-row items-start justify-between">
              <View className="flex-[0.45] mr-4 pt-1">
                <Text className="text-base font-semibold text-foreground">
                  Name
                </Text>
                <Text className="text-sm text-muted-foreground mt-0.5">
                  Your full workspace name, as visible to others.
                </Text>
              </View>
              <View className="flex-[0.55]">
                <View className="flex-row gap-2 items-start">
                  <View className="flex-1">
                    <Input
                      value={name}
                      onChangeText={(t) => {
                        setName(t)
                        setSaveStatus('idle')
                      }}
                    />
                  </View>
                  <Button
                    onPress={handleSave}
                    disabled={!hasChanges || !isValid || isSaving}
                    size="sm"
                  >
                    {isSaving ? 'Saving...' : 'Save'}
                  </Button>
                </View>
                <Text className="text-xs text-muted-foreground mt-1.5 text-right">
                  {name.length} / 60 characters
                </Text>
                {saveStatus === 'saved' && (
                  <Text className="text-xs text-green-600 mt-1">
                    Changes saved successfully!
                  </Text>
                )}
                {saveStatus === 'error' && (
                  <Text className="text-xs text-destructive mt-1">
                    Failed to save changes. Please try again.
                  </Text>
                )}
              </View>
            </View>
          ) : (
            <View className="px-6 py-5">
              <Text className="text-base font-semibold text-foreground">
                Name
              </Text>
              <Text className="text-sm text-muted-foreground mt-0.5">
                Your full workspace name, as visible to others.
              </Text>
              <Input
                className="mt-3 w-full min-w-0"
                value={name}
                onChangeText={(t) => {
                  setName(t)
                  setSaveStatus('idle')
                }}
              />
              <Text className="text-xs text-muted-foreground mt-1.5">
                {name.length} / 60 characters
              </Text>
              <View className="mt-3 flex-row justify-end">
                <Button
                  onPress={handleSave}
                  disabled={!hasChanges || !isValid || isSaving}
                  size="sm"
                >
                  {isSaving ? 'Saving...' : 'Save'}
                </Button>
              </View>
              {saveStatus === 'saved' && (
                <Text className="text-xs text-green-600 mt-2">
                  Changes saved successfully!
                </Text>
              )}
              {saveStatus === 'error' && (
                <Text className="text-xs text-destructive mt-2">
                  Failed to save changes. Please try again.
                </Text>
              )}
            </View>
          )}
        </CardContent>
      </Card>

      {localMode && <RemoteAccessSection workspaceId={currentWorkspace?.id} />}

      {!localMode && (
        <>
          {/* Leave workspace */}
          <Card>
            <CardContent className="p-0">
              <View className="px-6 py-5 flex-row items-center justify-between">
                <View className="flex-1 mr-4">
                  <Text className="text-base font-semibold text-foreground">
                    Leave workspace
                  </Text>
                  <Text className="text-sm text-muted-foreground mt-0.5">
                    Leave this workspace. You will lose access to its projects and data.
                  </Text>
                </View>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={wsAll.length <= 1 || (isOwner && !workspaceMembers.some(
                    (m: any) => m.role === 'owner' && m.userId !== user?.id
                  ))}
                  onPress={() => setIsLeaveDialogOpen(true)}
                >
                  Leave workspace
                </Button>
              </View>

              {isOwner && (
                <>
                  <Separator />
                  <View className="px-6 py-5 flex-row items-center justify-between">
                    <View className="flex-1 mr-4">
                      <Text className="text-base font-semibold text-destructive">
                        Delete workspace
                      </Text>
                      <Text className="text-sm text-muted-foreground mt-0.5">
                        {canDelete
                          ? 'Permanently delete this workspace and all its data.'
                          : isPersonalWorkspace
                          ? 'Your personal workspace cannot be deleted.'
                          : 'You cannot delete your only workspace.'}
                      </Text>
                    </View>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={!canDelete}
                      onPress={() => setIsDeleteDialogOpen(true)}
                    >
                      Delete
                    </Button>
                  </View>
                </>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {/* Leave Workspace Confirmation Modal */}
      <Modal
        visible={isLeaveDialogOpen}
        transparent
        animationType="fade"
        onRequestClose={() => { if (!isLeaving) { setIsLeaveDialogOpen(false); setLeaveError(null) } }}
      >
        <Pressable
          className="flex-1 bg-black/50 justify-center items-center px-6"
          onPress={() => { if (!isLeaving) { setIsLeaveDialogOpen(false); setLeaveError(null) } }}
        >
          <Pressable className="bg-background rounded-xl p-6 w-full max-w-sm gap-4">
            <View className="flex-row items-center justify-between">
              <Text className="text-lg font-semibold text-foreground">
                Leave workspace
              </Text>
              <Pressable onPress={() => { if (!isLeaving) { setIsLeaveDialogOpen(false); setLeaveError(null) } }} className="p-1">
                <X size={20} className="text-muted-foreground" />
              </Pressable>
            </View>
            <Text className="text-sm text-muted-foreground">
              Are you sure you want to leave "{currentWorkspace?.name}"? You will lose access to all projects and data in this workspace.
            </Text>
            {leaveError && (
              <Text className="text-sm text-destructive">{leaveError}</Text>
            )}
            <View className="flex-row gap-2 justify-end">
              <Button
                variant="outline"
                size="sm"
                onPress={() => { setIsLeaveDialogOpen(false); setLeaveError(null) }}
                disabled={isLeaving}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={isLeaving}
                onPress={async () => {
                  setIsLeaving(true)
                  setLeaveError(null)
                  try {
                    const wsId = currentWorkspace?.id
                    if (!wsId || !http) {
                      setLeaveError('Missing workspace information.')
                      setIsLeaving(false)
                      return
                    }
                    await api.leaveWorkspace(http, wsId)
                    await workspaces.loadAll()
                    const remaining = Array.isArray(workspaces.all) ? workspaces.all : []
                    if (remaining.length > 0) {
                      setActiveWorkspaceId((remaining[0] as any).id)
                    }
                    setIsLeaveDialogOpen(false)
                    setLeaveError(null)
                    router.replace('/(app)/projects')
                  } catch (error: any) {
                    console.error('[Settings] Failed to leave workspace:', error)
                    const msg = error?.details?.error?.message
                      || error?.message
                      || 'Failed to leave workspace.'
                    setLeaveError(msg)
                    setIsLeaving(false)
                  }
                }}
              >
                {isLeaving ? 'Leaving...' : 'Leave workspace'}
              </Button>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Delete Workspace Confirmation Modal */}
      <Modal
        visible={isDeleteDialogOpen}
        transparent
        animationType="fade"
        onRequestClose={() => { setIsDeleteDialogOpen(false); setDeleteConfirmText('') }}
      >
        <Pressable
          className="flex-1 bg-black/50 justify-center items-center px-6"
          onPress={() => { setIsDeleteDialogOpen(false); setDeleteConfirmText('') }}
        >
          <Pressable className="bg-background rounded-xl p-6 w-full max-w-sm gap-4">
            <View className="flex-row items-center justify-between">
              <Text className="text-lg font-semibold text-destructive">
                Delete workspace
              </Text>
              <Pressable onPress={() => { setIsDeleteDialogOpen(false); setDeleteConfirmText('') }} className="p-1">
                <X size={20} className="text-muted-foreground" />
              </Pressable>
            </View>
            <Text className="text-sm text-muted-foreground">
              This action cannot be undone. This will permanently delete the
              workspace "{currentWorkspace?.name}".
            </Text>
            <Text className="text-sm text-muted-foreground">
              Please type "{deleteConfirmRequired}" to confirm.
            </Text>
            <Input
              value={deleteConfirmText}
              onChangeText={setDeleteConfirmText}
              placeholder={`Type "${deleteConfirmRequired}" to confirm`}
            />
            <View className="flex-row gap-2 justify-end">
              <Button
                variant="outline"
                size="sm"
                onPress={() => {
                  setIsDeleteDialogOpen(false)
                  setDeleteConfirmText('')
                }}
                disabled={isDeleting}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onPress={handleDeleteWorkspace}
                disabled={!isDeleteConfirmed || isDeleting}
              >
                {isDeleting ? 'Deleting...' : 'Delete workspace'}
              </Button>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  )
})

// ============================================================================
// ACCOUNT TAB
// ============================================================================

function NotificationsCard() {
  const [notifyOnTurn, setNotifyOnTurn] = useNotifyOnTurnCompletePref()
  return (
    <Card>
      <CardContent className="p-0">
        <View className="px-6 py-5 flex-row items-center justify-between">
          <View className="flex-1 mr-4">
            <Text className="text-sm font-semibold text-foreground">
              Notify when a reply is ready
            </Text>
            <Text className="text-sm text-muted-foreground mt-0.5">
              Send a system notification when a chat turn finishes while Shogo
              isn't in the foreground. Applies on desktop, web, and mobile.
            </Text>
          </View>
          <Switch
            checked={notifyOnTurn}
            onCheckedChange={(v) => {
              void setNotifyOnTurn(v)
            }}
          />
        </View>
      </CardContent>
    </Card>
  )
}

function DualPlanCard() {
  const [dualPlan, setDualPlan] = useDualPlan()
  return (
    <Card>
      <CardContent className="p-0">
        <View className="px-6 py-5 flex-row items-center justify-between">
          <View className="flex-1 mr-4">
            <Text className="text-sm font-semibold text-foreground">
              Generate business summaries for plans
            </Text>
            <Text className="text-sm text-muted-foreground mt-0.5">
              When on, every plan you generate also gets a
              business-language summary translated. You can
              flip between the Technical and Business views from any plan,
              and generate summaries on demand for older plans.
            </Text>
          </View>
          <Switch
            checked={dualPlan}
            onCheckedChange={(v) => {
              void setDualPlan(v)
            }}
          />
        </View>
      </CardContent>
    </Card>
  )
}

function AccountTab() {
  const { user, signOut, updateUser } = useAuth()
  const http = useDomainHttp()
  const router = useRouter()
  const { localMode } = usePlatformConfig()
  const toast = useToast()

  const [name, setName] = useState(user?.name || '')
  const [isSaving, setIsSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle')
  const [isDeleting, setIsDeleting] = useState(false)
  const [deleteConfirmText, setDeleteConfirmText] = useState('')
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)

  const originalName = user?.name || ''
  const hasNameChanges = name !== originalName
  const hasChanges = hasNameChanges

  useEffect(() => {
    setName(user?.name || '')
  }, [user?.name])

  const handleSave = async () => {
    if (!hasChanges || isSaving || !user?.id) return
    if (hasNameChanges && !name.trim()) return
    setIsSaving(true)
    setSaveStatus('idle')
    try {
      await updateUser({ name: name.trim() })
      setSaveStatus('saved')
      setTimeout(() => setSaveStatus('idle'), 2000)
    } catch (error) {
      console.error('Failed to save account settings:', error)
      setSaveStatus('error')
    } finally {
      setIsSaving(false)
    }
  }

  const handleSignOut = async () => {
    await signOut()
    router.replace(localMode ? '/' : '/(auth)/sign-in')
  }

  const handleDeleteAccount = async () => {
    if (deleteConfirmText !== 'DELETE' || !user?.id || !http) return
    setIsDeleting(true)
    try {
      await api.deleteAccount(http, user.id)
      await signOut()
      router.replace(localMode ? '/' : '/(auth)/sign-in')
    } catch (error: any) {
      console.error('Failed to delete account:', error)
      const msg = error?.details?.error?.message
        || error?.message
        || 'Failed to delete account. Please try again or contact support.'
      toast.show({
        placement: 'top',
        duration: 5000,
        render: ({ id }: { id: string }) => (
          <Toast nativeID={id} variant="outline" action="error">
            <ToastTitle>Failed to delete account</ToastTitle>
            <ToastDescription>{msg}</ToastDescription>
          </Toast>
        ),
      })
    } finally {
      setIsDeleting(false)
      setIsDeleteDialogOpen(false)
      setDeleteConfirmText('')
    }
  }

  return (
    <View className="gap-8">
      <View>
        <Text className="text-xl font-semibold text-foreground">
          Account settings
        </Text>
        <Text className="text-sm text-muted-foreground mt-1">
          Personalize how others see and interact with you on Shogo.
        </Text>
      </View>

      {/* Profile */}
      <Card>
        <CardContent className="p-0">
          {/* Avatar */}
          <View className="px-6 py-5 flex-row items-center justify-between">
            <View className="flex-1 mr-4">
              <Text className="text-sm font-semibold text-foreground">
                Avatar
              </Text>
              <Text className="text-sm text-muted-foreground mt-0.5">
                Your avatar is fetched from your identity provider or
                automatically generated.
              </Text>
            </View>
            <View className="h-10 w-10 rounded-full bg-primary items-center justify-center">
              <Text className="text-sm font-semibold text-primary-foreground">
                {user?.name?.[0]?.toUpperCase() || 'U'}
              </Text>
            </View>
          </View>

          <Separator />

          {/* Username */}
          <View className="px-6 py-5">
            <Text className="text-sm font-semibold text-foreground">
              Username
            </Text>
            <Text className="text-sm text-muted-foreground mt-0.5">
              Your public display name and profile identifier.
            </Text>
            <View className="flex-row gap-3 items-start mt-3">
              <View className="flex-1">
                <Input
                  value={name}
                  onChangeText={(t) => {
                    setName(t)
                    setSaveStatus('idle')
                  }}
                  placeholder="Enter a username"
                />
              </View>
              <Button
                variant="outline"
                size="sm"
                onPress={handleSave}
                disabled={!hasNameChanges || !name.trim() || isSaving}
              >
                {isSaving ? 'Saving...' : 'Update'}
              </Button>
            </View>
            {saveStatus === 'saved' && (
              <Text className="text-xs text-green-600 mt-1">
                Updated successfully!
              </Text>
            )}
            {saveStatus === 'error' && (
              <Text className="text-xs text-destructive mt-1">
                Failed to update. Please try again.
              </Text>
            )}
          </View>

          <Separator />

          {/* Email */}
          <View className="px-6 py-5">
            <Text className="text-sm font-semibold text-foreground">Email</Text>
            <Text className="text-sm text-muted-foreground mt-0.5">
              Your email address associated with your account.
            </Text>
            <Input className="mt-3" value={user?.email || ''} disabled />
          </View>

        </CardContent>
      </Card>

      <NotificationsCard />

      <DualPlanCard />

      {!localMode && (
        <Card>
          <CardContent className="p-0">
            {/* Delete account */}
            <View className="px-6 py-5">
                <View className="flex-row items-center justify-between">
                  <View className="flex-1 mr-4">
                    <Text className="text-sm font-semibold text-foreground">
                      Delete account
                    </Text>
                    <Text className="text-sm text-muted-foreground mt-0.5">
                      Permanently delete your Shogo account. This cannot be undone.
                    </Text>
                  </View>
                  <Button
                    variant="destructive"
                    size="sm"
                    onPress={() => setIsDeleteDialogOpen(true)}
                  >
                    Delete
                  </Button>
                </View>
                {isDeleteDialogOpen && (
                  <View className="mt-4 p-4 border border-destructive/30 rounded-lg bg-destructive/5">
                    <Text className="text-sm text-foreground font-medium">
                      Are you sure? This action is irreversible.
                    </Text>
                    <Text className="text-sm text-muted-foreground mt-1">
                      Type "DELETE" to confirm.
                    </Text>
                    <Input
                      className="mt-2"
                      value={deleteConfirmText}
                      onChangeText={setDeleteConfirmText}
                      placeholder='Type "DELETE"'
                    />
                    <View className="flex-row gap-2 mt-3">
                      <Button
                        variant="outline"
                        size="sm"
                        onPress={() => {
                          setIsDeleteDialogOpen(false)
                          setDeleteConfirmText('')
                        }}
                        disabled={isDeleting}
                      >
                        Cancel
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onPress={handleDeleteAccount}
                        disabled={deleteConfirmText !== 'DELETE' || isDeleting}
                      >
                        {isDeleting ? 'Deleting...' : 'Permanently delete'}
                      </Button>
                    </View>
                  </View>
                )}
              </View>
          </CardContent>
        </Card>
      )}

      {/* Sign Out */}
      {!localMode && (
        <Button variant="destructive" onPress={handleSignOut} className="w-full">
          Sign Out
        </Button>
      )}

      {/* Save changes bar */}
      {hasChanges && (
        <View className="bg-background border-t border-border px-4 py-3 flex-row items-center justify-between">
          <Text className="text-sm text-muted-foreground">
            You have unsaved changes
          </Text>
          <View className="flex-row items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onPress={() => setName(originalName)}
              disabled={isSaving}
            >
              Discard
            </Button>
            <Button
              size="sm"
              onPress={handleSave}
              disabled={!hasChanges || (hasNameChanges && !name.trim()) || isSaving}
            >
              {isSaving ? 'Saving...' : 'Save changes'}
            </Button>
          </View>
        </View>
      )}
    </View>
  )
}

// ============================================================================
// PEOPLE TAB — Lovable-style workspace member management
// ============================================================================

type PeopleSubTab = 'all' | 'invitations'

const ROLE_DISPLAY: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Editor',
  viewer: 'Viewer',
}

const ROLE_COLORS: Record<string, string> = {
  owner: 'bg-amber-500',
  admin: 'bg-blue-500',
  member: 'bg-emerald-500',
  viewer: 'bg-slate-400',
}

type SortField = 'name' | 'role' | 'included' | 'free' | 'onDemand'
type SortDir = 'asc' | 'desc'

function formatUsdLabel(value: number): string {
  if (value === 0) return '$0.00'
  if (value < 0.01) return '<$0.01'
  return `$${value.toFixed(2)}`
}

const PeopleTab = observer(function PeopleTab() {
  const { width } = useWindowDimensions()
  const isMobilePeopleLayout = width < SETTINGS_WIDE_BREAKPOINT

  const { user } = useAuth()
  const workspaces = useWorkspaceCollection()
  const members = useMemberCollection()
  const invitations = useInvitationCollection()
  const actions = useDomainActions()
  const http = useDomainHttp()
  const currentWorkspace = useActiveWorkspace()
  const toast = useToast()

  const [subTab, setSubTab] = useState<PeopleSubTab>('all')
  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState<string>('all')
  const [showRoleFilter, setShowRoleFilter] = useState(false)
  const [showInviteModal, setShowInviteModal] = useState(false)
  const [sortField, setSortField] = useState<SortField>('onDemand')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [isLoading, setIsLoading] = useState(true)
  const [menuState, setMenuState] = useState<{ memberId: string; view: 'actions' | 'roles' } | null>(null)
  const [userMap, setUserMap] = useState<Record<string, { name: string; email: string }>>({})
  const [receivedInvites, setReceivedInvites] = useState<any[]>([])
  const [processingInvite, setProcessingInvite] = useState<{ id: string; action: 'accept' | 'decline' } | null>(null)

  const [resolvedWs, setResolvedWs] = useState<{ id: string; name: string } | null>(null)
  const [memberUsage, setMemberUsage] = useState<{
    monthly: Record<string, number>
    total: Record<string, number>
    included: Record<string, number>
    free: Record<string, number>
    onDemand: Record<string, number>
  }>({ monthly: {}, total: {}, included: {}, free: {}, onDemand: {} })

  const loadPeopleData = useCallback(async () => {
    if (!currentWorkspace?.id) {
      if ((Array.isArray(workspaces.all) ? workspaces.all : []).length === 0) {
        try { await workspaces.loadAll({}) } catch {}
      }
      setIsLoading(false)
      return
    }
    setIsLoading(true)
    try {
      const ws = currentWorkspace
      setResolvedWs({ id: ws.id, name: ws.name || 'Workspace' })

      await members.loadAll({ workspaceId: ws.id })
      await invitations.loadAll({ workspaceId: ws.id })

      if (http) {
        try {
          const rawItems = await api.getWorkspaceMembers(http, ws.id)
          const items = Array.isArray(rawItems) ? rawItems : []
          const map: Record<string, { name: string; email: string }> = {}
          for (const item of items) {
            if (item.user && typeof item.user === 'object' && item.user.id) {
              map[item.user.id] = {
                name: item.user.name || '',
                email: item.user.email || '',
              }
            }
          }
          setUserMap(map)
        } catch {}

        try {
          const usage = await api.getMemberUsageStats(http, ws.id)
          setMemberUsage(usage)
        } catch {}

        if (user?.email) {
          try {
            const rawPending = await api.getReceivedInvitations(http, user.email)
            setReceivedInvites(Array.isArray(rawPending) ? rawPending : [])
          } catch {}
        }
      }
    } catch {}
    setIsLoading(false)
  }, [workspaces, members, invitations, http, currentWorkspace?.id, user?.email])

  useEffect(() => { loadPeopleData() }, [loadPeopleData])

  useEffect(() => invitationEvents.subscribe(loadPeopleData), [loadPeopleData])

  const ROLE_PRIORITY: Record<string, number> = { owner: 0, admin: 1, member: 2, viewer: 3 }

  const workspaceMembers = useMemo(() => {
    if (!currentWorkspace?.id) return []
    const allMembers = Array.isArray(members.all) ? members.all : []
    const raw = allMembers.filter((m: any) => m.workspaceId === currentWorkspace.id && !m.projectId)
    const byUser = new Map<string, any>()
    for (const m of raw) {
      const existing = byUser.get(m.userId)
      if (!existing || (ROLE_PRIORITY[m.role] ?? 9) < (ROLE_PRIORITY[existing.role] ?? 9)) {
        byUser.set(m.userId, m)
      }
    }
    return Array.from(byUser.values())
  }, [currentWorkspace?.id, members.all])
  const allInvitations = Array.isArray(invitations.all) ? invitations.all : []
  const sentInvitations = currentWorkspace?.id
    ? allInvitations.filter((i: any) => i.workspaceId === currentWorkspace.id && i.status !== 'cancelled')
    : []

  const filteredMembers = useMemo(() => {
    let result = [...workspaceMembers]
    if (search.trim()) {
      const q = search.toLowerCase()
      result = result.filter((m: any) => {
        const u = userMap[m.userId]
        return (
          (u?.name || '').toLowerCase().includes(q) ||
          (u?.email || '').toLowerCase().includes(q) ||
          (m.userId || '').toLowerCase().includes(q)
        )
      })
    }
    if (roleFilter !== 'all') {
      result = result.filter((m: any) => m.role === roleFilter)
    }
    result.sort((a: any, b: any) => {
      let cmp = 0
      if (sortField === 'name') cmp = (a.userId || '').localeCompare(b.userId || '')
      else if (sortField === 'role') cmp = (a.role || '').localeCompare(b.role || '')
      else if (sortField === 'included') cmp = (memberUsage.included[a.userId] ?? 0) - (memberUsage.included[b.userId] ?? 0)
      else if (sortField === 'free') cmp = (memberUsage.free[a.userId] ?? 0) - (memberUsage.free[b.userId] ?? 0)
      else if (sortField === 'onDemand') cmp = (memberUsage.onDemand[a.userId] ?? 0) - (memberUsage.onDemand[b.userId] ?? 0)
      return sortDir === 'desc' ? -cmp : cmp
    })
    return result
  }, [workspaceMembers, search, roleFilter, sortField, sortDir, memberUsage])

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortDir('asc')
    }
  }

  const currentUserMembership = workspaceMembers.find((m: any) => m.userId === user?.id)
  const canManageMembers = currentUserMembership?.role === 'owner' || currentUserMembership?.role === 'admin'

  const handleChangeRole = async (memberId: string, newRole: 'owner' | 'admin' | 'member' | 'viewer') => {
    try {
      await actions.updateMemberRole(memberId, newRole, user?.id || '')
      setMenuState(null)
      await loadPeopleData()
    } catch {}
  }

  const handleRemoveMember = useCallback(async (memberId: string) => {
    const confirmed = Platform.OS === 'web'
      ? window.confirm('Are you sure you want to remove this member?')
      : true
    if (!confirmed) { setMenuState(null); return }
    try {
      setMenuState(null)
      await actions.removeMember(memberId, user?.id || '')
      await loadPeopleData()
    } catch {
      toast.show({
        placement: 'top',
        duration: 5000,
        render: ({ id }: { id: string }) => (
          <Toast nativeID={id} variant="outline" action="error">
            <ToastTitle>Failed to remove member</ToastTitle>
            <ToastDescription>You may not have permission. Please try again.</ToastDescription>
          </Toast>
        ),
      })
    }
  }, [actions, user?.id, loadPeopleData, toast])

  const [revokeInvitationTarget, setRevokeInvitationTarget] = useState<{
    id: string
    email: string
  } | null>(null)
  const [isRevokingInvitation, setIsRevokingInvitation] = useState(false)

  const confirmRevokeInvitation = useCallback(async () => {
    if (!revokeInvitationTarget) return
    setIsRevokingInvitation(true)
    try {
      await actions.cancelInvitation(revokeInvitationTarget.id)
      setRevokeInvitationTarget(null)
      await loadPeopleData()
    } catch {
    } finally {
      setIsRevokingInvitation(false)
    }
  }, [actions, loadPeopleData, revokeInvitationTarget])

  const builderCount = workspaceMembers.length
  const currentMonth = new Date().toLocaleString('default', { month: 'short' })

  const SUB_TABS: { id: PeopleSubTab; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'invitations', label: 'Invitations' },
  ]

  const SortArrow = ({ field }: { field: SortField }) => (
    <View className="ml-1">
      <Text className={cn('text-[8px]', sortField === field && sortDir === 'asc' ? 'text-foreground' : 'text-muted-foreground/40')}>▲</Text>
      <Text className={cn('text-[8px] -mt-1', sortField === field && sortDir === 'desc' ? 'text-foreground' : 'text-muted-foreground/40')}>▼</Text>
    </View>
  )

  /** Keeps header/body aligned: name flexes separately so usage columns stay evenly spaced, not shoved to the edge. */
  const peopleNameCol = cn(
    'flex-1 min-w-0',
    isMobilePeopleLayout && 'min-w-[200px]',
    !isMobilePeopleLayout && 'max-w-md'
  )
  const peopleMetricsRow = 'flex-row items-center gap-x-5 shrink-0'
  const colRole = 'w-[104px]'
  const colUsage = 'w-[120px]'
  const colActions = 'w-11 items-center justify-center pr-1'

  const memberListTable = (
    <>
      <View className="flex-row items-center justify-between gap-4 px-4 py-2.5 pr-5 border-b border-border bg-muted/30">
        <Pressable
          onPress={() => handleSort('name')}
          className={cn('flex-row items-center', peopleNameCol)}
        >
          <Text className="text-xs font-medium text-muted-foreground">Member</Text>
          <SortArrow field="name" />
        </Pressable>
        <View className={peopleMetricsRow}>
          <Pressable
            onPress={() => handleSort('role')}
            className={cn('flex-row items-center', colRole)}
          >
            <Text className="text-xs font-medium text-muted-foreground">Role</Text>
            <SortArrow field="role" />
          </Pressable>
          <Pressable
            onPress={() => handleSort('included')}
            className={cn('flex-row items-center justify-end', colUsage)}
          >
            <Text className="text-xs font-medium text-muted-foreground text-right">Included Usage</Text>
            <SortArrow field="included" />
          </Pressable>
          <Pressable
            onPress={() => handleSort('free')}
            className={cn('flex-row items-center justify-end', colUsage)}
          >
            <Text className="text-xs font-medium text-muted-foreground text-right">Free Usage</Text>
            <SortArrow field="free" />
          </Pressable>
          <Pressable
            onPress={() => handleSort('onDemand')}
            className={cn('flex-row items-center justify-end', colUsage)}
          >
            <Text className="text-xs font-medium text-muted-foreground text-right">On-Demand Usage</Text>
            <SortArrow field="onDemand" />
          </Pressable>
          <View className={colActions} />
        </View>
      </View>

      {filteredMembers.map((member: any) => {
        const isCurrentUser = member.userId === user?.id
        const avatarColor = ROLE_COLORS[member.role] || 'bg-primary'
        const resolved = userMap[member.userId]
        const mName = isCurrentUser ? (user?.name || user?.email) : (resolved?.name || resolved?.email || member.userId)
        const mEmail = isCurrentUser ? user?.email : (resolved?.email || member.userId)
        const initial = (mName || 'M')[0]?.toUpperCase()
        return (
          <View
            key={member.id}
            className="flex-row items-center justify-between gap-4 px-4 py-3 pr-5 border-b border-border overflow-visible"
          >
            <View className={cn('flex-row items-center gap-3', peopleNameCol)}>
              <View className={cn('h-8 w-8 rounded-full items-center justify-center shrink-0', avatarColor)}>
                <Text className="text-xs font-semibold text-white">{initial}</Text>
              </View>
              <View className="min-w-0 flex-1">
                <View className="flex-row items-center gap-1 flex-wrap">
                  <Text className="text-sm font-medium text-foreground" numberOfLines={2}>
                    {mName}
                  </Text>
                  {isCurrentUser && (
                    <Text className="text-sm text-muted-foreground">(you)</Text>
                  )}
                </View>
                <Text className="text-xs text-muted-foreground" numberOfLines={2}>
                  {mEmail}
                </Text>
              </View>
            </View>

            <View className={peopleMetricsRow}>
              <View className={colRole}>
                {canManageMembers && !isCurrentUser ? (
                  <Pressable
                    onPress={() => setMenuState(
                      menuState?.memberId === member.id && menuState?.view === 'roles'
                        ? null
                        : { memberId: member.id, view: 'roles' }
                    )}
                    className="flex-row items-center gap-1"
                  >
                    <Text className="text-sm text-foreground capitalize">
                      {ROLE_DISPLAY[member.role] || member.role}
                    </Text>
                    <ChevronDown size={12} className="text-muted-foreground" />
                  </Pressable>
                ) : (
                  <Text className="text-sm text-foreground capitalize">
                    {ROLE_DISPLAY[member.role] || member.role}
                  </Text>
                )}
              </View>

              <View className={cn(colUsage, 'items-end')}>
                <Text className="text-sm text-foreground text-right tabular-nums">
                  {formatUsdLabel(memberUsage.included[member.userId] ?? 0)}
                </Text>
              </View>

              <View className={cn(colUsage, 'items-end')}>
                <Text className="text-sm text-foreground text-right tabular-nums">
                  {formatUsdLabel(memberUsage.free[member.userId] ?? 0)}
                </Text>
              </View>

              <View className={cn(colUsage, 'items-end')}>
                <Text className="text-sm text-foreground text-right tabular-nums">
                  {formatUsdLabel(memberUsage.onDemand[member.userId] ?? 0)}
                </Text>
              </View>

              <View className={colActions}>
                {canManageMembers && !isCurrentUser ? (
                  <Pressable
                    onPress={() => setMenuState({ memberId: member.id, view: 'actions' })}
                    className="items-center justify-center min-w-[44px] min-h-[44px] -mr-1"
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Text className="text-muted-foreground">···</Text>
                  </Pressable>
                ) : (
                  <View className="items-center justify-center min-w-[44px] min-h-[44px] -mr-1">
                    <Text className="text-muted-foreground/30">···</Text>
                  </View>
                )}
              </View>
            </View>
          </View>
        )
      })}

      <View className="px-4 py-2.5">
        <Text className="text-xs text-muted-foreground">
          Showing 1-{filteredMembers.length} of {filteredMembers.length}
        </Text>
      </View>
    </>
  )

  const sentInvitationListTable = (
    <>
      <View className="flex-row items-center px-4 py-2.5 border-b border-border bg-muted/30">
        <View className={cn('flex-[2]', isMobilePeopleLayout && 'min-w-[200px] shrink-0')}>
          <Text className="text-xs font-medium text-muted-foreground">Email</Text>
        </View>
        <View className={cn('w-24', isMobilePeopleLayout && 'shrink-0')}>
          <Text className="text-xs font-medium text-muted-foreground">Role</Text>
        </View>
        <View className={cn('w-28', isMobilePeopleLayout && 'shrink-0')}>
          <Text className="text-xs font-medium text-muted-foreground">Sent</Text>
        </View>
        <View className={cn('w-24', isMobilePeopleLayout && 'shrink-0')}>
          <Text className="text-xs font-medium text-muted-foreground">Status</Text>
        </View>
        <View className={cn('w-8', isMobilePeopleLayout && 'shrink-0')} />
      </View>

      {sentInvitations.map((inv: any) => {
        const isExpired = inv.status === 'expired' || Date.now() > inv.expiresAt
        const status = isExpired ? 'expired' : (inv.status as string)
        const isDimmed = status === 'expired' || status === 'declined'
        const badgeVariant = status === 'accepted' ? 'default'
          : status === 'declined' ? 'destructive'
          : status === 'expired' ? 'outline'
          : 'secondary'
        const badgeLabel = status === 'accepted' ? 'Accepted'
          : status === 'declined' ? 'Declined'
          : status === 'expired' ? 'Expired'
          : 'Pending'
        return (
          <View
            key={inv.id}
            className={cn('flex-row items-center px-4 py-3 border-b border-border', isDimmed && 'opacity-50')}
          >
            <View className={cn('flex-[2] min-w-0', isMobilePeopleLayout && 'min-w-[200px] shrink-0')}>
              <Text className={cn('text-sm text-foreground', isDimmed && 'line-through')} numberOfLines={2}>
                {inv.email}
              </Text>
            </View>
            <View className={cn('w-24', isMobilePeopleLayout && 'shrink-0')}>
              <Text className="text-sm text-foreground capitalize">{ROLE_DISPLAY[inv.role] || inv.role}</Text>
            </View>
            <View className={cn('w-28', isMobilePeopleLayout && 'shrink-0')}>
              <Text className="text-sm text-foreground">
                {new Date(inv.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </Text>
            </View>
            <View className={cn('w-24', isMobilePeopleLayout && 'shrink-0')}>
              <Badge variant={badgeVariant}>{badgeLabel}</Badge>
            </View>
            <View className={cn('w-8 items-center', isMobilePeopleLayout && 'shrink-0')}>
              {status === 'pending' && (
                <Pressable
                  onPress={() =>
                    setRevokeInvitationTarget({ id: inv.id, email: inv.email })
                  }
                >
                  <X size={14} className="text-muted-foreground" />
                </Pressable>
              )}
            </View>
          </View>
        )
      })}

      <View className="px-4 py-2.5">
        <Text className="text-xs text-muted-foreground">
          Showing 1-{sentInvitations.length} of {sentInvitations.length}
        </Text>
      </View>
    </>
  )

  const billableSeats = workspaceMembers.filter((m: any) => m.role !== 'viewer').length

  const handleExportMembersCsv = () => {
    if (!currentWorkspace?.id) return
    const url = api.getUsageLogCsvUrl(currentWorkspace.id, { period: '30d' })
    if (typeof window !== 'undefined') {
      window.open(url, '_blank', 'noopener')
    } else {
      Linking.openURL(url)
    }
  }

  return (
    <View className="gap-0">
      {/* Header */}
      <View
        className={cn(
          'flex-row items-start justify-between gap-3 mb-4',
          isMobilePeopleLayout && 'flex-col mb-5',
        )}
      >
        <View className="flex-1">
          <Text className="text-xl font-semibold text-foreground">Members</Text>
          <Text className={cn('text-sm text-muted-foreground mt-1', isMobilePeopleLayout && 'leading-5')}>
            Inviting people to{' '}
            <Text className="font-semibold text-foreground">
              {resolvedWs?.name || currentWorkspace?.name || 'your workspace'}
            </Text>{' '}
            gives access to workspace shared projects and usage.
          </Text>
        </View>
        <Pressable
          onPress={handleExportMembersCsv}
          hitSlop={6}
          className="h-9 w-9 items-center justify-center rounded-md border border-border"
          accessibilityLabel="Export usage CSV"
        >
          <Download size={14} className="text-foreground" />
        </Pressable>
      </View>

      {/* Billable seats stat */}
      <View className="rounded-xl border border-border bg-card p-4 mb-4">
        <View className="flex-row items-center gap-2 mb-1">
          <View className="h-2 w-2 rounded-full bg-emerald-500" />
          <Text className="text-xs font-medium text-foreground">Billable Seats</Text>
        </View>
        <Text className="text-2xl font-bold text-foreground">{billableSeats}</Text>
      </View>

      {/* Sub-tabs */}
      <View className="flex-row border-b border-border mb-4">
        {SUB_TABS.map((tab) => (
          <Pressable
            key={tab.id}
            onPress={() => {
              setSubTab(tab.id)
              setShowRoleFilter(false)
              setMenuState(null)
            }}
            className={cn(
              'px-4 py-2.5 mr-1',
              subTab === tab.id
                ? 'border-b-2 border-foreground'
                : ''
            )}
          >
            <Text
              className={cn(
                'text-sm',
                subTab === tab.id
                  ? 'text-foreground font-medium'
                  : 'text-muted-foreground'
              )}
            >
              {tab.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Controls row */}
      <View
        className={cn(
          'mb-4',
          isMobilePeopleLayout ? 'flex-col gap-3' : 'flex-row items-center gap-2 flex-wrap'
        )}
      >
        {subTab === 'all' && (
          <>
            <View
              className={cn(
                'flex-row items-center border border-border rounded-lg px-3',
                isMobilePeopleLayout ? 'w-full h-11' : 'h-9 flex-1 min-w-[160px]'
              )}
            >
              <Search size={14} className="text-muted-foreground mr-2 shrink-0" />
              <TextInput
                value={search}
                onChangeText={setSearch}
                placeholder="Search..."
                className={cn(
                  'flex-1 text-sm text-foreground placeholder:text-muted-foreground web:outline-none web:min-h-0',
                  isMobilePeopleLayout && 'py-0 leading-5 web:py-1.5'
                )}
                autoCapitalize="none"
                autoCorrect={false}
                textAlignVertical={isMobilePeopleLayout ? 'center' : undefined}
              />
            </View>

            <Pressable
              onPress={() => setShowRoleFilter(true)}
              className={cn(
                'flex-row items-center px-3 border border-border rounded-lg gap-1.5',
                isMobilePeopleLayout ? 'w-full justify-between h-11' : 'h-9'
              )}
            >
              <Text className="text-sm text-foreground">
                {roleFilter === 'all' ? 'All roles' : ROLE_DISPLAY[roleFilter] || roleFilter}
              </Text>
              <ChevronDown size={14} className="text-muted-foreground" />
            </Pressable>
          </>
        )}

        {subTab === 'invitations' && !isMobilePeopleLayout && <View className="flex-1" />}

        <Pressable
          onPress={() => setShowInviteModal(true)}
          className={cn(
            'flex-row items-center gap-1.5 px-3 bg-primary rounded-lg',
            isMobilePeopleLayout ? 'w-full justify-center h-11' : 'h-9'
          )}
        >
          <UserPlus size={14} className="text-primary-foreground" />
          <Text className="text-sm font-medium text-primary-foreground">Invite members</Text>
        </Pressable>
      </View>

      {/* Content based on sub-tab */}
      {subTab === 'all' && (
        <Card>
          <CardContent className="p-0">
            {isLoading ? (
              <View className="py-12 items-center">
                <ActivityIndicator size="small" />
                <Text className="text-sm text-muted-foreground mt-2">Loading members...</Text>
              </View>
            ) : filteredMembers.length === 0 ? (
              <View className="py-12 items-center px-6">
                <Users size={32} className="text-muted-foreground/50 mb-3" />
                <Text className="text-sm text-muted-foreground">
                  {search.trim() || roleFilter !== 'all' ? 'No members match your filters' : 'No members yet. Invite someone to collaborate.'}
                </Text>
              </View>
            ) : (
              <>
                {isMobilePeopleLayout ? (
                  <ScrollView
                    horizontal
                    nestedScrollEnabled
                    showsHorizontalScrollIndicator={Platform.OS !== 'web'}
                    className="w-full max-w-full"
                    style={{ flexGrow: 0 }}
                  >
                    <View>{memberListTable}</View>
                  </ScrollView>
                ) : (
                  memberListTable
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      {subTab === 'invitations' && (
        <View className="gap-4">
          {/* Received invitations */}
          <View>
            <Text className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-1">Received</Text>
            {receivedInvites.length === 0 ? (
              <Card><CardContent className="py-6 items-center"><Text className="text-sm text-muted-foreground">No pending invitations</Text></CardContent></Card>
            ) : (
              <Card>
                <CardContent className="p-0">
                  {receivedInvites.map((inv: any) => (
                    <View key={inv.id} className="p-4 border-b border-border">
                      <View className="flex-row items-center justify-between mb-1">
                        <Text className="text-base font-semibold text-foreground">
                          {inv.workspace?.name || inv.workspaceName || 'Workspace'}
                        </Text>
                        <View className="px-2 py-0.5 rounded bg-muted">
                          <Text className="text-xs text-muted-foreground capitalize">{ROLE_DISPLAY[inv.role] || inv.role}</Text>
                        </View>
                      </View>
                      <Text className="text-sm text-muted-foreground mb-3">You've been invited to join this workspace</Text>
                      <View className="flex-row gap-2">
                        <Pressable
                          disabled={processingInvite?.id === inv.id}
                          onPress={async () => {
                            setProcessingInvite({ id: inv.id, action: 'accept' })
                            try {
                              await actions.acceptInvitation(inv.id, user?.id || '', {
                                workspaceId: inv.workspaceId,
                                role: inv.role,
                                projectId: inv.projectId,
                              })
                              setReceivedInvites((prev) => prev.filter((i: any) => i.id !== inv.id))
                            } catch {}
                            loadPeopleData()
                            invitationEvents.emit()
                            setProcessingInvite(null)
                          }}
                          className={cn('flex-1 h-10 bg-primary rounded-lg items-center justify-center', processingInvite?.id === inv.id && 'opacity-50')}
                        >
                          {processingInvite?.id === inv.id && processingInvite.action === 'accept' ? (
                            <ActivityIndicator size="small" color="white" />
                          ) : (
                            <Text className="text-sm font-medium text-primary-foreground">Accept</Text>
                          )}
                        </Pressable>
                        <Pressable
                          disabled={processingInvite?.id === inv.id}
                          onPress={async () => {
                            setProcessingInvite({ id: inv.id, action: 'decline' })
                            try {
                              await actions.declineInvitation(inv.id)
                              setReceivedInvites((prev) => prev.filter((i: any) => i.id !== inv.id))
                            } catch {}
                            loadPeopleData()
                            invitationEvents.emit()
                            setProcessingInvite(null)
                          }}
                          className={cn('flex-1 h-10 border border-border rounded-lg items-center justify-center', processingInvite?.id === inv.id && 'opacity-50')}
                        >
                          {processingInvite?.id === inv.id && processingInvite.action === 'decline' ? (
                            <ActivityIndicator size="small" />
                          ) : (
                            <Text className="text-sm font-medium text-foreground">Decline</Text>
                          )}
                        </Pressable>
                      </View>
                    </View>
                  ))}
                </CardContent>
              </Card>
            )}
          </View>

          {/* Sent invitations */}
          <View>
            <Text className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-1">Sent</Text>
        <Card>
          <CardContent className="p-0">
            {isLoading ? (
              <View className="py-12 items-center">
                <ActivityIndicator size="small" />
                <Text className="text-sm text-muted-foreground mt-2">Loading...</Text>
              </View>
            ) : sentInvitations.length === 0 ? (
              <View className="py-16 items-center px-6">
                <View className="h-12 w-12 rounded-lg bg-muted/50 items-center justify-center mb-4">
                  <Mail size={24} className="text-muted-foreground/50" />
                </View>
                <Text className="text-base font-medium text-foreground mb-2">No invitations found</Text>
                <Pressable
                  onPress={() => setShowInviteModal(true)}
                  className="flex-row items-center gap-1.5 mt-2 px-4 py-2 border border-border rounded-lg"
                >
                  <UserPlus size={14} className="text-foreground" />
                  <Text className="text-sm font-medium text-foreground">Invite members</Text>
                </Pressable>
              </View>
            ) : (
              <>
                {isMobilePeopleLayout ? (
                  <ScrollView
                    horizontal
                    nestedScrollEnabled
                    showsHorizontalScrollIndicator={Platform.OS !== 'web'}
                    className="w-full max-w-full"
                    style={{ flexGrow: 0 }}
                  >
                    <View>{sentInvitationListTable}</View>
                  </ScrollView>
                ) : (
                  sentInvitationListTable
                )}
              </>
            )}
          </CardContent>
        </Card>
          </View>
        </View>
      )}

      {/* Invite Members Modal */}
      {/* Role Filter Modal */}
      <Modal
        visible={showRoleFilter}
        transparent
        animationType="fade"
        onRequestClose={() => setShowRoleFilter(false)}
      >
        <Pressable
          className="flex-1 bg-black/50 justify-center items-center px-6"
          onPress={() => setShowRoleFilter(false)}
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            className="bg-background rounded-xl p-5 w-full max-w-xs gap-1"
          >
            <Text className="text-base font-semibold text-foreground mb-2">Filter by role</Text>
            {[{ value: 'all', label: 'All roles' }, { value: 'owner', label: 'Owner' }, { value: 'admin', label: 'Admin' }, { value: 'member', label: 'Editor' }, { value: 'viewer', label: 'Viewer' }].map((opt) => (
              <Pressable
                key={opt.value}
                onPress={() => { setRoleFilter(opt.value); setShowRoleFilter(false) }}
                className={cn('py-3 border-b border-border', roleFilter === opt.value && 'bg-accent rounded-md px-3')}
              >
                <Text className={cn('text-sm', roleFilter === opt.value ? 'text-foreground font-medium' : 'text-foreground')}>
                  {opt.label}
                </Text>
              </Pressable>
            ))}
            <Pressable onPress={() => setShowRoleFilter(false)} className="py-2 mt-1">
              <Text className="text-sm text-muted-foreground text-center">Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Invite Members Modal */}
      <InviteMembersModal
        visible={showInviteModal}
        onClose={() => {
          setShowInviteModal(false)
          loadPeopleData()
        }}
        workspaceId={resolvedWs?.id || currentWorkspace?.id || ''}
        workspaceName={resolvedWs?.name || currentWorkspace?.name || ''}
        actions={actions}
      />

      <Modal
        visible={revokeInvitationTarget !== null}
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (!isRevokingInvitation) setRevokeInvitationTarget(null)
        }}
      >
        <Pressable
          className="flex-1 bg-black/50 justify-center items-center px-6"
          onPress={() => {
            if (!isRevokingInvitation) setRevokeInvitationTarget(null)
          }}
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            className="bg-background rounded-xl p-5 w-full max-w-sm gap-3"
          >
            <Text className="text-base font-semibold text-foreground">
              Revoke invitation?
            </Text>
            <Text className="text-sm text-muted-foreground leading-5">
              Cancel this invitation? The invite link will no longer work.
            </Text>
            {revokeInvitationTarget?.email ? (
              <Text className="text-sm font-medium text-foreground">
                {revokeInvitationTarget.email}
              </Text>
            ) : null}
            <View className="flex-row gap-2 justify-end mt-2">
              <Pressable
                disabled={isRevokingInvitation}
                onPress={() => setRevokeInvitationTarget(null)}
                className={cn(
                  'px-4 py-2.5 rounded-lg border border-border items-center justify-center',
                  isRevokingInvitation && 'opacity-50'
                )}
              >
                <Text className="text-sm font-medium text-foreground">Cancel</Text>
              </Pressable>
              <Pressable
                disabled={isRevokingInvitation}
                onPress={confirmRevokeInvitation}
                className={cn(
                  'px-4 py-2.5 rounded-lg bg-destructive items-center justify-center',
                  isRevokingInvitation && 'opacity-50'
                )}
              >
                <Text className="text-sm font-medium text-destructive-foreground">
                  {isRevokingInvitation ? 'Revoking…' : 'Revoke'}
                </Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Member Action Modal */}
      <Modal
        visible={menuState !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setMenuState(null)}
      >
        <Pressable
          className="flex-1 bg-black/50 justify-center items-center px-6"
          onPress={() => setMenuState(null)}
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            className="bg-background rounded-xl p-5 w-full max-w-xs gap-3"
          >
            {menuState?.view === 'actions' && (
              <>
                <Text className="text-base font-semibold text-foreground mb-1">
                  Member actions
                </Text>
                <Pressable
                  onPress={() => {
                    if (menuState) setMenuState({ ...menuState, view: 'roles' })
                  }}
                  className="py-3 border-b border-border"
                >
                  <Text className="text-sm text-foreground">Change role</Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    if (menuState) handleRemoveMember(menuState.memberId)
                  }}
                  className="py-3"
                >
                  <Text className="text-sm text-destructive">Remove member</Text>
                </Pressable>
              </>
            )}
            {menuState?.view === 'roles' && (
              <>
                <Text className="text-base font-semibold text-foreground mb-1">
                  Select role
                </Text>
                {(['owner', 'admin', 'member', 'viewer'] as const).map((r) => {
                  const activeMember = workspaceMembers.find((m: any) => m.id === menuState?.memberId)
                  const isActive = activeMember?.role === r
                  return (
                    <Pressable
                      key={r}
                      onPress={() => {
                        if (menuState) handleChangeRole(menuState.memberId, r)
                      }}
                      className={cn('py-3 border-b border-border', isActive && 'bg-accent rounded-md px-3')}
                    >
                      <Text className={cn('text-sm', isActive ? 'text-foreground font-medium' : 'text-foreground')}>
                        {ROLE_DISPLAY[r]}
                      </Text>
                    </Pressable>
                  )
                })}
              </>
            )}
            <Pressable onPress={() => setMenuState(null)} className="py-2 mt-1">
              <Text className="text-sm text-muted-foreground text-center">Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  )
})

/** RN Modal on iOS needs explicit layout + `overFullScreen`; NativeWind flex inside Modal is unreliable on device. */
const inviteMembersModalStyles = StyleSheet.create({
  nativeOverlay: {
    flex: 1,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  centerRegion: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    width: '100%',
  },
  card: {
    width: '100%',
    maxWidth: 448,
    zIndex: 10,
    overflow: 'visible',
  },
  cardCompact: {
    maxHeight: '92%',
  },
})

function InviteMembersModal({
  visible,
  onClose,
  workspaceId,
  workspaceName,
  actions,
}: {
  visible: boolean
  onClose: () => void
  workspaceId: string
  workspaceName: string
  actions: ReturnType<typeof useDomainActions>
}) {
  const { width, height } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const compactInviteModal = width < SETTINGS_WIDE_BREAKPOINT
  /** iOS: never put actions as sibling below a bounded ScrollView — RCTScrollView draws a hard edge that clips/overlaps the footer. */
  const nativeCompactScrollMaxHeight = Math.min(height * 0.78, 560)

  const workspaces = useWorkspaceCollection()
  const { subscription } = useBillingData(workspaceId)
  const [emailInput, setEmailInput] = useState('')
  const [role, setRole] = useState<string>('member')
  const [showRolePicker, setShowRolePicker] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const INVITE_ROLES = [
    { value: 'member', label: 'Editor' },
    { value: 'admin', label: 'Admin' },
    { value: 'viewer', label: 'Viewer' },
  ]

  const selectedRoleLabel = INVITE_ROLES.find((r) => r.value === role)?.label || 'Editor'

  const parseEmails = (input: string): string[] => {
    return input
      .split(/[,;\s]+/)
      .map((e) => e.trim().toLowerCase())
      .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
  }

  const validEmails = parseEmails(emailInput)
  const canSubmit = validEmails.length > 0 && !isSubmitting

  /**
   * Per-seat monthly cost on the active subscription. We only compute it when
   * there's an active paid subscription; on free/Basic the seat hint is a
   * no-op. The actual seat sync happens server-side in
   * `syncSeatsFromMembership` once an invitee accepts.
   */
  const seatHint = useMemo(() => {
    const planId = subscription?.planId?.toLowerCase?.() ?? ''
    const isPaidSeatPlan = planId.startsWith('pro') || planId.startsWith('business')
    if (!isPaidSeatPlan) return null
    const pricing = planId.startsWith('business') ? PLAN_PRICING.business : PLAN_PRICING.pro
    const interval = subscription?.billingInterval === 'annual' ? 'annual' : 'monthly'
    const perSeatMonthly = interval === 'annual' ? Math.round(pricing.annual / 12) : pricing.monthly
    const incomingCount = validEmails.length
    return {
      perSeatMonthly,
      incomingCount,
      planLabel: planId.startsWith('business') ? 'Business' : 'Pro',
    }
  }, [subscription, validEmails.length])

  const handleSubmit = async () => {
    if (!canSubmit) return
    let resolvedWsId = workspaceId
    if (!resolvedWsId) {
      const ws = workspaces.all[0]
      resolvedWsId = ws?.id || ''
    }
    if (!resolvedWsId) {
      setError('Workspace not loaded yet. Please close and try again.')
      return
    }
    setIsSubmitting(true)
    setError(null)
    try {
      for (const email of validEmails) {
        await actions.sendInvitation({ email, role: role as any, workspaceId: resolvedWsId })
      }
      setEmailInput('')
      setRole('member')
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send invitation')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleClose = () => {
    setEmailInput('')
    setRole('member')
    setError(null)
    setShowRolePicker(false)
    onClose()
  }

  const inviteFormFields = (
    <>
      <View className="flex-row items-center justify-between mb-1">
        <Text className="text-lg font-semibold text-foreground">Invite members</Text>
        <Pressable onPress={handleClose} className="p-1 -mr-1">
          <X size={20} className="text-muted-foreground" />
        </Pressable>
      </View>

      <Text className="text-sm text-muted-foreground mb-5">
        Invite members to your workspace by email
      </Text>

      {error && (
        <View className="bg-destructive/10 border border-destructive/30 rounded-lg p-3 mb-4">
          <Text className="text-destructive text-sm">{error}</Text>
        </View>
      )}

      <Text className="text-sm font-medium text-foreground mb-1.5">Email</Text>
      <View className="border border-border rounded-lg mb-4">
        <TextInput
          value={emailInput}
          onChangeText={(t) => { setEmailInput(t); setError(null) }}
          placeholder="example1@example.com, example2@example.com"
          autoCapitalize="none"
          autoCorrect={false}
          editable={!isSubmitting}
          className="px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground web:outline-none"
        />
      </View>

      <Text className="text-sm font-medium text-foreground mb-1.5">Role</Text>
      <View className={cn('relative z-50', compactInviteModal ? 'mb-4' : 'mb-6')}>
        <Pressable
          onPress={() => setShowRolePicker(!showRolePicker)}
          className="flex-row items-center justify-between h-10 px-3 rounded-lg border border-border"
        >
          <Text className="text-sm text-foreground">{selectedRoleLabel}</Text>
          <ChevronDown size={14} className="text-muted-foreground" />
        </Pressable>
        {showRolePicker && (
          <View className={cn(
            'bg-background border border-border rounded-lg shadow-lg overflow-hidden',
            Platform.OS === 'web' ? 'absolute top-11 left-0 right-0 z-50' : 'mt-1'
          )}>
            {INVITE_ROLES.map((r) => (
              <Pressable
                key={r.value}
                onPress={() => { setRole(r.value); setShowRolePicker(false) }}
                className={cn('px-3 py-2.5', role === r.value && 'bg-accent')}
              >
                <Text className={cn('text-sm', role === r.value ? 'text-foreground font-medium' : 'text-foreground')}>
                  {r.label}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
      </View>

      {seatHint && (
        <View className={cn('rounded-lg bg-muted/40 border border-border p-3', compactInviteModal ? 'mb-4' : 'mb-6')}>
          <Text className="text-xs text-foreground">
            {seatHint.incomingCount > 0
              ? `Each accepted invite adds a ${seatHint.planLabel} seat at ${formatUsd(seatHint.perSeatMonthly)}/seat/mo (prorated immediately). Pending invites are not billed — ${seatHint.incomingCount} seat${seatHint.incomingCount === 1 ? '' : 's'} would be added if all accept.`
              : `Each accepted invite adds a ${seatHint.planLabel} seat at ${formatUsd(seatHint.perSeatMonthly)}/seat/mo (prorated immediately). Pending invites are not billed.`}
          </Text>
        </View>
      )}
    </>
  )

  const inviteFormActions = (
    <View className="flex-row gap-3">
      <Pressable
        onPress={handleClose}
        disabled={isSubmitting}
        className="flex-1 h-10 rounded-lg border border-border items-center justify-center"
      >
        <Text className="text-sm font-medium text-foreground">Cancel</Text>
      </Pressable>
      <Pressable
        onPress={handleSubmit}
        disabled={!canSubmit}
        className={cn(
          'flex-1 h-10 rounded-lg items-center justify-center',
          canSubmit ? 'bg-primary' : 'bg-muted'
        )}
      >
        {isSubmitting ? (
          <ActivityIndicator size="small" color="white" />
        ) : (
          <Text className={cn('text-sm font-medium', canSubmit ? 'text-primary-foreground' : 'text-muted-foreground')}>
            Invite
          </Text>
        )}
      </Pressable>
    </View>
  )

  const inviteModalInner = compactInviteModal ? (
    Platform.OS === 'web' ? (
      <>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          nestedScrollEnabled
          className="max-h-[420px]"
        >
          {inviteFormFields}
        </ScrollView>
        {inviteFormActions}
      </>
    ) : (
      <ScrollView
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        keyboardDismissMode="interactive"
        style={{ maxHeight: nativeCompactScrollMaxHeight }}
        contentContainerClassName="pb-1"
      >
        <View>
          {inviteFormFields}
          <View className="mt-5">{inviteFormActions}</View>
        </View>
      </ScrollView>
    )
  ) : (
    <>
      {inviteFormFields}
      {inviteFormActions}
    </>
  )

  const inviteCardWeb = (
    <Pressable
      onPress={(e) => e.stopPropagation()}
      className={cn(
        'bg-background rounded-xl w-full max-w-md shadow-xl overflow-visible z-10',
        compactInviteModal ? 'p-5 max-h-[92%]' : 'p-6'
      )}
    >
      {inviteModalInner}
    </Pressable>
  )

  if (Platform.OS === 'web') {
    return (
      <Modal visible={visible} transparent animationType="fade" onRequestClose={handleClose}>
        <Pressable
          onPress={handleClose}
          className={cn(
            'flex-1 bg-black/50 justify-center',
            compactInviteModal ? 'px-4 py-6' : 'items-center justify-center px-6'
          )}
        >
          {inviteCardWeb}
        </Pressable>
      </Modal>
    )
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      presentationStyle={Platform.OS === 'ios' ? 'overFullScreen' : undefined}
      statusBarTranslucent
      onRequestClose={handleClose}
    >
      <View style={inviteMembersModalStyles.nativeOverlay}>
        <Pressable style={inviteMembersModalStyles.backdrop} onPress={handleClose} />
        <View
          style={[
            inviteMembersModalStyles.centerRegion,
            {
              paddingTop: insets.top,
              paddingBottom: insets.bottom,
              paddingHorizontal: compactInviteModal ? 16 : 24,
            },
          ]}
          pointerEvents="box-none"
        >
          <View
            style={[
              inviteMembersModalStyles.card,
              compactInviteModal ? inviteMembersModalStyles.cardCompact : null,
            ]}
            className={cn(
              'bg-background rounded-xl shadow-xl',
              compactInviteModal ? 'p-5' : 'p-6'
            )}
          >
            {inviteModalInner}
          </View>
        </View>
      </View>
    </Modal>
  )
}

// ============================================================================
// BILLING TAB
// ============================================================================

function BillingTab() {
  const router = useRouter()
  const http = useDomainHttp()
  const workspace = useActiveWorkspace()
  const { subscription, effectiveBalance, refetchUsageWallet } = useBillingData(workspace?.id)
  const [instanceLabel, setInstanceLabel] = useState<string | null>(null)
  const [spendLimitOpen, setSpendLimitOpen] = useState(false)

  useEffect(() => {
    if (!workspace?.id) return
    let cancelled = false
    api.getWorkspaceInstance(http, workspace.id).then((inst: any) => {
      if (cancelled || !inst) return
      const size = inst.size ?? 'micro'
      const labels: Record<string, string> = { micro: 'Micro (0.5 CPU, 2 GB)', small: 'Small (1 CPU, 4 GB)', medium: 'Medium (2 CPU, 8 GB)', large: 'Large (4 CPU, 16 GB)', xlarge: 'XLarge (8 CPU, 32 GB)' }
      setInstanceLabel(labels[size] ?? size)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [http, workspace?.id])

  const planId = subscription?.planId?.toLowerCase() ?? 'free'
  const planLabel = planId.startsWith('enterprise')
    ? 'Enterprise'
    : planId.startsWith('business')
      ? 'Business'
      : planId.startsWith('pro')
        ? 'Pro'
        : planId.startsWith('basic')
          ? 'Basic'
          : 'Free'
  const hasActiveSubscription = subscription?.status === 'active' || subscription?.status === 'trialing'
  const subSeats = subscription?.seats ?? 1
  const totalUsd = getIncludedUsdCapacityForDisplay({
    planId: hasActiveSubscription ? subscription?.planId : undefined,
    seats: subSeats,
    remainingTotal: effectiveBalance?.total,
    monthlyIncludedAllocationUsd: effectiveBalance?.monthlyIncludedAllocationUsd,
  })
  const usdRemaining = effectiveBalance?.total ?? 0
  const usdUsed = Math.max(0, totalUsd - usdRemaining)
  const usagePct = totalUsd > 0 ? Math.min(100, Math.round((usdUsed / totalUsd) * 100)) : 0
  const canUseOverage = hasActiveSubscription

  if (!workspace?.id) {
    return (
      <View className="py-12 items-center">
        <Text className="text-sm text-muted-foreground">No workspace selected</Text>
      </View>
    )
  }

  return (
    <View className="gap-4">
      <View>
        <Text className="text-lg font-bold text-foreground mb-1">Billing</Text>
        <Text className="text-xs text-muted-foreground">
          Manage your plan and on-demand spending cap. For detailed analytics, see the Usage tab.
        </Text>
      </View>

      <Card>
        <CardContent className="p-4 gap-3">
          <View className="flex-row items-center justify-between">
            <View className="gap-1">
              <Text className="text-xs text-muted-foreground">Current Plan</Text>
              <View className="flex-row items-center gap-2">
                <Text className="text-lg font-bold text-foreground">{planLabel}</Text>
                {hasActiveSubscription && (
                  <Badge variant="secondary">
                    <Text className="text-xs">{subscription?.status === 'trialing' ? 'Trial' : 'Active'}</Text>
                  </Badge>
                )}
              </View>
            </View>
            <CreditCard size={20} className="text-muted-foreground" />
          </View>

          <Separator />

          <View className="gap-2">
            <View className="flex-row items-center justify-between">
              <Text className="text-sm text-muted-foreground">Usage</Text>
              <Text className="text-sm font-medium text-foreground">
                {formatUsd(effectiveBalance?.total ?? 0)} / {formatUsd(totalUsd)}
              </Text>
            </View>
            <View className="h-2 bg-muted rounded-full overflow-hidden">
              <View
                className={cn('h-full rounded-full', usagePct > 80 ? 'bg-destructive' : 'bg-primary')}
                style={{ width: `${Math.max(0, 100 - usagePct)}%` }}
              />
            </View>
            <Text className="text-xs text-muted-foreground">
              {effectiveBalance
                ? `${formatUsd(effectiveBalance.dailyIncludedUsd)} daily + ${formatUsd(effectiveBalance.monthlyIncludedUsd)} monthly remaining`
                : 'Loading...'}
            </Text>
            {effectiveBalance?.overageEnabled && effectiveBalance.overageAccumulatedUsd > 0 && (
              <Text className="text-xs text-muted-foreground">
                Overage this period: {formatUsd(effectiveBalance.overageAccumulatedUsd)} (billed in trust blocks: $100 → $500)
              </Text>
            )}
          </View>

          {instanceLabel && (
            <>
              <Separator />
              <View className="flex-row items-center justify-between">
                <Text className="text-sm text-muted-foreground">Instance</Text>
                <Text className="text-sm font-medium text-foreground">{instanceLabel}</Text>
              </View>
            </>
          )}

          <Separator />

          <View className="flex-row items-center gap-2">
            <Button
              variant="default"
              onPress={() => router.push('/(app)/billing' as any)}
              className="flex-1"
            >
              <Text className="text-primary-foreground font-medium">Manage Plan</Text>
            </Button>
            <Button
              variant="outline"
              onPress={() => router.push('/(app)/settings?tab=analytics' as any)}
              className="flex-1"
            >
              <Text className="text-foreground font-medium">View detailed usage</Text>
            </Button>
          </View>
        </CardContent>
      </Card>

      {canUseOverage && (
        <Card>
          <CardContent className="p-4 gap-3">
            <View className="gap-1">
              <Text className="text-sm font-semibold text-foreground">Spending limit</Text>
              <Text className="text-xs text-muted-foreground">
                You keep working when your included usage runs out — we charge the saved card
                in trust blocks billed at provider cost + 20%. Blocks start at $100 and step
                up by $100 as you build payment history (capped at $500 per charge).
              </Text>
            </View>

            <View className="flex-row items-center justify-between">
              <View>
                <Text className="text-xs text-muted-foreground">Monthly spending cap</Text>
                <Text className="text-base font-semibold text-foreground">
                  {effectiveBalance?.overageHardLimitUsd != null
                    ? formatUsd(effectiveBalance.overageHardLimitUsd)
                    : 'No cap'}
                </Text>
              </View>
              <Button variant="outline" onPress={() => setSpendLimitOpen(true)}>
                <Text className="text-foreground font-medium text-sm">Set Limit</Text>
              </Button>
            </View>
          </CardContent>
        </Card>
      )}

      <SetSpendLimitDialog
        visible={spendLimitOpen}
        onClose={() => setSpendLimitOpen(false)}
        workspaceId={workspace.id}
        currentLimitUsd={effectiveBalance?.overageHardLimitUsd ?? null}
        accumulatedUsageUsd={effectiveBalance?.overageAccumulatedUsd ?? 0}
        onSaved={() => refetchUsageWallet()}
      />
    </View>
  )
}

// ============================================================================
// WORKSPACE ANALYTICS TAB
// ============================================================================

interface SpendTimeseriesPayload {
  days: { date: string; byModel: Record<string, number>; total: number }[]
  totals: {
    totalSpendUsd: number
    totalIncludedUsd: number
    totalOnDemandUsd: number
    uniqueModels: number
  }
  models: string[]
  groupBy: 'model' | 'user' | 'source'
  metric: 'spend' | 'tokens' | 'requests'
}

function fmtUsd(n: number): string {
  if (n === 0) return '$0.00'
  if (n < 0.01) return `$${n.toFixed(4)}`
  if (n < 1000) return `$${n.toFixed(2)}`
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
}

function buildSeries(payload: SpendTimeseriesPayload | null): StackedSeries[] {
  if (!payload) return []
  return payload.models.map((m, i) => ({
    id: m,
    label: m,
    color: STACKED_PALETTE[i % STACKED_PALETTE.length],
  }))
}

function WorkspaceAnalyticsTab() {
  const http = useDomainHttp()
  const router = useRouter()
  const workspace = useActiveWorkspace()
  const workspaceId = workspace?.id
  const { localMode } = usePlatformConfig()
  const { subscription, effectiveBalance, refetchUsageWallet } = useBillingData(workspaceId)

  const planId = subscription?.planId?.toLowerCase() ?? ''
  const isBusinessOrHigher = localMode || planId.startsWith('business') || planId.startsWith('enterprise')

  const [period, setPeriod] = useState<AnalyticsPeriod>('7d')
  const [logPage, setLogPage] = useState(1)
  const [groupBy, setGroupBy] = useState<'model' | 'user' | 'source'>('model')
  const [metric, setMetric] = useState<'spend' | 'tokens' | 'requests'>('spend')
  const [spendLimitOpen, setSpendLimitOpen] = useState(false)

  const [usageSummary, setUsageSummary] = useState<{ data: UsageSummaryData | null; loading: boolean }>({ data: null, loading: true })
  const [usageLog, setUsageLog] = useState<{ data: UsageLogData | null; loading: boolean }>({ data: null, loading: true })
  const [spend, setSpend] = useState<{ data: SpendTimeseriesPayload | null; loading: boolean }>({ data: null, loading: true })
  const [usage, setUsage] = useState<{ data: UsageBreakdownData | null; loading: boolean }>({ data: null, loading: true })
  const [chatStats, setChatStats] = useState<{ data: ChatAnalyticsData | null; loading: boolean }>({ data: null, loading: true })

  const loadAll = useCallback(async () => {
    if (!workspaceId) return
    const p = { period }

    setUsageSummary(s => ({ ...s, loading: true }))
    setUsageLog(s => ({ ...s, loading: true }))
    setSpend(s => ({ ...s, loading: true }))

    const basicFetches = [
      api.getWorkspaceAnalytics<UsageSummaryData>(http, workspaceId, 'usage-summary', p).catch(() => null),
      api.getWorkspaceAnalytics<UsageLogData>(http, workspaceId, 'usage-log', { ...p, page: String(logPage), limit: '50' }).catch(() => null),
      api.getWorkspaceAnalytics<SpendTimeseriesPayload>(http, workspaceId, 'spend-timeseries', { ...p, groupBy, metric }).catch(() => null),
    ] as const

    if (isBusinessOrHigher) {
      setUsage(s => ({ ...s, loading: true }))
      setChatStats(s => ({ ...s, loading: true }))

      const [uSum, uLog, sp, us, ch] = await Promise.all([
        ...basicFetches,
        api.getWorkspaceAnalytics<UsageBreakdownData>(http, workspaceId, 'usage', p).catch(() => null),
        api.getWorkspaceAnalytics<ChatAnalyticsData>(http, workspaceId, 'chat', p).catch(() => null),
      ])

      setUsageSummary({ data: uSum, loading: false })
      setUsageLog({ data: uLog, loading: false })
      setSpend({ data: sp, loading: false })
      setUsage({ data: us, loading: false })
      setChatStats({ data: ch, loading: false })
    } else {
      const [uSum, uLog, sp] = await Promise.all(basicFetches)
      setUsageSummary({ data: uSum, loading: false })
      setUsageLog({ data: uLog, loading: false })
      setSpend({ data: sp, loading: false })
    }
  }, [http, workspaceId, period, logPage, groupBy, metric, isBusinessOrHigher])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  if (!workspaceId) {
    return (
      <View className="py-12 items-center">
        <Text className="text-sm text-muted-foreground">No workspace selected</Text>
      </View>
    )
  }

  // ─── Progress card data ──────────────────────────────────
  const subSeats = subscription?.seats ?? 1
  const includedTotal = getIncludedUsdCapacityForDisplay({
    planId: subscription?.planId,
    seats: subSeats,
    remainingTotal: effectiveBalance?.total,
    monthlyIncludedAllocationUsd: effectiveBalance?.monthlyIncludedAllocationUsd,
  })
  const includedRemaining = effectiveBalance?.total ?? includedTotal
  const includedUsed = Math.max(0, includedTotal - includedRemaining)
  const includedPct = includedTotal > 0 ? Math.min(100, (includedUsed / includedTotal) * 100) : 0

  const onDemandUsed = effectiveBalance?.overageAccumulatedUsd ?? 0
  const onDemandLimit = effectiveBalance?.overageHardLimitUsd ?? null
  const onDemandPct = onDemandLimit && onDemandLimit > 0
    ? Math.min(100, (onDemandUsed / onDemandLimit) * 100)
    : (onDemandUsed > 0 ? Math.min(100, onDemandUsed / 1000 * 100) : 0)

  const resetDateLabel = (() => {
    const ts = (subscription as any)?.currentPeriodEnd
    if (!ts) return 'Resets monthly'
    const d = ts instanceof Date ? ts : new Date(ts)
    if (isNaN(d.getTime())) return 'Resets monthly'
    return `Resets ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`
  })()

  // ─── Summary cards ───────────────────────────────────────
  const totalSpend = spend.data?.totals.totalSpendUsd ?? 0
  const includedSpend = spend.data?.totals.totalIncludedUsd ?? 0
  const onDemandSpend = spend.data?.totals.totalOnDemandUsd ?? 0

  const series = buildSeries(spend.data)
  const chartDays = (spend.data?.days ?? []).map((d) => ({
    date: d.date,
    values: d.byModel,
  }))

  const csvUrl = api.getUsageLogCsvUrl(workspaceId, { period })
  const handleExportCsv = () => {
    if (typeof window !== 'undefined') {
      window.open(csvUrl, '_blank', 'noopener')
    } else {
      Linking.openURL(csvUrl)
    }
  }

  return (
    <View className="gap-4">
      <View>
        <Text className="text-lg font-bold text-foreground mb-1">Usage</Text>
        <Text className="text-xs text-muted-foreground">
          {localMode
            ? 'Token usage and agent activity for this workspace'
            : 'Usage metrics and spend for this workspace'}
        </Text>
      </View>

      {/* Progress cards */}
      <View className="flex-row flex-wrap gap-3">
        <BillingProgressCard
          title="Your included usage"
          current={fmtUsd(includedUsed)}
          total={fmtUsd(includedTotal)}
          percent={includedPct}
          tone={includedPct > 90 ? 'destructive' : 'primary'}
          helper={resetDateLabel}
        />
        <BillingProgressCard
          title="On-Demand Usage (Team)"
          current={fmtUsd(onDemandUsed)}
          total={onDemandLimit != null ? fmtUsd(onDemandLimit) : null}
          percent={onDemandPct}
          tone={onDemandPct > 80 ? 'warning' : 'primary'}
          helper="Pay for extra usage beyond your plan limits."
          subHelper={
            onDemandLimit != null
              ? `${fmtUsd(onDemandLimit)} team spend cap`
              : 'No spend cap set'
          }
          actionLabel="Set Limit"
          onActionPress={() => setSpendLimitOpen(true)}
        />
      </View>

      {/* Date range pills */}
      <View className="flex-row items-center justify-between flex-wrap gap-3">
        <DateRangePills value={period} onChange={setPeriod} />
      </View>

      {/* Summary cards */}
      <View className="flex-row flex-wrap gap-2">
        <StatCard label="Total spend" value={fmtUsd(totalSpend)} icon={Coins} />
        <StatCard label="Included" value={fmtUsd(includedSpend)} icon={CreditCard} />
        <StatCard label="On-demand" value={fmtUsd(onDemandSpend)} icon={Zap} />
      </View>

      {/* Team Usage chart */}
      <Card>
        <CardContent className="p-4 gap-3">
          <View className="flex-row items-center justify-between flex-wrap gap-2">
            <View>
              <Text className="text-sm font-semibold text-foreground">Team Usage</Text>
              <Text className="text-xs text-muted-foreground">
                Team usage per day across this billing period
              </Text>
            </View>
            <View className="flex-row items-center gap-2">
              <GroupBySelect value={groupBy} onChange={setGroupBy} />
              <MetricSelect value={metric} onChange={setMetric} />
            </View>
          </View>

          {spend.loading ? (
            <View className="h-[260px] items-center justify-center">
              <ActivityIndicator />
            </View>
          ) : (
            <>
              <StackedAreaChart
                days={chartDays}
                series={series}
                height={260}
                formatY={(n) =>
                  metric === 'spend'
                    ? fmtUsd(n)
                    : n >= 1000
                      ? `${(n / 1000).toFixed(1)}K`
                      : String(Math.round(n))
                }
                formatTooltip={(n) =>
                  metric === 'spend' ? fmtUsd(n) : n.toLocaleString()
                }
              />
              <StackedAreaLegend series={series} />
            </>
          )}
        </CardContent>
      </Card>

      {/* Event log + CSV export */}
      <View className="gap-2">
        <View className="flex-row items-center justify-end">
          <Pressable
            onPress={handleExportCsv}
            className="flex-row items-center gap-1.5 px-3 h-8 rounded-md border border-border bg-background active:bg-muted"
          >
            <Download size={14} className="text-foreground" />
            <Text className="text-xs font-medium text-foreground">Export CSV</Text>
          </Pressable>
        </View>
        <UsageTableSection
          summaryData={usageSummary.data}
          logData={usageLog.data}
          summaryLoading={usageSummary.loading}
          logLoading={usageLog.loading}
          onLogPageChange={setLogPage}
          logPage={logPage}
          isLocalMode={localMode}
        />
      </View>

      {/* Leaderboard (Image 2) */}
      <UsageLeaderboard data={usageSummary.data} loading={usageSummary.loading} />

      {isBusinessOrHigher && (
        <>
          <ChatAnalyticsSection data={chatStats.data} loading={chatStats.loading} />
          <UsageBreakdownSection data={usage.data} loading={usage.loading} />
        </>
      )}

      <SetSpendLimitDialog
        visible={spendLimitOpen}
        onClose={() => setSpendLimitOpen(false)}
        workspaceId={workspaceId}
        currentLimitUsd={onDemandLimit}
        accumulatedUsageUsd={onDemandUsed}
        onSaved={() => {
          refetchUsageWallet()
        }}
      />
    </View>
  )
}

function GroupBySelect({
  value,
  onChange,
}: {
  value: 'model' | 'user' | 'source'
  onChange: (v: 'model' | 'user' | 'source') => void
}) {
  const [open, setOpen] = useState(false)
  const labels: Record<typeof value, string> = {
    model: 'Group By: Model',
    user: 'Group By: User',
    source: 'Group By: Source',
  }
  return (
    <View style={{ zIndex: 100 }}>
      <Pressable
        onPress={() => setOpen((o) => !o)}
        className="flex-row items-center gap-1.5 px-3 h-8 rounded-md border border-border bg-background"
      >
        <Text className="text-xs text-foreground">{labels[value]}</Text>
        <ChevronDown size={12} className="text-muted-foreground" />
      </Pressable>
      {open && (
        <View
          style={{ zIndex: 100 }}
          className="absolute top-9 right-0 z-50 min-w-[160px] rounded-md border border-border bg-popover shadow-md"
        >
          {(['model', 'user', 'source'] as const).map((v) => (
            <Pressable
              key={v}
              onPress={() => { onChange(v); setOpen(false) }}
              className={cn('px-3 py-2', v === value && 'bg-muted')}
            >
              <Text className="text-xs text-foreground">{labels[v]}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  )
}

function MetricSelect({
  value,
  onChange,
}: {
  value: 'spend' | 'tokens' | 'requests'
  onChange: (v: 'spend' | 'tokens' | 'requests') => void
}) {
  const [open, setOpen] = useState(false)
  const labels: Record<typeof value, string> = {
    spend: 'Metric: Spend',
    tokens: 'Metric: Tokens',
    requests: 'Metric: Requests',
  }
  return (
    <View style={{ zIndex: 100 }}>
      <Pressable
        onPress={() => setOpen((o) => !o)}
        className="flex-row items-center gap-1.5 px-3 h-8 rounded-md border border-border bg-background"
      >
        <Text className="text-xs text-foreground">{labels[value]}</Text>
        <ChevronDown size={12} className="text-muted-foreground" />
      </Pressable>
      {open && (
        <View
          style={{ zIndex: 100 }}
          className="absolute top-9 right-0 z-50 min-w-[160px] rounded-md border border-border bg-popover shadow-md"
        >
          {(['spend', 'tokens', 'requests'] as const).map((v) => (
            <Pressable
              key={v}
              onPress={() => { onChange(v); setOpen(false) }}
              className={cn('px-3 py-2', v === value && 'bg-muted')}
            >
              <Text className="text-xs text-foreground">{labels[v]}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  )
}

// ============================================================================
// COST OPTIMIZER TAB
// ============================================================================

function WorkspaceCostTab() {
  const http = useDomainHttp()
  const workspace = useActiveWorkspace()
  const workspaceId = workspace?.id

  const fetchCostAnalytics = useCallback(
    <T,>(endpoint: string, params?: Record<string, string>) =>
      api.getWorkspaceCostAnalytics<T>(http, workspaceId!, endpoint, params),
    [http, workspaceId],
  )

  const postCostAnalytics = useCallback(
    <T,>(endpoint: string, body: Record<string, unknown>) =>
      api.postWorkspaceCostAnalytics<T>(http, workspaceId!, endpoint, body),
    [http, workspaceId],
  )

  const fetchSubagentOverrides = useCallback(
    () => api.listSubagentOverrides(http, workspaceId!),
    [http, workspaceId],
  )

  const putSubagentOverride = useCallback(
    (body: { agentType: string; model: string; provider?: string | null; projectId?: string | null }) =>
      api.upsertSubagentOverride(http, workspaceId!, body),
    [http, workspaceId],
  )

  const deleteSubagentOverride = useCallback(
    (agentType: string, projectId?: string | null) =>
      api.deleteSubagentOverride(http, workspaceId!, agentType, projectId),
    [http, workspaceId],
  )

  if (!workspaceId) {
    return (
      <View className="py-12 items-center">
        <Text className="text-sm text-muted-foreground">No workspace selected</Text>
      </View>
    )
  }

  return (
    <CostAnalyticsTab
      workspaceId={workspaceId}
      fetchCostAnalytics={fetchCostAnalytics}
      postCostAnalytics={postCostAnalytics}
      fetchSubagentOverrides={fetchSubagentOverrides}
      putSubagentOverride={putSubagentOverride}
      deleteSubagentOverride={deleteSubagentOverride}
    />
  )
}

// ============================================================================
// MAIN SETTINGS PAGE
// ============================================================================

const SettingsContent = observer(function SettingsContent({ 
  activeTab, 
  localMode = false 
}: { 
  activeTab: TabId, 
  localMode?: boolean 
}) {
  const isLocal = localMode
  return (
    <>
      {activeTab === 'workspace' && <WorkspaceSettingsTab />}
      {activeTab === 'people' && !isLocal && <PeopleTab />}
      {activeTab === 'integrations' && <IntegrationsTab />}
      {activeTab === 'account' && <AccountTab />}
      {activeTab === 'security' && <SecuritySettingsPanel />}
      {activeTab === 'compute' && !isLocal && <ComputeTab />}
      {activeTab === 'billing' && !isLocal && <BillingTab />}
      {activeTab === 'analytics' && <WorkspaceAnalyticsTab />}
      {activeTab === 'costs' && <WorkspaceCostTab />}
      {activeTab === 'support' && <BugReportTab />}
    </>
  )
})

export default observer(function SettingsPage() {
  const router = useRouter()
  const params = useLocalSearchParams<{ tab?: string }>()
  const { width } = useWindowDimensions()
  const isWide = width >= SETTINGS_WIDE_BREAKPOINT
  const { user } = useAuth()
  const currentWorkspace = useActiveWorkspace()
  const { features, localMode } = usePlatformConfig()

  const [activeTab, setActiveTab] = useState<TabId>(
    () => {
      const requested = params.tab as TabId
      return ALL_TAB_IDS.includes(requested) ? requested : 'workspace'
    }
  )

  useEffect(() => {
    const isLocal = localMode || !features.billing
    if (activeTab === 'people' && isLocal) setActiveTab('workspace')
    if (activeTab === 'compute' && isLocal) setActiveTab('workspace')
    if (activeTab === 'billing' && isLocal) setActiveTab('workspace')
  }, [activeTab, features.billing, localMode])

  const workspaceName = currentWorkspace?.name || ''
  const userName = user?.name || ''

  if (isWide) {
    return (
      <View className="flex-1 bg-background flex-row">
        <SettingsSidebar
          activeTab={activeTab}
          onTabChange={setActiveTab}
          workspaceName={workspaceName}
          userName={userName}
          showBilling={features.billing}
          localMode={localMode}
        />
        <ScrollView
          className="flex-1"
          contentContainerClassName="px-12 pt-6 pb-[60px]"
          showsVerticalScrollIndicator={false}
        >
          <View>
            <View className="flex-row items-center justify-end mb-1">
              <Pressable
                onPress={() => Linking.openURL(DOCS_URL)}
                className="flex-row items-center gap-1.5"
              >
                <ExternalLink size={14} className="text-muted-foreground" />
                <Text className="text-sm text-muted-foreground">Docs</Text>
              </Pressable>
            </View>
            <SettingsContent activeTab={activeTab} localMode={localMode || !features.billing} />
          </View>
        </ScrollView>
      </View>
    )
  }

  return (
    <View className="flex-1 bg-background">
      <View className="flex-row items-center gap-3 px-4 py-3 border-b border-border">
        <Pressable onPress={() => router.canGoBack() ? router.back() : router.replace('/(app)/projects')}>
          <ArrowLeft size={20} className="text-foreground" />
        </Pressable>
        <Text className="text-xl font-bold text-foreground">Settings</Text>
      </View>

      <View className="z-10 bg-background">
        <TabBar
          activeTab={activeTab}
          onTabChange={setActiveTab}
          showBilling={features.billing}
          localMode={localMode || !features.billing}
        />
      </View>

      <ScrollView
        className="flex-1"
        contentContainerClassName="p-4 pb-10"
        showsVerticalScrollIndicator={false}
      >
        <SettingsContent activeTab={activeTab} localMode={localMode || !features.billing} />
      </ScrollView>
    </View>
  )
})
