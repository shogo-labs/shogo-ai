// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useState } from 'react'
import { ActivityIndicator, Linking, Platform, Pressable, View } from 'react-native'
import { AlertCircle, CreditCard, ExternalLink, RefreshCw } from 'lucide-react-native'
import {
  Badge,
  Button,
  Card,
  CardContent,
  Separator,
  cn,
} from '@shogo/shared-ui/primitives'
import {
  Text,
  accountSheetIcon,
} from './account-sheet-chrome'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { useCloudBillingSummary } from '../../hooks/useCloudBillingSummary'
import { useCloudSignIn } from '../../hooks/useCloudSignIn'
import {
  formatUsd,
  getPlanDisplayName,
  getUsageLimitNotice,
  getWindowDisplays,
} from '../../lib/billing-config'
import { SetSpendLimitDialog } from '../billing/SetSpendLimitDialog'

const Alert = accountSheetIcon(AlertCircle)
const CardIcon = accountSheetIcon(CreditCard)
const External = accountSheetIcon(ExternalLink)
const Refresh = accountSheetIcon(RefreshCw)

function openUrl(url: string | undefined) {
  if (!url) return
  Linking.openURL(url).catch((error) => {
    console.warn('[LocalCloudBilling] failed to open cloud billing URL:', error)
  })
}

export function LocalCloudBillingTab() {
  const workspace = useActiveWorkspace()
  const {
    summary,
    isLoading,
    error,
    refresh: refreshBilling,
    setSpendingLimit,
  } = useCloudBillingSummary()
  const {
    loginState,
    loginError,
    startSignIn,
  } = useCloudSignIn()
  const [spendLimitOpen, setSpendLimitOpen] = useState(false)

  const handleSignIn = useCallback(async () => {
    const signedIn = await startSignIn()
    if (signedIn) await refreshBilling()
  }, [refreshBilling, startSignIn])

  if (isLoading && !summary) {
    return (
      <View className="py-12 items-center gap-3">
        <ActivityIndicator />
        <Text className="text-sm text-muted-foreground">Loading Shogo Cloud billing…</Text>
      </View>
    )
  }

  if (!summary?.signedIn) {
    return (
      <View className="gap-4">
        <View>
          <Text className="text-lg font-bold text-foreground mb-1">Billing</Text>
          <Text className="text-xs text-muted-foreground">
            Manage your Shogo Cloud plan and spending limit from this local app.
          </Text>
        </View>
        <Card>
          <CardContent className="p-4 gap-3">
            <Text className="text-sm font-semibold text-foreground">
              Connect a Shogo Cloud API key
            </Text>
            <Text className="text-sm text-muted-foreground">
              Link this installation to Shogo Cloud to view usage, set a spending
              limit, or upgrade the linked workspace.
            </Text>
            {(loginError || error) && (
              <Text className="text-xs text-destructive">{loginError || error}</Text>
            )}
            <Button onPress={handleSignIn} disabled={loginState === 'connecting'}>
              <Text className="text-primary-foreground font-medium">
                {loginState === 'connecting' ? 'Minting key…' : 'Connect'}
              </Text>
            </Button>
            {Platform.OS === 'web' && (
              <Text className="text-[11px] text-muted-foreground">
                Browser previews cannot mint the key. Use Shogo Desktop or run
                `shogo login` in a terminal.
              </Text>
            )}
          </CardContent>
        </Card>
      </View>
    )
  }

  const plan = summary.plan
  const planId = typeof plan?.planId === 'string' ? plan.planId : 'free'
  const planLabel = getPlanDisplayName(planId)
  const hasPaidTier = plan?.paidTier === true
  const windows = plan?.usageWindows as Parameters<typeof getWindowDisplays>[0]
  const windowDisplays = getWindowDisplays(windows)
  const usageNotice = getUsageLimitNotice({
    atLimit: windowDisplays.fiveHour.atLimit || windowDisplays.weekly.atLimit,
    overage: {
      enabled: plan?.overageEnabled === true,
      active: plan?.overageActive,
      accumulatedUsd: plan?.overageAccumulatedUsd ?? 0,
    },
    countdown: windowDisplays.weekly.atLimit
      ? windowDisplays.weekly.countdown
      : windowDisplays.fiveHour.countdown,
  })

  return (
    <View className="gap-4">
      <View>
        <Text className="text-lg font-bold text-foreground mb-1">Billing</Text>
        <Text className="text-xs text-muted-foreground">
          Shogo Cloud billing for {summary.workspace?.name || 'your linked workspace'}.
        </Text>
      </View>

      {summary.cloudKeyRejected && (
        <Card className="border-destructive">
          <CardContent className="p-4 gap-3">
            <View className="flex-row items-center gap-2">
              <Alert size={17} className="text-destructive" />
              <Text className="text-sm font-semibold text-foreground">
                Shogo Cloud API key needs attention
              </Text>
            </View>
            <Text className="text-sm text-muted-foreground">
              This device key was revoked or expired. Mint a fresh API key to
              manage the linked cloud workspace.
            </Text>
            <Button variant="outline" onPress={handleSignIn} disabled={loginState === 'connecting'}>
              <Text className="text-foreground font-medium">
                {loginState === 'connecting' ? 'Minting key…' : 'Mint a fresh API key'}
              </Text>
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-4 gap-3">
          <View className="flex-row items-center justify-between">
            <View className="gap-1">
              <Text className="text-xs text-muted-foreground">Cloud plan</Text>
              <View className="flex-row items-center gap-2">
                <Text className="text-lg font-bold text-foreground">{planLabel}</Text>
                {plan?.status && (
                  <Badge variant="secondary">
                    <Text className="text-xs">
                      {plan.status === 'trialing' ? 'Trial' : plan.status === 'active' ? 'Active' : plan.status}
                    </Text>
                  </Badge>
                )}
              </View>
            </View>
            <CardIcon size={20} className="text-muted-foreground" />
          </View>

          <Text className="text-xs text-muted-foreground">
            {summary.email || 'Cloud account linked'}
          </Text>
          <Separator />

          {(['fiveHour', 'weekly'] as const).map((key) => {
            const display = windowDisplays[key]
            const label = key === 'fiveHour' ? '5-hour usage' : 'Weekly usage'
            return (
              <View key={key} className="gap-1">
                <View className="flex-row items-center justify-between">
                  <Text className="text-sm text-muted-foreground">{label}</Text>
                  <Text className="text-sm font-medium text-foreground">
                    {display.uncapped ? 'Unlimited' : `${display.pct}% used`}
                  </Text>
                </View>
                {!display.uncapped && (
                  <View className="h-2 bg-muted rounded-full overflow-hidden">
                    <View
                      className={cn(
                        'h-full rounded-full',
                        display.pct >= 100 ? 'bg-destructive' : 'bg-primary',
                      )}
                      style={{ width: `${display.pct}%` }}
                    />
                  </View>
                )}
                {!display.uncapped && display.countdown && (
                  <Text className="text-xs text-muted-foreground">
                    {display.pct >= 100
                      ? `Limit reached — resets in ${display.countdown}`
                      : `Resets in ${display.countdown}`}
                  </Text>
                )}
              </View>
            )
          })}

          {usageNotice && (
            <Text className="text-xs text-foreground font-medium">{usageNotice.text}</Text>
          )}

          <Separator />
          <View className="flex-row items-center gap-2">
            <Button className="flex-1" onPress={() => openUrl(summary.upgradeUrl)}>
              <Text className="text-primary-foreground font-medium">Upgrade plan</Text>
            </Button>
            <Button variant="outline" className="flex-1" onPress={() => openUrl(summary.manageUrl)}>
              <External size={14} className="text-foreground" />
              <Text className="text-foreground font-medium">Manage on web</Text>
            </Button>
          </View>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 gap-3">
          <View className="flex-row items-center justify-between">
            <View className="gap-1">
              <Text className="text-sm font-semibold text-foreground">Spending limit</Text>
              <Text className="text-xs text-muted-foreground">
                Cap on usage beyond your included Shogo Cloud plan.
              </Text>
            </View>
            <Text className="text-base font-semibold text-foreground">
              {plan?.overageHardLimitUsd != null
                ? formatUsd(plan.overageHardLimitUsd)
                : 'No cap'}
            </Text>
          </View>
          {hasPaidTier ? (
            <Button variant="outline" onPress={() => setSpendLimitOpen(true)}>
              <Text className="text-foreground font-medium">Set spending limit</Text>
            </Button>
          ) : (
            <Text className="text-xs text-muted-foreground">
              A paid plan is required for usage beyond included limits. Use
              Upgrade plan above to continue.
            </Text>
          )}
        </CardContent>
      </Card>

      {workspace?.id && (
        <SetSpendLimitDialog
          visible={spendLimitOpen}
          onClose={() => setSpendLimitOpen(false)}
          workspaceId={workspace.id}
          currentLimitUsd={plan?.overageHardLimitUsd ?? null}
          accumulatedUsageUsd={plan?.overageAccumulatedUsd ?? 0}
          onSave={setSpendingLimit}
        />
      )}

      <Pressable
        onPress={() => void refreshBilling()}
        className="flex-row items-center justify-center gap-2 py-2"
      >
        <Refresh size={14} className="text-muted-foreground" />
        <Text className="text-xs text-muted-foreground">Refresh cloud billing</Text>
      </Pressable>
    </View>
  )
}
