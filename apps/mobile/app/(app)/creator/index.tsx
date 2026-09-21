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
import { Cloud, Sparkles } from 'lucide-react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
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
  const insets = useSafeAreaInsets()

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
      <View
        className="px-5 pb-3 border-b border-border bg-background"
        style={{ paddingTop: Math.max(insets.top, 12) }}
      >
        <View className="flex-row items-center gap-2 mb-2">
          <View className="h-7 w-7 rounded-full bg-primary/10 items-center justify-center">
            <Sparkles size={14} className="text-primary" />
          </View>
          <Text className="text-[11px] uppercase tracking-[1.5px] font-semibold text-muted-foreground">
            Creator studio
          </Text>
        </View>
        <Text className="text-2xl font-semibold tracking-tight text-foreground">
          Build your earning engine
        </Text>
        <Text className="text-sm text-muted-foreground mt-1 leading-5">
          Publish useful agents or share Shogo with your audience.
        </Text>
        {showTabs ? (
          <View className="flex-row gap-1 mt-4 rounded-xl bg-muted/60 p-1 self-start">
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
        'px-4 py-2 rounded-lg',
        active ? 'bg-background' : 'active:opacity-70',
      )}
    >
      <Text className={cn('text-sm', active ? 'text-foreground font-semibold' : 'text-muted-foreground font-medium')}>
        {label}
      </Text>
    </Pressable>
  )
}

function SignInToCloud() {
  return (
    <View className="flex-1 bg-background items-center justify-center px-8 pb-10">
      <View className="h-14 w-14 rounded-2xl bg-primary/10 items-center justify-center mb-5">
        <Cloud size={26} className="text-primary" />
      </View>
      <Text className="text-xl font-semibold text-foreground text-center mb-2">
        Sign in to Shogo Cloud
      </Text>
      <Text className="text-sm text-muted-foreground text-center max-w-sm leading-6">
        Publishing and Referrals both run on your Shogo Cloud account. Connect
        this desktop app to publish agents to the marketplace and track your
        referral and content earnings from here.
      </Text>
    </View>
  )
}
