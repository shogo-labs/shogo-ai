// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unified Creator hub.
 *
 * One home for everything a creator does on Shogo:
 *   - "Publishing" → marketplace creator dashboard (publish agents, earnings,
 *     payouts) — backed by /api/marketplace/creator/*.
 *   - "Referrals"  → affiliate/referral dashboard (referral link, commissions,
 *     content CPM) — backed by /api/affiliates/me/*.
 *
 * The two systems keep SEPARATE data models + Stripe payouts on the backend;
 * this screen only merges them in the UI. Each sub-dashboard renders as an
 * embedded panel (its own onboarding CTA, no back-header — the hub owns the
 * header + tabs).
 *
 * Availability:
 *   - Cloud: both panels are always available.
 *   - Local/desktop: only available when signed in to Shogo Cloud
 *     (`shogoKeyConnected`), since both panels proxy to the cloud account.
 */

import { useMemo, useState } from 'react'
import { View, Text, Pressable } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Cloud } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { usePlatformConfig } from '../../../lib/platform-config'
import { CreatorPublishingPanel } from '../marketplace/creator/index'
import { AffiliateReferralPanel } from '../affiliate/index'

type HubTab = 'publish' | 'refer'

function normalizeTab(raw: string | undefined): HubTab | null {
  if (raw === 'publish' || raw === 'refer') return raw
  return null
}

export default function CreatorHub() {
  const router = useRouter()
  const params = useLocalSearchParams<{ tab?: string }>()
  const { localMode, shogoKeyConnected, features } = usePlatformConfig()

  // Both panels proxy to the cloud account; in local/desktop mode they only
  // work when signed in to Shogo Cloud.
  const cloudReady = !localMode || !!shogoKeyConnected
  const canPublish = features.marketplace || (localMode && !!shogoKeyConnected)
  const canRefer = cloudReady

  const requested = normalizeTab(params.tab)
  const defaultTab: HubTab = canPublish ? 'publish' : 'refer'
  const [activeTab, setActiveTab] = useState<HubTab>(requested ?? defaultTab)

  // If the requested tab isn't available, fall back to whatever is.
  const effectiveTab: HubTab = useMemo(() => {
    if (activeTab === 'publish' && !canPublish) return 'refer'
    if (activeTab === 'refer' && !canRefer) return 'publish'
    return activeTab
  }, [activeTab, canPublish, canRefer])

  const selectTab = (tab: HubTab) => {
    setActiveTab(tab)
    router.setParams({ tab })
  }

  // Local/desktop without a connected cloud key: nothing to show.
  if (localMode && !shogoKeyConnected) {
    return <SignInToCloud />
  }

  const showTabs = canPublish && canRefer

  return (
    <View className="flex-1 bg-background">
      <View className="px-4 pt-3 pb-2 border-b border-border">
        <Text className="text-lg font-semibold text-foreground">Creator</Text>
        <Text className="text-xs text-muted-foreground mt-0.5">
          Publish agents and refer Shogo — one home for everything you create and earn.
        </Text>
        {showTabs ? (
          <View className="flex-row gap-1 mt-3 rounded-lg bg-muted/40 p-1 self-start">
            <TabButton label="Publishing" active={effectiveTab === 'publish'} onPress={() => selectTab('publish')} />
            <TabButton label="Referrals" active={effectiveTab === 'refer'} onPress={() => selectTab('refer')} />
          </View>
        ) : null}
      </View>

      <View className="flex-1">
        {effectiveTab === 'publish' && canPublish ? (
          <CreatorPublishingPanel embedded />
        ) : (
          <AffiliateReferralPanel embedded />
        )}
      </View>
    </View>
  )
}

function TabButton({
  label,
  active,
  onPress,
}: {
  label: string
  active: boolean
  onPress: () => void
}) {
  return (
    <Pressable
      onPress={onPress}
      className={cn(
        'px-4 py-1.5 rounded-md',
        active ? 'bg-background border border-border' : 'active:opacity-70',
      )}
    >
      <Text className={cn('text-sm', active ? 'text-foreground font-semibold' : 'text-muted-foreground')}>
        {label}
      </Text>
    </Pressable>
  )
}

function SignInToCloud() {
  return (
    <View className="flex-1 bg-background items-center justify-center px-8">
      <View className="h-14 w-14 rounded-full bg-primary/10 items-center justify-center mb-4">
        <Cloud size={26} className="text-primary" />
      </View>
      <Text className="text-lg font-semibold text-foreground text-center mb-1">
        Sign in to Shogo Cloud
      </Text>
      <Text className="text-sm text-muted-foreground text-center max-w-sm leading-5">
        The Creator hub manages your cloud marketplace listings and referral
        earnings. Connect this desktop app to your Shogo Cloud account to
        publish agents and track referrals from here.
      </Text>
    </View>
  )
}
