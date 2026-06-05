// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AppBillingPage - Mobile (Expo)
 *
 * Workspace billing and plan management:
 * - Current plan card with workspace avatar
 * - Usage remaining card (in USD)
 * - Monthly/Annual billing toggle
 * - Pro / Business / Enterprise plan cards with included-USD selectors
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  View,
  Text,
  ScrollView,
  Pressable,
  TextInput,
  Linking,
  Platform,
  useWindowDimensions,
} from 'react-native'
import * as WebBrowser from 'expo-web-browser'
import * as ExpoLinking from 'expo-linking'
import { useRouter, useLocalSearchParams } from 'expo-router'
import { observer } from 'mobx-react-lite'
import {
  ArrowLeft,
  Building2,
  Info,
  Sparkles,
  Zap,
  Crown,
  KeyRound,
} from 'lucide-react-native'
import { useAuth } from '../../contexts/auth'
import { useWorkspaceCollection, useDomainHttp } from '../../contexts/domain'
import { api } from '../../lib/api'
import { clearPendingLicenseCode } from '../../lib/pending-license'
import { openWebAppSession } from '../../lib/openWebAppSession'
import { purchaseSubscription, finishPurchase, restorePurchases, initIapListeners, IapError, APP_STORE_SUBSCRIPTIONS_URL } from '../../lib/iap'
import type { IapPurchaseResult } from '../../lib/iap'
import type { RegionalPricingResponse } from '../../lib/api'
import { getRewardfulReferral } from '../../lib/rewardful'
import { trackInitiateCheckout, trackPurchase } from '../../lib/tracking'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { useDomainActions } from '@shogo/shared-app/domain'
import { useBillingData } from '@shogo/shared-app/hooks'
import {
  PLAN_PRICING,
  BASIC_FEATURES,
  PRO_FEATURES,
  BUSINESS_FEATURES,
  ENTERPRISE_FEATURES,
  getWindowLimitsForPlan,
  formatUsd,
  formatCurrencyPrice,
  getPlanDisplayName,
} from '../../lib/billing-config'
import { SeatCounter } from '../../components/billing/SeatCounter'
import { BillingHistory } from '../../components/billing/BillingHistory'
import { useToast, Toast, ToastTitle, ToastDescription } from '../../components/ui/toast'
import { FeatureList } from '../../components/billing/FeatureList'
import { UsageWindowBar } from '../../components/billing/UsageWindows'
import {
  Card,
  CardContent,
  Button,
  Badge,
  Skeleton,
  cn,
} from '@shogo/shared-ui/primitives'

// ─── Rolling usage-window bar ──────────────────────────────

// Relative usage framing for plan cards (no dollar figures, like Codex /
// Claude Code). Expresses each tier's rolling-window allowance as a multiple
// of the entry paid tier (Basic), derived from the weekly window so copy
// stays in sync with ROLLING_WINDOW_LIMITS. Enterprise is uncapped.
const BASIC_WEEKLY_USD = getWindowLimitsForPlan('basic', 1)?.weeklyUsd ?? 0

function relativeUsageCopy(planId: string): string {
  const limits = getWindowLimitsForPlan(planId, 1)
  if (!limits) return 'Unlimited usage — no rate windows'
  if (!BASIC_WEEKLY_USD || limits.weeklyUsd <= BASIC_WEEKLY_USD) {
    return 'Standard 5-hour & weekly usage windows'
  }
  // Round to one decimal, dropping a trailing ".0" (e.g. 2.5×, 5×).
  const multiple = Number((limits.weeklyUsd / BASIC_WEEKLY_USD).toFixed(1))
  return `${multiple}× the usage of Basic — higher 5-hour & weekly windows`
}

// ─── Main Page ─────────────────────────────────────────────

export default observer(function BillingPage() {
  const router = useRouter()
  const { redeem: redeemParam } = useLocalSearchParams<{ redeem?: string }>()
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
    refetchUsageWallet,
    planSource,
    usageWindows,
  } = useBillingData(currentWorkspace?.id)
  // A grant-conferred plan has no Stripe customer / portal, so hide
  // "Manage" / Stripe-only affordances and let "Free Plan"-style copy
  // adapt by checking `planSource === 'subscription'` instead of just
  // `subscription` truthiness.
  const hasStripeSubscription = planSource === 'subscription'

  const [billingInterval, setBillingInterval] = useState<'monthly' | 'annual'>('monthly')
  const [proSeats, setProSeats] = useState(1)
  const [businessSeats, setBusinessSeats] = useState(1)
  const [isCheckoutLoading, setIsCheckoutLoading] = useState(false)
  const [isPortalLoading, setIsPortalLoading] = useState(false)
  const [regionalPricing, setRegionalPricing] = useState<RegionalPricingResponse | null>(null)
  const [isRestoreLoading, setIsRestoreLoading] = useState(false)
  const [licenseCode, setLicenseCode] = useState('')
  const [isRedeeming, setIsRedeeming] = useState(false)
  const licenseInputRef = useRef<TextInput>(null)
  const iapTransactionsInFlightRef = useRef<Map<string, Promise<'processed' | 'failed'>>>(new Map())
  const toast = useToast()
  const { width } = useWindowDimensions()
  const isTabletWidth = width >= 768
  const contentHorizontalPadding = isTabletWidth ? 24 : 16
  // Wider container on iPad portrait so the new 2-column plan grid breathes.
  const contentMaxWidth = width >= 1280 ? 1200 : width >= 768 ? 920 : 720

  type IapToastVariant = 'success' | 'error' | 'info'
  const showIapToast = useCallback((variant: IapToastVariant, title: string, description: string) => {
    const action: 'success' | 'error' | 'info' = variant
    toast.show({
      id: `iap-${Date.now()}`,
      placement: 'top',
      duration: variant === 'error' ? 8000 : 5000,
      render: ({ id: toastId }: { id: string }) => (
        <Toast nativeID={toastId} variant="outline" action={action}>
          <ToastTitle>{title}</ToastTitle>
          <ToastDescription>{description}</ToastDescription>
        </Toast>
      ),
    })
  }, [toast])

  // Deep-link landing: shogo://billing?redeem=CODE (or <web>/billing?redeem=CODE)
  // prefills the license-key field and focuses it so the recipient just taps Redeem.
  useEffect(() => {
    const code = Array.isArray(redeemParam) ? redeemParam[0] : redeemParam
    if (!code) return
    setLicenseCode(code.trim().toUpperCase())
    // Consumed — drop any stashed copy so it can't re-trigger a later
    // navigation back to billing.
    clearPendingLicenseCode()
    const t = setTimeout(() => licenseInputRef.current?.focus(), 350)
    return () => clearTimeout(t)
  }, [redeemParam])

  const handleRedeemLicense = useCallback(async () => {
    const code = licenseCode.trim()
    if (!code) return
    const workspaceId = currentWorkspace?.id
    if (!workspaceId) {
      showIapToast('error', 'No workspace selected', 'Pick a workspace before redeeming a key.')
      return
    }
    setIsRedeeming(true)
    try {
      const result = await api.redeemLicenseKey(http, workspaceId, code)
      const planLabel = result?.planId ? getPlanDisplayName(result.planId) : 'a new plan'
      setLicenseCode('')
      // Reflect the new grant immediately.
      refetchSubscription()
      refetchUsageWallet()
      showIapToast('success', 'License key redeemed', `This workspace is now on ${planLabel}.`)
    } catch (err) {
      const status = (err as { status?: number })?.status
      const { title, description } =
        status === 404
          ? { title: 'Invalid key', description: 'We could not find that license key. Double-check the code.' }
          : status === 410
            ? { title: 'Key expired', description: 'This license key has expired and can no longer be redeemed.' }
            : status === 409
              ? { title: 'Already used', description: 'This license key has already been redeemed.' }
              : status === 403
                ? { title: 'Not allowed', description: "You're not a member of this workspace." }
                : { title: 'Redemption failed', description: err instanceof Error ? err.message : 'Please try again.' }
      showIapToast('error', title, description)
    } finally {
      setIsRedeeming(false)
    }
  }, [licenseCode, currentWorkspace?.id, http, refetchSubscription, refetchUsageWallet, showIapToast])

  const getIapTransactionKey = useCallback((purchase: IapPurchaseResult) => {
    const transactionId = purchase.transactionId?.trim()
    if (transactionId) return `tx:${transactionId}`

    // StoreKit should provide a transaction id, but use the receipt tail as a
    // stable fallback so duplicate listener/direct responses still coalesce.
    const receiptTail = purchase.transactionReceipt?.slice(-64) ?? ''
    return `receipt:${purchase.productId}:${receiptTail}`
  }, [])

  const processIapPurchase = useCallback(async (
    purchase: IapPurchaseResult,
    options: {
      successTitle?: string
      successDescription?: string
      onVerified?: () => void
    } = {},
  ): Promise<'processed' | 'duplicate' | 'failed'> => {
    const workspaceId = currentWorkspace?.id
    if (!workspaceId) return 'failed'

    const key = getIapTransactionKey(purchase)
    const inFlight = iapTransactionsInFlightRef.current.get(key)
    if (inFlight) {
      console.log('[Billing] skipping duplicate IAP transaction processing', {
        productId: purchase.productId,
        transactionId: purchase.transactionId,
      })
      try {
        return (await inFlight) === 'processed' ? 'duplicate' : 'failed'
      } catch (err) {
        console.warn('[Billing] duplicate IAP transaction processing failed:', err)
        return 'failed'
      }
    }

    const task = (async (): Promise<'processed' | 'failed'> => {
      const verify = await api.verifyAppleReceipt(http, {
        workspaceId,
        productId: purchase.productId,
        transactionId: purchase.transactionId,
        transactionReceipt: purchase.transactionReceipt,
        appAccountToken: purchase.appAccountToken,
      })

      if (!verify?.ok) {
        console.warn('[Billing] iOS IAP server verification failed:', verify)
        return 'failed'
      }

      await finishPurchase(purchase)
      options.onVerified?.()
      refetchSubscription()
      refetchUsageWallet()
      if (options.successTitle && options.successDescription) {
        showIapToast('success', options.successTitle, options.successDescription)
      }
      return 'processed'
    })()

    iapTransactionsInFlightRef.current.set(key, task)
    try {
      return await task
    } catch (err) {
      console.warn('[Billing] IAP receipt processing failed:', err)
      return 'failed'
    } finally {
      iapTransactionsInFlightRef.current.delete(key)
    }
  }, [currentWorkspace?.id, getIapTransactionKey, http, refetchSubscription, refetchUsageWallet, showIapToast])

  // Global StoreKit listener — finishes any pending transaction that gets
  // delivered async (Ask to Buy approval, app relaunched mid-purchase, etc.).
  // Without this, transactions sit in the StoreKit queue forever and Apple
  // rejects the build for "unfinished transactions on relaunch."
  useEffect(() => {
    if (Platform.OS !== 'ios' || !currentWorkspace?.id) return
    const teardown = initIapListeners(
      async (purchase) => {
        await processIapPurchase(purchase, {
          successTitle: 'Subscription activated',
          successDescription: 'Your pending purchase has been verified.',
        })
      },
      (err) => {
        if (err.code === 'user_cancelled') return
        if (err.code === 'pending') {
          showIapToast('info', 'Purchase pending', 'Waiting for approval (Family Sharing / Ask to Buy).')
        }
      },
    )
    return teardown
  }, [currentWorkspace?.id, processIapPurchase, showIapToast])

  const handleRestorePurchases = useCallback(async () => {
    if (Platform.OS !== 'ios' || !currentWorkspace?.id) return
    setIsRestoreLoading(true)
    try {
      const purchases = await restorePurchases()
      if (purchases.length === 0) {
        showIapToast('info', 'No purchases to restore', 'No previous shogo subscriptions were found on this Apple ID.')
        return
      }
      let restored = 0
      for (const p of purchases) {
        const result = await processIapPurchase(p)
        if (result === 'processed') restored += 1
      }
      if (restored > 0) {
        refetchSubscription()
        refetchUsageWallet()
        showIapToast('success', 'Purchases restored', `Restored ${restored} subscription${restored === 1 ? '' : 's'}.`)
      } else {
        showIapToast('error', 'Restore failed', 'Found previous purchases but could not verify them. Please contact support.')
      }
    } catch (err) {
      if (err instanceof IapError && err.code === 'user_cancelled') return
      showIapToast('error', 'Restore failed', err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setIsRestoreLoading(false)
    }
  }, [currentWorkspace?.id, processIapPurchase, showIapToast])


  useEffect(() => {
    let cancelled = false
    api.getRegionalPricing(http).then((data) => {
      if (!cancelled && data?.currency?.code && data.currency.code !== 'USD') {
        setRegionalPricing(data)
      }
    }).catch(() => {})
    return () => { cancelled = true }
  }, [http])

  const planName = subscription
    ? `${getPlanDisplayName(subscription.planId)} Plan`
    : 'Free Plan'

  const proPricing = PLAN_PRICING.pro
  const businessPricing = PLAN_PRICING.business
  const basicPricing = PLAN_PRICING.basic

  const fmtPrice = useCallback((usdAmount: number, planKey?: string) => {
    if (!regionalPricing || !planKey) return `$${usdAmount}`
    const localPlan = regionalPricing.plans[planKey]
    if (!localPlan) return `$${usdAmount}`
    const basePlan = PLAN_PRICING[planKey as keyof typeof PLAN_PRICING]
    const baseAmount = billingInterval === 'monthly'
      ? basePlan?.monthly
      : (basePlan?.annual ? Math.round(basePlan.annual / 12) : undefined)
    const quantity = baseAmount ? Math.max(1, Math.round(usdAmount / baseAmount)) : 1
    const localAmount = billingInterval === 'monthly' ? localPlan.monthly : Math.round(localPlan.annual / 12)
    return `~${formatCurrencyPrice(localAmount * quantity, regionalPricing.currency)}`
  }, [regionalPricing, billingInterval])

  const fmtAnnualPrice = useCallback((usdAmount: number, planKey?: string) => {
    if (!regionalPricing || !planKey) return `$${usdAmount}`
    const localPlan = regionalPricing.plans[planKey]
    if (!localPlan) return `$${usdAmount}`
    const basePlan = PLAN_PRICING[planKey as keyof typeof PLAN_PRICING]
    const quantity = basePlan?.annual ? Math.max(1, Math.round(usdAmount / basePlan.annual)) : 1
    return formatCurrencyPrice(localPlan.annual * quantity, regionalPricing.currency)
  }, [regionalPricing])

  const handleCheckout = useCallback(async (planType: 'pro' | 'business' | 'basic', seats: number) => {
    if (!currentWorkspace?.id) return
    setIsCheckoutLoading(true)
    try {
      const planId = planType
      const safeSeats = planType === 'basic' ? 1 : Math.max(1, Math.floor(seats || 1))
      const isNative = Platform.OS !== 'web'

      // ============================================================
      // iOS — App Store IAP path (Apple Guideline 3.1.1 compliance)
      //
      // iOS subscriptions are always sold as a single seat. Pro/Business seat
      // upgrades remain web-only (Apple IAP does not cleanly support per-seat
      // quantities on auto-renewables). The UI hides the seat picker on iOS.
      // ============================================================
      if (Platform.OS === 'ios') {
        try {
          trackInitiateCheckout({ planId, billingInterval, seats: 1, workspaceId: currentWorkspace.id })
          const result = await purchaseSubscription({
            plan: planType,
            interval: billingInterval,
            workspaceId: currentWorkspace.id,
          })
          const purchaseResult = await processIapPurchase(result, {
            successTitle: 'Subscription activated',
            successDescription: `You're now on ${planType} (1 seat).`,
            onVerified: () => trackPurchase({
              planId,
              billingInterval,
              seats: 1,
              workspaceId: currentWorkspace.id,
              sessionId: result.transactionId,
            }),
          })
          if (purchaseResult === 'failed') {
            showIapToast('error', 'Could not activate subscription', 'Apple confirmed your purchase but our server could not verify it. We\'ll retry automatically — if it doesn\'t resolve in a few minutes, contact support and we\'ll restore your purchase.')
          }
        } catch (err) {
          if (err instanceof IapError && err.code === 'user_cancelled') {
            // Silent — same UX as Stripe Checkout cancel.
          } else if (err instanceof IapError && err.code === 'pending') {
            showIapToast('info', 'Purchase pending approval', 'Your purchase is waiting for approval (Ask to Buy / Family Sharing). It will activate automatically once approved.')
          } else if (err instanceof IapError && err.code === 'product_not_available') {
            showIapToast('error', 'Subscription not available yet', err.message)
          } else if (err instanceof IapError && err.code === 'network') {
            showIapToast('error', 'Connection to App Store failed', 'Please check your network and try again.')
          } else {
            console.warn('[Billing] iOS IAP failed:', err)
            showIapToast('error', 'Purchase failed', err instanceof Error ? err.message : 'Unknown error')
          }
        } finally {
          setIsCheckoutLoading(false)
        }
        return
      }

      const redirectBase = isNative
        ? ExpoLinking.createURL('billing')
        : (typeof window !== 'undefined' ? window.location.origin : undefined)
      console.log('[Billing] checkout start', { planId, seats: safeSeats, billingInterval, isNative, redirectBase })
      trackInitiateCheckout({ planId, billingInterval, seats: safeSeats, workspaceId: currentWorkspace.id })

      const data = await api.createCheckoutSession(http, {
        workspaceId: currentWorkspace.id,
        planId,
        seats: safeSeats,
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
                    trackPurchase({ planId: verifyResult.planId, billingInterval, seats: (verifyResult as { seats?: number }).seats ?? safeSeats, workspaceId: currentWorkspace?.id, sessionId })
                  }
                } catch (verifyErr) {
                  console.warn('[Billing] verify failed (webhook will handle):', verifyErr)
                }
              }

              console.log('[Billing] refetching billing data...')
              refetchSubscription()
              refetchUsageWallet()
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
  }, [http, currentWorkspace?.id, billingInterval, user?.email, router, refetchSubscription, refetchUsageWallet])

  const handleManageSubscription = useCallback(async () => {
    if (!currentWorkspace?.id) return
    setIsPortalLoading(true)
    try {
      // iOS: route to native App Store subscriptions screen (Apple requirement).
      if (Platform.OS === 'ios') {
        try {
          await Linking.openURL(APP_STORE_SUBSCRIPTIONS_URL)
        } catch (err) {
          console.warn('[Billing] failed to open App Store subscriptions:', err)
        } finally {
          setIsPortalLoading(false)
        }
        return
      }
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
          refetchUsageWallet()
        }
      }
    } catch (e) {
      console.warn('[Billing] portal session failed:', e)
    } finally {
      setIsPortalLoading(false)
    }
  }, [http, currentWorkspace?.id, refetchSubscription, refetchUsageWallet])

  const handleManageBillingOnWeb = useCallback(() => {
    openWebAppSession('/billing').catch((err) =>
      console.warn('[Billing] failed to open web billing:', err),
    )
  }, [])

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
      contentContainerStyle={{
        paddingHorizontal: contentHorizontalPadding,
        paddingVertical: 16,
        paddingBottom: 60,
        alignItems: 'center',
      }}
      showsVerticalScrollIndicator={false}
    >
      <View style={{ width: '100%', maxWidth: contentMaxWidth }}>
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
            Manage your subscription plan and usage.
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
            <View className="flex-row items-center gap-2">
              {hasStripeSubscription && (
                <Button
                  variant="outline"
                  size="sm"
                  onPress={handleManageSubscription}
                  disabled={isPortalLoading}
                >
                  {isPortalLoading ? 'Loading...' : 'Manage'}
                </Button>
              )}
              {Platform.OS === 'ios' && (
                <Button
                  variant="outline"
                  size="sm"
                  onPress={handleRestorePurchases}
                  disabled={isRestoreLoading}
                >
                  {isRestoreLoading ? 'Restoring...' : 'Restore Purchases'}
                </Button>
              )}
            </View>
          </View>
        </CardContent>
      </Card>

      {/* Billing history (recent Stripe invoices) */}
      <BillingHistory workspaceId={currentWorkspace.id} />

      {/* Redeem a license key */}
      <Card className="mb-4">
        <CardContent className="p-4 gap-3">
          <View className="flex-row items-center gap-2">
            <KeyRound size={16} className="text-primary" />
            <Text className="text-sm font-medium text-foreground">Redeem a license key</Text>
          </View>
          <Text className="text-xs text-muted-foreground">
            Have a license key? Redeem it to upgrade this workspace.
          </Text>
          <View className="flex-row items-center gap-2">
            <TextInput
              ref={licenseInputRef}
              value={licenseCode}
              onChangeText={setLicenseCode}
              placeholder="SHGO-PRO-XXXX-XXXX-XXXX"
              placeholderTextColor="#9ca3af"
              autoCapitalize="characters"
              autoCorrect={false}
              editable={!isRedeeming}
              onSubmitEditing={handleRedeemLicense}
              returnKeyType="done"
              className="flex-1 border border-border rounded-lg px-3 py-2 text-sm font-mono text-foreground bg-background"
            />
            <Button
              size="sm"
              onPress={handleRedeemLicense}
              disabled={isRedeeming || !licenseCode.trim()}
            >
              {isRedeeming ? 'Redeeming...' : 'Redeem'}
            </Button>
          </View>
        </CardContent>
      </Card>

      {/* Usage Display — time-gated rolling windows */}
      <Card className="mb-8">
        <CardContent className="p-4 gap-4">
          <View>
            <Text className="text-sm font-medium text-foreground mb-1">
              Usage limits
            </Text>
            <Text className="text-2xl font-bold text-foreground">
              Unlimited within your windows
            </Text>
          </View>

          <View className="gap-4">
            <UsageWindowBar
              label="5-hour window"
              window={usageWindows?.fiveHour}
            />
            <UsageWindowBar
              label="Weekly window"
              window={usageWindows?.weekly}
            />
          </View>

          <View className="gap-2">
            <View className="flex-row items-center gap-2">
              <Info size={16} className="text-muted-foreground" />
              <Text className="text-sm text-muted-foreground">
                {Platform.OS === 'ios'
                  ? 'Usage is unlimited within rolling 5-hour and weekly limits. Each window resets on its own schedule.'
                  : 'Usage is billed at the AI provider\'s raw cost plus a flat 20% markup and is unlimited within rolling 5-hour and weekly limits (per seat on Pro/Business). When a window is exhausted, usage resumes after it resets.'}
              </Text>
            </View>
            {Platform.OS !== 'ios' && effectiveBalance?.overageEnabled && (
              <View className="flex-row items-center gap-2">
                <Info size={16} className="text-muted-foreground" />
                <Text className="text-sm text-muted-foreground">
                  Need more before a window resets? Overage charges in escalating trust blocks ($100 → $500){effectiveBalance.overageHardLimitUsd != null
                    ? ` (cap ${formatUsd(effectiveBalance.overageHardLimitUsd)}/mo)`
                    : ''}
                  {effectiveBalance.overageAccumulatedUsd > 0
                    ? `. Overage this period: ${formatUsd(effectiveBalance.overageAccumulatedUsd)}`
                    : ''}
                </Text>
              </View>
            )}
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

      {/* Plan Cards — keep iPad portrait single-column; use columns only on wider layouts. */}
      <View className="gap-6 lg:flex-row lg:flex-wrap lg:items-stretch xl:flex-nowrap" testID="plan-cards-row">
        {/* Basic Plan */}
        <View className="lg:w-[calc(50%-12px)] lg:flex-grow-0 xl:w-auto xl:flex-1 xl:basis-0 flex flex-col w-full max-w-[640px] self-center lg:max-w-none lg:self-auto" testID="plan-card-basic">
          <View className="hidden lg:block lg:min-h-8" />
          <Card className="lg:flex-1 flex flex-col">
            <CardContent className="lg:flex-1 flex flex-col p-5 gap-5">
              <View className="flex-row items-center gap-2">
                <Sparkles size={20} className="text-green-500" />
                <Text className="text-lg font-semibold text-foreground">Basic</Text>
              </View>
              <Text className="lg:min-h-[44px] text-sm text-muted-foreground">
                More usage with the fast AI model for individuals getting started.
              </Text>

              <View className="lg:min-h-[100px] gap-1">
                <View className="gap-1">
                  <Text className="text-3xl lg:text-4xl font-bold text-foreground">
                    {regionalPricing
                      ? fmtPrice(billingInterval === 'monthly' ? basicPricing.monthly : Math.round(basicPricing.annual / 12), 'basic')
                      : `$${billingInterval === 'monthly' ? basicPricing.monthly : Math.round(basicPricing.annual / 12)}`}
                  </Text>
                </View>
                <Text className="text-sm text-muted-foreground">per month</Text>
                {billingInterval === 'annual' && !regionalPricing && (
                  <Text className="text-sm text-muted-foreground">
                    ${basicPricing.annual}/year (save ~17%)
                  </Text>
                )}
                {billingInterval === 'annual' && regionalPricing && (
                  <Text className="text-sm text-muted-foreground">
                    {fmtAnnualPrice(basicPricing.annual, 'basic')}/year
                  </Text>
                )}
              </View>

              <View className="hidden lg:block lg:min-h-[76px]" />

              <Pressable
                onPress={() => handleCheckout('basic', 1)}
                disabled={isCheckoutLoading}
                className="w-full items-center justify-center py-3 rounded-md bg-primary active:bg-primary/80"
              >
                <Text className="text-sm font-medium text-primary-foreground">
                  {subscription?.planId === 'basic' ? 'Current Plan' : 'Get Basic'}
                </Text>
              </Pressable>

              <View className="lg:flex-1 gap-2">
                <Text className="text-sm font-medium text-foreground">
                  {relativeUsageCopy('basic')}
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
        <View className="lg:w-[calc(50%-12px)] lg:flex-grow-0 xl:w-auto xl:flex-1 xl:basis-0 flex flex-col w-full max-w-[640px] self-center lg:max-w-none lg:self-auto" testID="plan-card-pro">
          <View className="hidden lg:block lg:min-h-8" />
          <Card className="lg:flex-1 flex flex-col">
            <CardContent className="lg:flex-1 flex flex-col p-5 gap-5">
              <View className="flex-row items-center gap-2">
                <Zap size={20} className="text-blue-500" />
                <Text className="text-lg font-semibold text-foreground">Pro</Text>
              </View>
              <Text className="lg:min-h-[44px] text-sm text-muted-foreground">
                Designed for fast-moving teams building together in real time.
              </Text>

              <View className="lg:min-h-[100px] gap-1">
                <View className="gap-1">
                  <Text className="text-3xl lg:text-4xl font-bold text-foreground">
                    {regionalPricing
                      ? fmtPrice(
                          billingInterval === 'monthly' ? proPricing.monthly * proSeats : Math.round((proPricing.annual / 12) * proSeats),
                          'pro'
                        )
                      : `$${billingInterval === 'monthly' ? proPricing.monthly * proSeats : Math.round((proPricing.annual / 12) * proSeats)}`}
                  </Text>
                </View>
                <Text className="text-sm text-muted-foreground">per month</Text>
                <Text className="text-sm text-muted-foreground">
                  {Platform.OS === 'ios'
                    ? `$${proPricing.monthly}/seat`
                    : `$${proPricing.monthly}/seat × ${proSeats} seat${proSeats === 1 ? '' : 's'} — raw cost + 20% on usage`}
                </Text>
                {billingInterval === 'annual' && regionalPricing && (
                  <Text className="text-sm text-muted-foreground">
                    {fmtAnnualPrice(proPricing.annual * proSeats, 'pro')}/year
                  </Text>
                )}
              </View>

              <View className="lg:min-h-[76px]">
                <Text className="text-sm font-medium text-foreground mb-2">
                  Seats
                </Text>
                {Platform.OS === 'ios' ? (
                  <Text className="text-xs text-muted-foreground">
                    iOS purchases include 1 seat per subscription.
                  </Text>
                ) : (
                  <SeatCounter
                    value={proSeats}
                    onChange={setProSeats}
                    min={1}
                    max={500}
                    label="Usage windows scale per seat"
                  />
                )}
              </View>

              <Pressable
                onPress={() => handleCheckout('pro', proSeats)}
                disabled={isCheckoutLoading}
                className="w-full items-center justify-center py-3 rounded-md bg-primary active:bg-primary/80"
              >
                <Text className="text-sm font-medium text-primary-foreground">
                  {subscription?.planId?.startsWith('pro') ? 'Change Plan' : 'Upgrade to Pro'}
                </Text>
              </Pressable>

              <View className="lg:flex-1 gap-2">
                <Text className="text-sm font-medium text-foreground">
                  {relativeUsageCopy('pro')}
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
        <View className="lg:w-[calc(50%-12px)] lg:flex-grow-0 xl:w-auto xl:flex-1 xl:basis-0 flex flex-col w-full max-w-[640px] self-center lg:max-w-none lg:self-auto" testID="plan-card-business">
          <View className="min-h-8 items-center justify-center px-1">
            <Badge className="bg-primary">
              <Text className="text-xs text-primary-foreground font-medium">Most Popular</Text>
            </Badge>
          </View>
          <Card className="lg:flex-1 flex flex-col border-primary">
            <CardContent className="lg:flex-1 flex flex-col p-5 gap-5">
              <View className="flex-row items-center gap-2">
                <Building2 size={20} className="text-purple-500" />
                <Text className="text-lg font-semibold text-foreground">Business</Text>
              </View>
              <Text className="lg:min-h-[44px] text-sm text-muted-foreground">
                Advanced controls and power features for growing departments
              </Text>

              <View className="lg:min-h-[100px] gap-1">
                <View className="gap-1">
                  <Text className="text-3xl lg:text-4xl font-bold text-foreground">
                    {regionalPricing
                      ? fmtPrice(
                          billingInterval === 'monthly' ? businessPricing.monthly * businessSeats : Math.round((businessPricing.annual / 12) * businessSeats),
                          'business'
                        )
                      : `$${billingInterval === 'monthly' ? businessPricing.monthly * businessSeats : Math.round((businessPricing.annual / 12) * businessSeats)}`}
                  </Text>
                </View>
                <Text className="text-sm text-muted-foreground">per month</Text>
                <Text className="text-sm text-muted-foreground">
                  {Platform.OS === 'ios'
                    ? `$${businessPricing.monthly}/seat`
                    : `$${businessPricing.monthly}/seat × ${businessSeats} seat${businessSeats === 1 ? '' : 's'} — raw cost + 20% on usage`}
                </Text>
                {billingInterval === 'annual' && regionalPricing && (
                  <Text className="text-sm text-muted-foreground">
                    {fmtAnnualPrice(businessPricing.annual * businessSeats, 'business')}/year
                  </Text>
                )}
              </View>

              <View className="lg:min-h-[76px]">
                <Text className="text-sm font-medium text-foreground mb-2">
                  Seats
                </Text>
                {Platform.OS === 'ios' ? (
                  <Text className="text-xs text-muted-foreground">
                    iOS purchases include 1 seat per subscription.
                  </Text>
                ) : (
                  <SeatCounter
                    value={businessSeats}
                    onChange={setBusinessSeats}
                    min={1}
                    max={500}
                    label="Usage windows scale per seat"
                  />
                )}
              </View>

              <Pressable
                onPress={() => handleCheckout('business', businessSeats)}
                disabled={isCheckoutLoading}
                className="w-full items-center justify-center py-3 rounded-md bg-primary active:bg-primary/80"
              >
                <Text className="text-sm font-medium text-primary-foreground">
                  {subscription?.planId?.startsWith('business') ? 'Change Plan' : 'Upgrade to Business'}
                </Text>
              </Pressable>

              <View className="lg:flex-1 gap-2">
                <Text className="text-sm font-medium text-foreground">
                  {relativeUsageCopy('business')}
                </Text>
                <FeatureList features={BUSINESS_FEATURES} />
              </View>
            </CardContent>
          </Card>
        </View>

        {/* Enterprise Plan */}
        <View className="lg:w-[calc(50%-12px)] lg:flex-grow-0 xl:w-auto xl:flex-1 xl:basis-0 flex flex-col w-full max-w-[640px] self-center lg:max-w-none lg:self-auto" testID="plan-card-enterprise">
          <View className="hidden lg:block lg:min-h-8" />
          <Card className="lg:flex-1 flex flex-col">
            <CardContent className="lg:flex-1 flex flex-col p-5 gap-5">
              <View className="flex-row items-center gap-2">
                <Crown size={20} className="text-amber-500" />
                <Text className="text-lg font-semibold text-foreground">Enterprise</Text>
              </View>
              <Text className="lg:min-h-[44px] text-sm text-muted-foreground">
                Built for large orgs needing flexibility, scale, and governance.
              </Text>

              <View className="lg:min-h-[100px]">
                <Text className="text-3xl lg:text-4xl font-bold text-foreground">Custom</Text>
                <Text className="text-sm text-muted-foreground">Flexible plans</Text>
              </View>

              <View className="hidden lg:block lg:min-h-[76px]" />

              <Pressable
                onPress={() => Linking.openURL('mailto:sales@shogo.ai')}
                className="w-full items-center justify-center py-3 rounded-md border border-border active:bg-muted"
              >
                <Text className="text-sm font-medium text-foreground">Book a demo</Text>
              </Pressable>

              <View className="lg:flex-1">
                <FeatureList features={ENTERPRISE_FEATURES} />
              </View>
            </CardContent>
          </Card>
        </View>
      </View>

      {Platform.OS === 'ios' && (
        <Card className="mt-6">
          <CardContent className="p-4 gap-3">
            <View className="gap-1">
              <Text className="text-sm font-semibold text-foreground">Manage billing on the web</Text>
              <Text className="text-sm text-muted-foreground">
                Additional seats and usage payment settings are managed from your web account.
              </Text>
            </View>
            <Button variant="outline" onPress={handleManageBillingOnWeb}>
              <Text className="text-foreground font-medium text-sm">Manage on the web</Text>
            </Button>
          </CardContent>
        </Card>
      )}

      {/*
        App Store Guideline 3.1.2(c) — Auto-renewable subscriptions must
        disclose, inside the app, the subscription title, length, price,
        and functional links to the Privacy Policy and Terms of Use
        (EULA). Title / length / price live on each plan card above; this
        block carries the legal links + the renewal/cancellation language
        Apple requires alongside any IAP subscription UI. Rendering it on
        iOS only (where IAP is offered) keeps the surface relevant.
      */}
      {Platform.OS === 'ios' && (
        <View className="mt-6 gap-3 px-1">
          <Text className="text-xs leading-5 text-muted-foreground">
            Subscriptions renew automatically at the price shown on each plan above
            until cancelled. Payment is charged to your Apple ID at confirmation of
            purchase. You can manage or cancel your subscription anytime in
            Settings &gt; Apple ID &gt; Subscriptions. Any unused portion of a free
            trial is forfeited when you purchase a subscription.
          </Text>
          <View className="flex-row flex-wrap gap-x-4 gap-y-1">
            <Pressable
              accessibilityRole="link"
              onPress={() => WebBrowser.openBrowserAsync('https://shogo.ai/terms')}
            >
              <Text className="text-xs text-primary underline">Terms of Use (EULA)</Text>
            </Pressable>
            <Pressable
              accessibilityRole="link"
              onPress={() => WebBrowser.openBrowserAsync('https://shogo.ai/privacy')}
            >
              <Text className="text-xs text-primary underline">Privacy Policy</Text>
            </Pressable>
            <Pressable
              accessibilityRole="link"
              onPress={() => Linking.openURL(APP_STORE_SUBSCRIPTIONS_URL)}
            >
              <Text className="text-xs text-primary underline">Manage subscription</Text>
            </Pressable>
          </View>
        </View>
      )}

      </View>
    </ScrollView>
  )
})

