// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AppProfilePage - Mobile (Expo)
 *
 * User profile page showing account info, workspace memberships, and billing/spend.
 */

import { useState, useEffect, useCallback } from 'react'
import { View, Text, ScrollView, Pressable, ActivityIndicator, useWindowDimensions, Platform } from 'react-native'
import { useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import {
  ArrowLeft,
  User,
  Building2,
  Mail,
  Calendar,
  CreditCard,
  Zap,
  TrendingUp,
  Settings,
  BarChart3,
  MessageSquare,
  Clock,
} from 'lucide-react-native'
import { useAuth } from '../../contexts/auth'
import {
  useDomain,
  useWorkspaceCollection,
  useMemberCollection,
  useDomainHttp,
  type IDomainStore,
} from '../../contexts/domain'
import { useBillingData } from '@shogo/shared-app/hooks'
import { CompactUsageWindows } from '../../components/billing/UsageWindows'
import { usePlatformConfig } from '../../lib/platform-config'
import { api } from '../../lib/api'
import {
  type AnalyticsPeriod,
  type UsageLogData,
  type UsageSummaryData,
  PeriodSelector,
  StatCard,
  UsageTableSection,
} from '../../components/analytics/SharedAnalytics'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  Button,
  Badge,
  Skeleton,
  cn,
} from '@shogo/shared-ui/primitives'

export default observer(function ProfilePage() {
  const router = useRouter()
  const { user, isLoading } = useAuth()
  const store = useDomain() as IDomainStore
  const workspaces = useWorkspaceCollection()
  const members = useMemberCollection()
  const { width } = useWindowDimensions()
  const isNativePhone = Platform.OS !== 'web' && width < 600
  const profileMaxWidth = width >= 1280 ? 880 : width >= 768 ? 760 : width
  const profilePadH = width >= 768 ? 24 : 16

  const currentUser = user

  const userMemberships = currentUser
    ? members.all.filter((m: any) => m.userId === currentUser.id) || []
    : []

  const userWorkspaceIds = userMemberships.map((m: any) => m.workspaceId)
  const userWorkspaces = currentUser
    ? workspaces.all.filter((w: any) => userWorkspaceIds.includes(w.id)) || []
    : []

  const getRoleForWorkspace = (workspaceId: string) => {
    const membership = userMemberships.find(
      (m: any) => m.workspace?.id === workspaceId
    )
    return membership?.role || 'member'
  }

  if (isLoading) {
    return (
      <View className="flex-1 bg-background p-6">
        <View className="gap-6 max-w-lg mx-auto w-full">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-64 w-full" />
        </View>
      </View>
    )
  }

  if (!currentUser) {
    return (
      <View className="flex-1 bg-background p-6">
        <View className="items-center justify-center py-12">
          <User size={48} className="text-muted-foreground mb-4" />
          <Text className="text-xl font-semibold text-foreground mb-2">
            Not Logged In
          </Text>
          <Text className="text-muted-foreground mb-4 text-center">
            Please log in to view your profile.
          </Text>
          <Button variant="outline" onPress={() => router.replace('/(app)')}>
            <View className="flex-row items-center gap-2">
              <ArrowLeft size={16} className="text-foreground" />
              <Text className="text-sm font-medium text-foreground">
                Back to App
              </Text>
            </View>
          </Button>
        </View>
      </View>
    )
  }

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{
        paddingTop: 16,
        paddingBottom: 40,
        paddingHorizontal: profilePadH,
        maxWidth: profileMaxWidth,
        width: '100%',
        alignSelf: 'center',
      }}
      showsVerticalScrollIndicator={false}
    >
      {/* Header */}
      <View className="flex-row items-center gap-3 mb-6">
        <Pressable
          onPress={() => router.back()}
          hitSlop={8}
          className={isNativePhone ? "h-11 w-11 items-center justify-center" : undefined}
        >
          <ArrowLeft size={isNativePhone ? 22 : 20} className="text-foreground" />
        </Pressable>
        <Text className="text-2xl font-bold text-foreground">Profile</Text>
      </View>

      {/* User Info Card */}
      <Card className="mb-6">
        <CardHeader>
          <View className="flex-row items-center gap-2">
            <User size={isNativePhone ? 22 : 20} className="text-card-foreground" />
            <CardTitle className={isNativePhone ? "text-xl" : "text-lg"}>Account Information</CardTitle>
          </View>
          <CardDescription className={isNativePhone ? "text-sm" : undefined}>Your account details</CardDescription>
        </CardHeader>
        <CardContent className="gap-4">
          <View className={cn("flex-row gap-3", isNativePhone ? "items-start" : "items-center")}>
            <Mail size={isNativePhone ? 20 : 16} className="text-muted-foreground" />
            {isNativePhone ? (
              <View className="min-w-0 flex-1">
                <Text className="text-sm text-muted-foreground">Email</Text>
                <Text className="text-base font-medium text-foreground" selectable>
                  {currentUser.email}
                </Text>
              </View>
            ) : (
              <>
                <Text className="text-sm text-muted-foreground">Email:</Text>
                <Text className="text-sm font-medium text-foreground">
                  {currentUser.email}
                </Text>
              </>
            )}
          </View>
          {currentUser.name && (
            <View className={cn("flex-row gap-3", isNativePhone ? "items-start" : "items-center")}>
              <User size={isNativePhone ? 20 : 16} className="text-muted-foreground" />
              {isNativePhone ? (
                <View className="min-w-0 flex-1">
                  <Text className="text-sm text-muted-foreground">Name</Text>
                  <Text className="text-base font-medium text-foreground">
                    {currentUser.name}
                  </Text>
                </View>
              ) : (
                <>
                  <Text className="text-sm text-muted-foreground">Name:</Text>
                  <Text className="text-sm font-medium text-foreground">
                    {currentUser.name}
                  </Text>
                </>
              )}
            </View>
          )}
        </CardContent>
      </Card>

      {/* Workspaces Card */}
      <Card className="mb-6">
        <CardHeader>
          <View className="flex-row items-center gap-2">
            <Building2 size={isNativePhone ? 22 : 20} className="text-card-foreground" />
            <CardTitle className={isNativePhone ? "text-xl" : "text-lg"}>Workspaces</CardTitle>
          </View>
          <CardDescription className={isNativePhone ? "text-sm" : undefined}>
            Workspaces you belong to ({userWorkspaces.length})
          </CardDescription>
        </CardHeader>
        <CardContent>
          {userWorkspaces.length === 0 ? (
            <View className="items-center py-8">
              <Building2
                size={isNativePhone ? 36 : 32}
                className="text-muted-foreground mb-2 opacity-50"
              />
              <Text className={cn("text-muted-foreground text-center", isNativePhone ? "text-base" : "text-sm")}>
                You don't belong to any workspaces yet.
              </Text>
              <Text className={cn("text-muted-foreground mt-1 text-center", isNativePhone ? "text-sm" : "text-xs")}>
                Create one using the workspace switcher in the header.
              </Text>
            </View>
          ) : (
            <View className="gap-3">
              {userWorkspaces.map((workspace: any) => (
                <WorkspaceCard
                  key={workspace.id}
                  workspace={workspace}
                  role={getRoleForWorkspace(workspace.id)}
                  onManage={() => router.push('/(app)/settings')}
                  comfortable={isNativePhone}
                />
              ))}
            </View>
          )}
        </CardContent>
      </Card>

      {/* Usage & Spend */}
      <UserUsageSection />
    </ScrollView>
  )
})

interface UserOverviewData {
  usageEvents: number
  totalSpendUsd: number
  chatSessions: number
}

function UserUsageSection() {
  const http = useDomainHttp()
  const { features, localMode } = usePlatformConfig()
  const { width } = useWindowDimensions()
  const comfortable = Platform.OS !== 'web' && width < 600

  const [period, setPeriod] = useState<AnalyticsPeriod>('30d')
  const [logPage, setLogPage] = useState(1)

  const [overview, setOverview] = useState<{ data: UserOverviewData | null; loading: boolean }>({ data: null, loading: true })
  const [usageSummary, setUsageSummary] = useState<{ data: UsageSummaryData | null; loading: boolean }>({ data: null, loading: true })
  const [usageLog, setUsageLog] = useState<{ data: UsageLogData | null; loading: boolean }>({ data: null, loading: true })

  const loadAll = useCallback(async () => {
    const p = { period }

    setOverview(s => ({ ...s, loading: true }))
    setUsageSummary(s => ({ ...s, loading: true }))
    setUsageLog(s => ({ ...s, loading: true }))

    const [ov, uSum, uLog] = await Promise.all([
      api.getMyAnalytics<UserOverviewData>(http, 'overview', p).catch(() => null),
      api.getMyAnalytics<UsageSummaryData>(http, 'usage-summary', p).catch(() => null),
      api.getMyAnalytics<UsageLogData>(http, 'usage-log', { ...p, page: String(logPage), limit: '50' }).catch(() => null),
    ])

    setOverview({ data: ov, loading: false })
    setUsageSummary({ data: uSum, loading: false })
    setUsageLog({ data: uLog, loading: false })
  }, [http, period, logPage])

  useEffect(() => {
    if (features.billing) loadAll()
  }, [features.billing, loadAll])

  if (!features.billing) return null

  return (
    <Card className="mb-6">
      <CardHeader>
        <View className="flex-row items-center gap-2">
          <BarChart3 size={comfortable ? 22 : 20} className="text-card-foreground" />
          <CardTitle className={comfortable ? "text-xl" : "text-lg"}>Usage & Spend</CardTitle>
        </View>
        <CardDescription className={comfortable ? "text-sm" : undefined}>Your usage across all workspaces</CardDescription>
      </CardHeader>
      <CardContent className="gap-4">
        <PeriodSelector value={period} onChange={setPeriod} comfortable={comfortable} />

        {/* Overview stats */}
        <View className="flex-row flex-wrap gap-2">
          <StatCard label="Sessions" value={overview.data?.chatSessions} icon={MessageSquare} comfortable={comfortable} />
          <StatCard label="Usage Events" value={overview.data?.usageEvents} icon={Zap} comfortable={comfortable} />
          <StatCard
            label="Spend"
            value={overview.data?.totalSpendUsd !== undefined ? `$${overview.data.totalSpendUsd.toFixed(2)}` : undefined}
            icon={CreditCard}
            comfortable={comfortable}
          />
        </View>

        {/* Usage summary + event log */}
        <UsageTableSection
          summaryData={usageSummary.data}
          logData={usageLog.data}
          summaryLoading={usageSummary.loading}
          logLoading={usageLog.loading}
          onLogPageChange={setLogPage}
          logPage={logPage}
          title="Your AI Usage"
          isLocalMode={localMode}
        />
      </CardContent>
    </Card>
  )
}

const WorkspaceCard = observer(function WorkspaceCard({
  workspace,
  role,
  onManage,
  comfortable = false,
}: {
  workspace: any
  role: string
  onManage: () => void
  comfortable?: boolean
}) {
  const { features } = usePlatformConfig()
  const {
    subscription,
    effectiveBalance,
    usageWindows,
  } = useBillingData(features.billing ? workspace.id : undefined)

  return (
    <View className="p-4 rounded-lg border border-border bg-card">
      <View className={cn(comfortable ? "gap-3" : "flex-row items-center justify-between mb-3")}>
        <View className={comfortable ? undefined : "flex-1"}>
          <Text className={cn("font-medium text-foreground", comfortable ? "text-base" : "text-sm")}>
            {workspace.name}
          </Text>
          <Text
            className={cn("text-muted-foreground", comfortable ? "text-sm mt-0.5" : "text-xs")}
            numberOfLines={1}
            ellipsizeMode="middle"
          >
            {workspace.slug}
          </Text>
        </View>
        <View className={cn("flex-row items-center gap-2", comfortable && "flex-wrap")}>
          <Badge variant={role === 'owner' ? 'default' : 'secondary'}>
            <Text className={comfortable ? "text-xs" : undefined}>{role}</Text>
          </Badge>
          <Button variant="ghost" size={comfortable ? "lg" : "sm"} onPress={onManage}>
            <View className="flex-row items-center gap-1">
              <Settings size={comfortable ? 16 : 14} className="text-foreground" />
              <Text className={cn("font-medium text-foreground", comfortable ? "text-sm" : "text-xs")}>
                Manage
              </Text>
            </View>
          </Button>
        </View>
      </View>

      {/* Billing Section for Workspace Owners */}
      {features.billing && role === 'owner' && (
        <View className="pt-3 border-t border-border">
          {subscription ? (
            <View className="gap-3">
              {/* Plan & Usage Row */}
              <View className="flex-row items-center justify-between">
                <View className="flex-row items-center gap-2">
                  <CreditCard size={16} className="text-muted-foreground" />
                  <Text className="text-sm font-medium text-foreground capitalize">
                    {subscription.planId} Plan
                  </Text>
                  <Badge
                    variant={
                      subscription.isActive ? 'default' : 'secondary'
                    }
                  >
                    <Text className="text-[10px]">{subscription.status}</Text>
                  </Badge>
                </View>
                <Button
                  variant="outline"
                  size="sm"
                  onPress={() => {}}
                >
                  <View className="flex-row items-center gap-1">
                    <TrendingUp size={12} className="text-foreground" />
                    <Text className="text-xs font-medium text-foreground">
                      Manage Plan
                    </Text>
                  </View>
                </Button>
              </View>

              {/* Usage Display — time-gated rolling windows */}
              <View className="bg-muted/50 rounded-lg p-3 gap-2.5">
                <View className="flex-row items-center gap-1">
                  <Zap size={16} className="text-yellow-500" />
                  <Text className="text-sm font-medium text-foreground">
                    Usage
                  </Text>
                </View>
                <CompactUsageWindows
                  windows={usageWindows}
                  overage={effectiveBalance
                    ? { enabled: effectiveBalance.overageEnabled, accumulatedUsd: effectiveBalance.overageAccumulatedUsd }
                    : undefined}
                />
                {effectiveBalance?.overageEnabled && effectiveBalance.overageAccumulatedUsd > 0 ? (
                  <View className="flex-row items-center justify-between">
                    <Text className="text-xs text-muted-foreground">Overage</Text>
                    <Text className="text-xs font-medium text-foreground">
                      ${effectiveBalance.overageAccumulatedUsd.toFixed(2)}
                    </Text>
                  </View>
                ) : null}
                <Text className="text-[10px] text-muted-foreground">
                  {subscription.daysRemaining} days until renewal
                </Text>
              </View>
            </View>
          ) : (
            <View className="flex-row items-center justify-between">
              <Text className="text-sm text-muted-foreground">
                No active subscription
              </Text>
              <Button size="sm" onPress={() => {}}>
                <View className="flex-row items-center gap-1">
                  <TrendingUp
                    size={12}
                    className="text-primary-foreground"
                  />
                  <Text className="text-xs font-medium text-primary-foreground">
                    View Plans
                  </Text>
                </View>
              </Button>
            </View>
          )}
        </View>
      )}
    </View>
  )
})
