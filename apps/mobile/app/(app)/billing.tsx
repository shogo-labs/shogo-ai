// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AppBillingPage - Mobile (Expo)
 *
 * Workspace billing and plan management matching staging design:
 * - Current plan card with workspace avatar
 * - Credits remaining card
 * - Monthly/Annual billing toggle
 * - Pro / Business / Enterprise plan cards with credit selectors
 */

import { useState, useEffect, useCallback } from 'react'
import {
  View,
  Text,
  ScrollView,
  Pressable,
  Linking,
  Platform,
} from 'react-native'
import * as WebBrowser from 'expo-web-browser'
import * as ExpoLinking from 'expo-linking'
import { useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import {
  ArrowLeft,
  Building2,
  CheckCircle2,
  Info,
  Sparkles,
  Zap,
  Crown,
  Cpu,
  HardDrive,
  Server,
  BarChart3,
} from 'lucide-react-native'
import { useAuth } from '../../contexts/auth'
import { useWorkspaceCollection, useDomainHttp } from '../../contexts/domain'
import { api } from '../../lib/api'
import type { RegionalPricingResponse } from '../../lib/api'
import { getRewardfulReferral } from '../../lib/rewardful'
import { trackInitiateCheckout, trackPurchase } from '../../lib/tracking'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { useDomainActions } from '@shogo/shared-app/domain'
import { useBillingData } from '@shogo/shared-app/hooks'
import {
  BASIC_TIER,
  BASIC_FEATURES,
  PRO_TIERS,
  BUSINESS_TIERS,
  PRO_FEATURES,
  BUSINESS_FEATURES,
  ENTERPRISE_FEATURES,
  BASE_TIER_CREDITS,
  getTotalCreditsForPlan,
  formatCredits,
  formatCurrencyPrice,
} from '../../lib/billing-config'
import { TierSelector } from '../../components/billing/TierSelector'
import { FeatureList } from '../../components/billing/FeatureList'
import {
  INSTANCE_SIZES,
  getInstanceSize,
  getDisplayPrice,
  formatStorageBytes,
  formatCpuPercent,
  formatMemoryGb,
  type InstanceSizeName,
} from '../../lib/instance-config'
import type { HttpClient } from '@shogo-ai/sdk'
import {
  Card,
  CardContent,
  Button,
  Badge,
  Alert,
  AlertTitle,
  AlertDescription,
  Skeleton,
  cn,
} from '@shogo/shared-ui/primitives'

// ─── Main Page ─────────────────────────────────────────────

export default observer(function BillingPage() {
  const router = useRouter()
  const { user, isLoading: isAuthLoading } = useAuth()
  const workspaces = useWorkspaceCollection()
  const actions = useDomainActions()

  useEffect(() => {
    if (user?.id && workspaces) {
      workspaces.loadAll({ userId: user.id }).catch((e) => console.error('[Billing] Failed to load workspaces:', e))
    }
  }, [user?.id, workspaces])

  const http = useDomainHttp()
  const currentWorkspace = useActiveWorkspace()

  const {
    subscription,
    effectiveBalance,
    isLoading: isBillingLoading,
    refetchSubscription,
    refetchCreditLedger,
  } = useBillingData(currentWorkspace?.id)

  const [billingInterval, setBillingInterval] = useState<'monthly' | 'annual'>('monthly')
  const [selectedProTier, setSelectedProTier] = useState(0)
  const [selectedBusinessTier, setSelectedBusinessTier] = useState(4)
  const [isCheckoutLoading, setIsCheckoutLoading] = useState(false)
  const [isPortalLoading, setIsPortalLoading] = useState(false)
  const [regionalPricing, setRegionalPricing] = useState<RegionalPricingResponse | null>(null)

  useEffect(() => {
    let cancelled = false
    api.getRegionalPricing(http).then((data) => {
      if (!cancelled && data?.currency?.code && data.currency.code !== 'USD') {
        setRegionalPricing(data)
      }
    }).catch(() => {})
    return () => { cancelled = true }
  }, [http])

  const creditsTotal = getTotalCreditsForPlan(subscription?.planId)
  const creditsRemaining = effectiveBalance?.total ?? creditsTotal

  const planName = subscription
    ? `${subscription.planId.charAt(0).toUpperCase() + subscription.planId.slice(1)} Plan`
    : 'Free Plan'

  const proTier = PRO_TIERS[selectedProTier]
  const businessTier = BUSINESS_TIERS[selectedBusinessTier]

  const fmtPrice = useCallback((usdAmount: number, planKey?: string) => {
    if (!regionalPricing || !planKey) return `$${usdAmount}`
    const localPlan = regionalPricing.plans[planKey]
    if (!localPlan) return `$${usdAmount}`
    const localAmount = billingInterval === 'monthly' ? localPlan.monthly : Math.round(localPlan.annual / 12)
    return `~${formatCurrencyPrice(localAmount, regionalPricing.currency)}`
  }, [regionalPricing, billingInterval])

  const handleCheckout = useCallback(async (planType: 'pro' | 'business', credits: number) => {
    if (!currentWorkspace?.id) return
    setIsCheckoutLoading(true)
    try {
      const stripeTierKey = credits >= BASE_TIER_CREDITS ? Math.round(credits / 2) : credits
      const planId = stripeTierKey === 100 ? planType : `${planType}_${stripeTierKey}`
      const isNative = Platform.OS !== 'web'

      const redirectBase = isNative
        ? ExpoLinking.createURL('billing')
        : (typeof window !== 'undefined' ? window.location.origin : undefined)
      console.log('[Billing] checkout start', { planId, billingInterval, isNative, redirectBase })
      trackInitiateCheckout({ planId, billingInterval, workspaceId: currentWorkspace.id })

      const data = await api.createCheckoutSession(http, {
        workspaceId: currentWorkspace.id,
        planId,
        billingInterval,
        userEmail: user?.email,
        referralId: getRewardfulReferral(),
        ...(redirectBase && {
          successUrl: `${redirectBase}/?workspace=${currentWorkspace.id}&checkout=success&session_id={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${redirectBase}/?workspace=${currentWorkspace.id}&checkout=canceled`,
        }),
      })
      console.log('[Billing] checkout session created', { url: data.url ? '(received)' : '(missing)' })

      if (data.url) {
        if (!isNative) {
          window.location.href = data.url
        } else {
          const scheme = ExpoLinking.createURL('')
          console.log('[Billing] opening auth session, scheme prefix:', scheme)
          const result = await WebBrowser.openAuthSessionAsync(data.url, scheme)
          console.log('[Billing] auth session result:', { type: result.type, url: 'url' in result ? result.url : undefined })

          if (result.type === 'success' && 'url' in result && result.url) {
            try {
              const qs = result.url.split('?')[1] || ''
              const params = new URLSearchParams(qs)
              const checkout = params.get('checkout')
              const sessionId = params.get('session_id')
              console.log('[Billing] parsed redirect params:', { checkout, sessionId })

              if (sessionId) {
                console.log('[Billing] verifying checkout session...')
                try {
                  const verifyResult = await api.verifyCheckout(http, sessionId)
                  console.log('[Billing] verify result:', verifyResult)
                  if (checkout === 'success') {
                    trackPurchase({ planId: verifyResult.planId, billingInterval, workspaceId: currentWorkspace?.id, sessionId })
                  }
                } catch (verifyErr) {
                  console.warn('[Billing] verify failed (webhook will handle):', verifyErr)
                }
              }

              console.log('[Billing] refetching billing data...')
              refetchSubscription()
              refetchCreditLedger()
            } catch (parseErr) {
              console.warn('[Billing] error parsing redirect URL:', parseErr)
            }
          }
        }
      }
    } catch (e) {
      console.warn('[Billing] checkout failed:', e)
    } finally {
      setIsCheckoutLoading(false)
    }
  }, [http, currentWorkspace?.id, billingInterval, user?.email, router, refetchSubscription, refetchCreditLedger])

  const handleManageSubscription = useCallback(async () => {
    if (!currentWorkspace?.id) return
    setIsPortalLoading(true)
    try {
      const isNative = Platform.OS !== 'web'
      const returnUrl = isNative
        ? ExpoLinking.createURL('billing')
        : window.location.href
      console.log('[Billing] portal start', { isNative, returnUrl })

      const data = await api.createPortalSession(http, currentWorkspace.id, returnUrl)
      if (data.url) {
        if (!isNative) {
          window.location.href = data.url
        } else {
          const scheme = ExpoLinking.createURL('')
          console.log('[Billing] opening portal, scheme prefix:', scheme)
          const result = await WebBrowser.openAuthSessionAsync(data.url, scheme)
          console.log('[Billing] portal result:', { type: result.type })
          refetchSubscription()
          refetchCreditLedger()
        }
      }
    } catch (e) {
      console.warn('[Billing] portal session failed:', e)
    } finally {
      setIsPortalLoading(false)
    }
  }, [http, currentWorkspace?.id, refetchSubscription, refetchCreditLedger])

  if (isAuthLoading || isBillingLoading) {
    return (
      <View className="flex-1 bg-background p-6">
        <View className="gap-4">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
        </View>
      </View>
    )
  }

  if (!user || !currentWorkspace) {
    return (
      <View className="flex-1 bg-background p-6">
        <View className="items-center justify-center py-12">
          <Building2 size={48} className="text-muted-foreground mb-4" />
          <Text className="text-xl font-semibold text-foreground mb-2">
            No Workspace Selected
          </Text>
          <Text className="text-muted-foreground mb-4 text-center">
            Please select or create a workspace to manage billing.
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
      contentContainerStyle={{ padding: 16, paddingBottom: 60 }}
      showsVerticalScrollIndicator={false}
    >
      {/* Header */}
      <View className="flex-row items-center gap-3 mb-6">
        <Pressable onPress={() => router.canGoBack() ? router.back() : router.replace('/(app)')}>
          <ArrowLeft size={20} className="text-foreground" />
        </Pressable>
        <View className="flex-1">
          <Text className="text-2xl font-bold text-foreground">
            Billing
          </Text>
          <Text className="text-sm text-muted-foreground">
            Manage your subscription plan and credit balance.
          </Text>
        </View>
      </View>

      {/* Current Plan Card */}
      <Card className="mb-4">
        <CardContent className="p-4">
          <View className="flex-row items-center justify-between">
            <View className="flex-row items-center gap-3 flex-1">
              <View className="h-10 w-10 rounded-full bg-primary/10 items-center justify-center">
                <Text className="text-lg font-semibold text-primary">
                  {currentWorkspace.name?.[0]?.toUpperCase() || 'W'}
                </Text>
              </View>
              <View className="flex-1">
                <Text className="text-sm font-medium text-foreground">
                  You're on {planName}
                </Text>
                <Text className="text-xs text-muted-foreground">
                  Upgrade anytime
                </Text>
              </View>
            </View>
            {subscription && (
              <Button
                variant="outline"
                size="sm"
                onPress={handleManageSubscription}
                disabled={isPortalLoading}
              >
                {isPortalLoading ? 'Loading...' : 'Manage'}
              </Button>
            )}
          </View>
        </CardContent>
      </Card>

      {/* Credits Display */}
      <Card className="mb-8">
        <CardContent className="p-4 gap-4">
          <View>
            <Text className="text-sm font-medium text-foreground mb-1">
              Credits remaining
            </Text>
            <Text className="text-2xl font-bold text-foreground">
              {formatCredits(creditsRemaining)} of {creditsTotal}
            </Text>
          </View>
          <View className="gap-2">
            <Text className="text-sm font-medium text-foreground">
              Daily credits used first
            </Text>
            <View className="gap-2">
              <View className="flex-row items-center gap-2">
                <Info size={16} className="text-muted-foreground" />
                <Text className="text-sm text-muted-foreground">
                  Daily credits reset at midnight UTC
                </Text>
              </View>
            </View>
          </View>
        </CardContent>
      </Card>

      {/* Regional Currency Indicator */}
      {regionalPricing && (
        <View className="flex-row items-center justify-center gap-2 mb-4">
          <Text className="text-sm text-muted-foreground">
            Prices shown in {regionalPricing.currency.name} ({regionalPricing.currency.code})
          </Text>
        </View>
      )}

      {/* Billing Interval Toggle */}
      <View className="items-center mb-6">
        <View className="flex-row border border-border rounded-lg bg-muted/60 p-1">
          <Pressable
            onPress={() => setBillingInterval('monthly')}
            className={cn(
              'px-4 py-2 rounded-md',
              billingInterval === 'monthly' && 'bg-primary'
            )}
          >
            <Text className={cn(
              'text-sm font-medium',
              billingInterval === 'monthly' ? 'text-primary-foreground' : 'text-foreground'
            )}>
              Monthly
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setBillingInterval('annual')}
            className={cn(
              'flex-row items-center gap-1.5 px-4 py-2 rounded-md',
              billingInterval === 'annual' && 'bg-primary'
            )}
          >
            <Text className={cn(
              'text-sm font-medium',
              billingInterval === 'annual' ? 'text-primary-foreground' : 'text-foreground'
            )}>
              Annual
            </Text>
            <Badge variant="secondary" className="ml-1">
              <Text className="text-[10px]">Save ~17%</Text>
            </Badge>
          </Pressable>
        </View>
      </View>

      {/* Plan Cards — md row: equal-height columns; tier slot reserves space so CTAs align */}
      <View className="gap-6 md:flex-row md:items-stretch">
        {/* Basic Plan */}
        <View className="md:flex-1 md:w-0 flex flex-col">
          <View className="hidden md:block md:min-h-8" />
          <Card className="md:flex-1 flex flex-col">
            <CardContent className="md:flex-1 flex flex-col p-5 gap-5">
              <View className="flex-row items-center gap-2">
                <Sparkles size={20} className="text-green-500" />
                <Text className="text-lg font-semibold text-foreground">Basic</Text>
              </View>
              <Text className="md:min-h-[44px] text-sm text-muted-foreground">
                More credits with the fast AI model for individuals getting started.
              </Text>

              <View className="md:min-h-[100px]">
                <View className="flex-row items-baseline gap-1">
                  <Text className="text-4xl font-bold text-foreground">
                    {regionalPricing
                      ? fmtPrice(billingInterval === 'monthly' ? BASIC_TIER.monthly : Math.round(BASIC_TIER.annual / 12), 'basic')
                      : `$${billingInterval === 'monthly' ? BASIC_TIER.monthly : Math.round(BASIC_TIER.annual / 12)}`}
                  </Text>
                  <Text className="text-sm text-muted-foreground">per month</Text>
                </View>
                {billingInterval === 'annual' && !regionalPricing && (
                  <Text className="text-sm text-muted-foreground">
                    ${BASIC_TIER.annual}/year (save ~17%)
                  </Text>
                )}
              </View>

              <View className="hidden md:block md:min-h-[76px]" />

              <Pressable
                onPress={() => handleCheckout('basic' as any, BASIC_TIER.credits)}
                disabled={isCheckoutLoading}
                className="w-full items-center justify-center py-3 rounded-md bg-primary active:bg-primary/80"
              >
                <Text className="text-sm font-medium text-primary-foreground">
                  {subscription?.planId === 'basic' ? 'Current Plan' : 'Get Basic'}
                </Text>
              </Pressable>

              <View className="md:flex-1 gap-2">
                <Text className="text-sm font-medium text-foreground">
                  {BASIC_TIER.credits} credits / month
                </Text>
                <Text className="text-sm text-muted-foreground">
                  All features in Free, plus:
                </Text>
                <FeatureList features={BASIC_FEATURES} />
              </View>
            </CardContent>
          </Card>
        </View>

        {/* Pro Plan */}
        <View className="md:flex-1 md:w-0 flex flex-col">
          <View className="hidden md:block md:min-h-8" />
          <Card className="md:flex-1 flex flex-col">
            <CardContent className="md:flex-1 flex flex-col p-5 gap-5">
              <View className="flex-row items-center gap-2">
                <Zap size={20} className="text-blue-500" />
                <Text className="text-lg font-semibold text-foreground">Pro</Text>
              </View>
              <Text className="md:min-h-[44px] text-sm text-muted-foreground">
                Designed for fast-moving teams building together in real time.
              </Text>

              <View className="md:min-h-[100px]">
                <View className="flex-row items-baseline gap-1">
                  <Text className="text-4xl font-bold text-foreground">
                    {regionalPricing
                      ? fmtPrice(
                          billingInterval === 'monthly' ? proTier.monthly : Math.round(proTier.annual / 12),
                          `pro_${proTier.credits}`
                        )
                      : `$${billingInterval === 'monthly' ? proTier.monthly : Math.round(proTier.annual / 12)}`}
                  </Text>
                  <Text className="text-sm text-muted-foreground">per month</Text>
                </View>
                <Text className="text-sm text-muted-foreground">
                  shared across unlimited users
                </Text>
              </View>

              <View className="md:min-h-[76px]">
                <Text className="text-sm font-medium text-foreground mb-2">
                  Monthly credits
                </Text>
                <TierSelector
                  tiers={PRO_TIERS}
                  selectedIndex={selectedProTier}
                  onSelect={setSelectedProTier}
                />
              </View>

              <Pressable
                onPress={() => handleCheckout('pro', proTier.credits)}
                disabled={isCheckoutLoading}
                className="w-full items-center justify-center py-3 rounded-md bg-primary active:bg-primary/80"
              >
                <Text className="text-sm font-medium text-primary-foreground">
                  {subscription?.planId?.startsWith('pro') ? 'Change Plan' : 'Upgrade to Pro'}
                </Text>
              </Pressable>

              <View className="md:flex-1 gap-2">
                <Text className="text-sm font-medium text-foreground">
                  {proTier.credits.toLocaleString()} credits / month
                </Text>
                <Text className="text-sm text-muted-foreground">
                  All features in Free, plus:
                </Text>
                <FeatureList features={PRO_FEATURES} />
              </View>
            </CardContent>
          </Card>
        </View>

        {/* Business Plan */}
        <View className="md:flex-1 md:w-0 flex flex-col">
          <View className="min-h-8 items-center justify-center px-1">
            <Badge className="bg-primary">
              <Text className="text-xs text-primary-foreground font-medium">Most Popular</Text>
            </Badge>
          </View>
          <Card className="md:flex-1 flex flex-col border-primary">
            <CardContent className="md:flex-1 flex flex-col p-5 gap-5">
              <View className="flex-row items-center gap-2">
                <Building2 size={20} className="text-purple-500" />
                <Text className="text-lg font-semibold text-foreground">Business</Text>
              </View>
              <Text className="md:min-h-[44px] text-sm text-muted-foreground">
                Advanced controls and power features for growing departments
              </Text>

              <View className="md:min-h-[100px]">
                <View className="flex-row items-baseline gap-1">
                  <Text className="text-4xl font-bold text-foreground">
                    {regionalPricing
                      ? fmtPrice(
                          billingInterval === 'monthly' ? businessTier.monthly : Math.round(businessTier.annual / 12),
                          `business_${businessTier.credits}`
                        )
                      : `$${billingInterval === 'monthly' ? businessTier.monthly : Math.round(businessTier.annual / 12)}`}
                  </Text>
                  <Text className="text-sm text-muted-foreground">per month</Text>
                </View>
                <Text className="text-sm text-muted-foreground">
                  shared across unlimited users
                </Text>
              </View>

              <View className="md:min-h-[76px]">
                <Text className="text-sm font-medium text-foreground mb-2">
                  Monthly credits
                </Text>
                <TierSelector
                  tiers={BUSINESS_TIERS}
                  selectedIndex={selectedBusinessTier}
                  onSelect={setSelectedBusinessTier}
                />
              </View>

              <Pressable
                onPress={() => handleCheckout('business', businessTier.credits)}
                disabled={isCheckoutLoading}
                className="w-full items-center justify-center py-3 rounded-md bg-primary active:bg-primary/80"
              >
                <Text className="text-sm font-medium text-primary-foreground">
                  {subscription?.planId?.startsWith('business') ? 'Change Plan' : 'Upgrade to Business'}
                </Text>
              </Pressable>

              <View className="md:flex-1 gap-2">
                <Text className="text-sm font-medium text-foreground">
                  {businessTier.credits.toLocaleString()} credits / month
                </Text>
                <FeatureList features={BUSINESS_FEATURES} />
              </View>
            </CardContent>
          </Card>
        </View>

        {/* Enterprise Plan */}
        <View className="md:flex-1 md:w-0 flex flex-col">
          <View className="hidden md:block md:min-h-8" />
          <Card className="md:flex-1 flex flex-col">
            <CardContent className="md:flex-1 flex flex-col p-5 gap-5">
              <View className="flex-row items-center gap-2">
                <Crown size={20} className="text-amber-500" />
                <Text className="text-lg font-semibold text-foreground">Enterprise</Text>
              </View>
              <Text className="md:min-h-[44px] text-sm text-muted-foreground">
                Built for large orgs needing flexibility, scale, and governance.
              </Text>

              <View className="md:min-h-[100px]">
                <Text className="text-4xl font-bold text-foreground">Custom</Text>
                <Text className="text-sm text-muted-foreground">Flexible plans</Text>
              </View>

              <View className="hidden md:block md:min-h-[76px]" />

              <Pressable
                onPress={() => Linking.openURL('mailto:sales@shogo.ai')}
                className="w-full items-center justify-center py-3 rounded-md border border-border active:bg-muted"
              >
                <Text className="text-sm font-medium text-foreground">Book a demo</Text>
              </Pressable>

              <View className="md:flex-1">
                <FeatureList features={ENTERPRISE_FEATURES} />
              </View>
            </CardContent>
          </Card>
        </View>
      </View>

      {/* ─── Workspace Resources ─────────────────────────────── */}
      <WorkspaceResources
        workspaceId={currentWorkspace.id}
        http={http}
        billingInterval={billingInterval}
      />
    </ScrollView>
  )
})

// =============================================================================
// Workspace Resources Section
// =============================================================================

interface WorkspaceResourcesProps {
  workspaceId: string
  http: HttpClient
  billingInterval: 'monthly' | 'annual'
}

function WorkspaceResources({ workspaceId, http, billingInterval }: WorkspaceResourcesProps) {
  const [instance, setInstance] = useState<any>(null)
  const [metrics, setMetrics] = useState<any>(null)
  const [metricsPeriod, setMetricsPeriod] = useState<'1h' | '6h' | '24h' | '7d' | '30d'>('24h')
  const [isLoading, setIsLoading] = useState(true)
  const [isCheckoutLoading, setIsCheckoutLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    Promise.all([
      api.getWorkspaceInstance(http, workspaceId).catch(() => null),
      api.getWorkspaceMetrics(http, workspaceId, metricsPeriod).catch(() => null),
    ]).then(([inst, met]) => {
      if (!cancelled) {
        setInstance(inst)
        setMetrics(met)
        setIsLoading(false)
      }
    })
    return () => { cancelled = true }
  }, [workspaceId, http, metricsPeriod])

  const handleInstanceCheckout = useCallback(async (size: InstanceSizeName) => {
    if (size === 'micro') return
    setIsCheckoutLoading(true)
    try {
      const isNative = Platform.OS !== 'web'
      const redirectBase = isNative
        ? ExpoLinking.createURL('billing')
        : (typeof window !== 'undefined' ? window.location.origin : undefined)

      const data = await api.createInstanceCheckout(http, {
        workspaceId,
        instanceSize: size,
        billingInterval,
        ...(redirectBase && {
          successUrl: `${redirectBase}/?workspace=${workspaceId}&instance_checkout=success&session_id={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${redirectBase}/?workspace=${workspaceId}&instance_checkout=canceled`,
        }),
      })

      if (data.url) {
        if (!isNative) {
          window.location.href = data.url
        } else {
          const scheme = ExpoLinking.createURL('')
          await WebBrowser.openAuthSessionAsync(data.url, scheme)
        }
      }
    } catch (e) {
      console.warn('[Capacity] checkout failed:', e)
    } finally {
      setIsCheckoutLoading(false)
    }
  }, [http, workspaceId, billingInterval])

  if (isLoading) {
    return (
      <View className="mt-6 gap-4">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-48 w-full" />
      </View>
    )
  }

  const currentSize = (instance?.size ?? 'micro') as InstanceSizeName
  const currentSpec = getInstanceSize(currentSize)
  const storageTotalBytes = instance?.storage?.totalBytes ?? 0
  const storageLimitBytes = instance?.storage?.limitBytes ?? currentSpec.storageLimitGb * 1024 ** 3
  const storagePercent = storageLimitBytes > 0 ? Math.min((storageTotalBytes / storageLimitBytes) * 100, 100) : 0

  return (
    <View className="mt-8 gap-4">
      <Text className="text-xl font-bold text-foreground">
        Workspace Resources
      </Text>

      {/* Current resource overview */}
      <Card>
        <CardContent className="p-4 gap-3">
          <View className="flex-row items-center gap-2">
            <Server size={18} className="text-primary" />
            <Text className="text-base font-semibold text-foreground">
              {currentSpec.label} Instance
            </Text>
            {currentSpec.dedicated && (
              <Badge variant="outline" className="ml-auto">
                <Text className="text-xs text-primary">Dedicated Instance</Text>
              </Badge>
            )}
          </View>

          <View className="flex-row gap-4 mt-1">
            <View className="flex-1 gap-1">
              <View className="flex-row items-center gap-1.5">
                <Cpu size={14} className="text-muted-foreground" />
                <Text className="text-sm text-muted-foreground">CPU</Text>
              </View>
              <Text className="text-lg font-semibold text-foreground">{currentSpec.cpuLabel}</Text>
            </View>
            <View className="flex-1 gap-1">
              <View className="flex-row items-center gap-1.5">
                <BarChart3 size={14} className="text-muted-foreground" />
                <Text className="text-sm text-muted-foreground">Memory</Text>
              </View>
              <Text className="text-lg font-semibold text-foreground">{currentSpec.memoryLabel}</Text>
            </View>
          </View>

          {/* Storage bar */}
          <View className="gap-1.5 mt-1">
            <View className="flex-row items-center justify-between">
              <View className="flex-row items-center gap-1.5">
                <HardDrive size={14} className="text-muted-foreground" />
                <Text className="text-sm text-muted-foreground">Storage</Text>
              </View>
              <Text className="text-sm text-muted-foreground">
                {formatStorageBytes(storageTotalBytes)} / {currentSpec.storageLabel}
              </Text>
            </View>
            <View className="h-2 bg-muted rounded-full overflow-hidden">
              <View
                className={cn(
                  'h-full rounded-full',
                  storagePercent > 90 ? 'bg-destructive' : storagePercent > 70 ? 'bg-amber-500' : 'bg-primary',
                )}
                style={{ width: `${Math.max(storagePercent, 1)}%` }}
              />
            </View>
          </View>
        </CardContent>
      </Card>

      {/* Resource usage charts (paid tiers only) */}
      {currentSpec.dedicated && metrics?.history?.timestamps?.length > 0 && (
        <Card>
          <CardContent className="p-4 gap-3">
            <View className="flex-row items-center justify-between">
              <Text className="text-base font-semibold text-foreground">Resource Usage</Text>
              <View className="flex-row gap-1">
                {(['1h', '6h', '24h', '7d', '30d'] as const).map((p) => (
                  <Pressable
                    key={p}
                    onPress={() => setMetricsPeriod(p)}
                    className={cn(
                      'px-2 py-1 rounded',
                      metricsPeriod === p ? 'bg-primary' : 'bg-muted',
                    )}
                  >
                    <Text className={cn(
                      'text-xs font-medium',
                      metricsPeriod === p ? 'text-primary-foreground' : 'text-muted-foreground',
                    )}>
                      {p}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>

            {/* Current readings */}
            <View className="flex-row gap-4">
              <View className="flex-1 bg-muted/50 rounded-lg p-3 gap-1">
                <Text className="text-xs text-muted-foreground">CPU Usage</Text>
                <Text className="text-2xl font-bold text-foreground">
                  {formatCpuPercent(metrics.current?.cpuPercent ?? 0)}
                </Text>
              </View>
              <View className="flex-1 bg-muted/50 rounded-lg p-3 gap-1">
                <Text className="text-xs text-muted-foreground">Memory Usage</Text>
                <Text className="text-2xl font-bold text-foreground">
                  {formatMemoryGb(metrics.current?.memoryBytes ?? 0)}
                </Text>
              </View>
            </View>

            {/* Simplified bar chart representation */}
            <View className="gap-2">
              <Text className="text-xs text-muted-foreground">CPU over time</Text>
              <View className="flex-row items-end h-12 gap-px">
                {(metrics.history?.cpuPercent ?? []).slice(-30).map((val: number, i: number) => (
                  <View
                    key={i}
                    className="flex-1 bg-primary/70 rounded-t-sm"
                    style={{ height: `${Math.max(val, 2)}%` }}
                  />
                ))}
              </View>
            </View>

            <View className="gap-2">
              <Text className="text-xs text-muted-foreground">Memory over time</Text>
              <View className="flex-row items-end h-12 gap-px">
                {(metrics.history?.memoryBytes ?? []).slice(-30).map((val: number, i: number) => {
                  const maxMem = currentSpec.memoryGb * 1024 ** 3
                  const pct = maxMem > 0 ? (val / maxMem) * 100 : 0
                  return (
                    <View
                      key={i}
                      className="flex-1 bg-blue-500/70 rounded-t-sm"
                      style={{ height: `${Math.max(pct, 2)}%` }}
                    />
                  )
                })}
              </View>
            </View>
          </CardContent>
        </Card>
      )}

      {/* Upgrade prompt for free tier */}
      {!currentSpec.dedicated && (
        <Card className="border-dashed border-primary/30">
          <CardContent className="p-4 items-center gap-2">
            <BarChart3 size={24} className="text-primary" />
            <Text className="text-sm font-medium text-foreground text-center">
              Upgrade to a paid instance size for detailed resource metrics and a dedicated instance.
            </Text>
          </CardContent>
        </Card>
      )}

      {/* Capacity tier cards */}
      <Text className="text-base font-semibold text-foreground mt-2">
        Instance Sizes
      </Text>

      <View className="gap-3">
        {INSTANCE_SIZES.map((tier) => {
          const isCurrent = tier.name === currentSize
          const price = getDisplayPrice(tier, billingInterval)
          const isUpgrade = INSTANCE_SIZES.findIndex((t) => t.name === tier.name) >
            INSTANCE_SIZES.findIndex((t) => t.name === currentSize)
          const isDowngrade = INSTANCE_SIZES.findIndex((t) => t.name === tier.name) <
            INSTANCE_SIZES.findIndex((t) => t.name === currentSize)

          return (
            <Card
              key={tier.name}
              className={cn(isCurrent && 'border-primary')}
            >
              <CardContent className="p-4 gap-2">
                <View className="flex-row items-center justify-between">
                  <View className="flex-row items-center gap-2">
                    <Text className="text-base font-semibold text-foreground">
                      {tier.label}
                    </Text>
                    {isCurrent && (
                      <Badge variant="default">
                        <Text className="text-xs text-primary-foreground">Current</Text>
                      </Badge>
                    )}
                    {tier.dedicated && (
                      <Badge variant="outline">
                        <Text className="text-xs text-muted-foreground">Dedicated</Text>
                      </Badge>
                    )}
                  </View>
                  <Text className="text-base font-bold text-foreground">
                    {price === 0 ? 'Free' : `$${price}${billingInterval === 'monthly' ? '/mo' : '/yr'}`}
                  </Text>
                </View>

                <Text className="text-sm text-muted-foreground">
                  {tier.cpuLabel} &middot; {tier.memoryLabel} &middot; {tier.storageLabel} storage
                </Text>

                {!isCurrent && tier.name !== 'micro' && (
                  <Pressable
                    onPress={() => handleInstanceCheckout(tier.name)}
                    disabled={isCheckoutLoading}
                    className={cn(
                      'w-full items-center justify-center py-2.5 rounded-md mt-1',
                      isUpgrade ? 'bg-primary' : 'bg-muted',
                    )}
                  >
                    <Text className={cn(
                      'text-sm font-medium',
                      isUpgrade ? 'text-primary-foreground' : 'text-foreground',
                    )}>
                      {isUpgrade ? 'Upgrade' : 'Downgrade'}
                    </Text>
                  </Pressable>
                )}
              </CardContent>
            </Card>
          )
        })}
      </View>
    </View>
  )
}
