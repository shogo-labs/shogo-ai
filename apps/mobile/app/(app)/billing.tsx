// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AppBillingPage - Mobile (Expo)
 *
 * Workspace billing and plan management:
 * - Current plan card with workspace avatar
 * - Usage remaining card (in USD)
 * - Monthly/Annual billing toggle
 * - Basic / Business / Enterprise plan cards with included-USD selectors
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  View,
  Text,
  ScrollView,
  Pressable,
  TextInput,
  Platform,
  Alert,
  useWindowDimensions,
} from 'react-native'
import * as WebBrowser from 'expo-web-browser'
import * as ExpoLinking from 'expo-linking'
import { useRouter, useLocalSearchParams } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  ArrowLeft,
  Building2,
  Info,
  Sparkles,
  Crown,
  KeyRound,
} from 'lucide-react-native'
import { useAuth } from '../../contexts/auth'
import { useWorkspaceCollection, useDomainHttp } from '../../contexts/domain'
import { api } from '../../lib/api'
import { checkoutRedirectBase, completeNativeCheckout, redirectToCheckout } from '../../lib/stripe-checkout'
import { clearPendingLicenseCode } from '../../lib/pending-license'
import { purchaseSubscription, finishPurchase, restorePurchases, initIapListeners, IapError, APP_STORE_SUBSCRIPTIONS_URL } from '../../lib/iap'
import type { IapPurchaseResult } from '../../lib/iap'
import type { RegionalPricingResponse } from '../../lib/api'
import { getRewardfulReferral } from '../../lib/rewardful'
import { nativeActivePill } from '../../lib/native-active-shadow'
import { trackInitiateCheckout, trackPurchase, trackBillingView, trackPlanClick, trackPlanChange, trackCancel } from '../../lib/tracking'
import { resolveActiveWorkspaceId, setActiveWorkspaceId } from '../../lib/workspace-store'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { usePlatformConfig } from '../../lib/platform-config'
import { useBillingData, useBillingSummary } from '@shogo/shared-app/hooks'
import {
  PLAN_PRICING,
  BASIC_FEATURES,
  BUSINESS_FEATURES,
  ENTERPRISE_FEATURES,
  getWindowLimitsForPlan,
  formatUsd,
  formatCurrencyPrice,
  getPlanDisplayName,
  getWindowDisplays,
  getUsageLimitNotice,
  trialSeatsExceedCap,
} from '../../lib/billing-config'
import { SeatCounter } from '../../components/billing/SeatCounter'
import { SoloFounderCard } from '../../components/billing/SoloFounderCard'
import { BillingHistory } from '../../components/billing/BillingHistory'
import { BillingSummaryCard } from '../../components/billing/BillingSummaryCard'
import { PaymentIssueBanner } from '../../components/billing/PaymentIssueBanner'
import { PlanChangeDialog, type PlanChangeTarget } from '../../components/billing/PlanChangeDialog'
import { CancelSubscriptionDialog } from '../../components/billing/CancelSubscriptionDialog'
import { PlanComparison } from '../../components/billing/PlanComparison'
import { SetSpendLimitDialog } from '../../components/billing/SetSpendLimitDialog'
import { useToast, Toast, ToastTitle, ToastDescription } from '../../components/ui/toast'
import { FeatureList } from '../../components/billing/FeatureList'
import { UsageWindowBar } from '../../components/billing/UsageWindows'
import { formatApiError, fillErrorCodeMessage } from '@shogo/shared-app/chat'
import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogBody,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
} from '../../components/ui/alert-dialog'
import { Heading } from '../../components/ui/heading'
import { Text as UIText } from '../../components/ui/text'
import { Button as UIButton, ButtonText } from '../../components/ui/button'
import {
  Card,
  CardContent,
  Button,
  Badge,
  Skeleton,
  cn,
} from '@shogo/shared-ui/primitives'
import { openExternalLink } from '../../lib/open-external-link';

// ─── Rolling usage-window bar ──────────────────────────────

// Relative usage framing for plan cards (no dollar figures, like Codex /
// Claude Code). Expresses each tier's rolling-window allowance as a multiple
// of the entry paid tier (Basic), derived from the weekly window so copy
// stays in sync with ROLLING_WINDOW_LIMITS. Enterprise is uncapped.
const BASIC_WEEKLY_USD = getWindowLimitsForPlan('basic')?.weeklyUsd ?? 0

function relativeUsageCopy(planId: string): string {
  const limits = getWindowLimitsForPlan(planId)
  if (!limits) return 'Unlimited usage — no rate windows'
  if (!BASIC_WEEKLY_USD || limits.weeklyUsd <= BASIC_WEEKLY_USD) {
    return 'Standard 5-hour & weekly usage windows'
  }
  // Round to one decimal, dropping a trailing ".0" (e.g. 2.5×, 5×).
  const multiple = Number((limits.weeklyUsd / BASIC_WEEKLY_USD).toFixed(1))
  return `${multiple}× the usage of Basic — higher 5-hour & weekly windows`
}

// ─── Main Page ─────────────────────────────────────────────

function StartTrialButton({
  onPress,
  disabled,
  hint,
}: {
  onPress: () => void
  disabled: boolean
  /** Shown under the button when the trial cannot be started (e.g. seat cap). */
  hint?: string | null
}) {
  return (
    <View className="gap-1">
      <Pressable
        onPress={onPress}
        disabled={disabled}
        className={cn(
          'w-full items-center justify-center py-3 rounded-md bg-primary active:bg-primary/80',
          disabled && 'opacity-50',
        )}
      >
        <Text className="text-sm font-medium text-primary-foreground">Start 7-day free trial</Text>
      </Pressable>
      <Text className="text-xs text-center text-muted-foreground">
        {hint ?? '$0 today. Card required; cancel anytime.'}
      </Text>
    </View>
  )
}

export default observer(function BillingPage() {
  const router = useRouter()
  const {
    redeem: redeemParam,
    workspace: workspaceParam,
    trial: trialParam,
  } = useLocalSearchParams<{
    redeem?: string
    workspace?: string
    trial?: string
  }>()
  const { user, isLoading: isAuthLoading } = useAuth()
  const workspaces = useWorkspaceCollection()

  useEffect(() => {
    const ownWorkspaceIds = workspaces?.all?.map((workspace: any) => workspace.id) ?? []
    if (!workspaceParam || ownWorkspaceIds.length === 0 || workspaces?.isLoading) return
    const resolvedWorkspace = resolveActiveWorkspaceId(ownWorkspaceIds, workspaceParam, {
      listLoaded: true,
    })
    if (resolvedWorkspace) setActiveWorkspaceId(resolvedWorkspace)
  }, [workspaceParam, workspaces?.all, workspaces?.isLoading])

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
    shogoCredit,
    trialEligible,
    trialEndsAt,
    trialMaxSeats,
  } = useBillingData(currentWorkspace?.id)
  // A grant-conferred plan has no Stripe customer / portal, so hide
  // "Manage" / Stripe-only affordances and let "Free Plan"-style copy
  // adapt by checking `planSource === 'subscription'` instead of just
  // `subscription` truthiness.
  const hasStripeSubscription = planSource === 'subscription'

  // Desktop reaches the linked cloud workspace through the local bridge, so the
  // summary/plan-change/cancel calls take the same shape on both surfaces.
  const { localMode } = usePlatformConfig()
  const {
    summary: billingSummary,
    error: billingSummaryError,
    refetch: refetchBillingSummary,
  } = useBillingSummary(currentWorkspace?.id, { localMode })
  // A paid workspace changes its existing subscription; it never starts a
  // second Checkout (SHO-451).
  const isPaidWorkspace = hasStripeSubscription || planSource === 'grant'
  const [planChangeTarget, setPlanChangeTarget] = useState<PlanChangeTarget | null>(null)
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false)
  const [spendLimitOpen, setSpendLimitOpen] = useState(false)
  const [licenseBoxOpen, setLicenseBoxOpen] = useState(false)

  // One view event per mount, so we can see how often billing is opened and on
  // what plan.
  const billingViewTrackedRef = useRef(false)
  useEffect(() => {
    if (billingViewTrackedRef.current) return
    if (isBillingLoading || !currentWorkspace?.id) return
    billingViewTrackedRef.current = true
    trackBillingView({
      workspaceId: currentWorkspace.id,
      planId: billingSummary?.planId ?? subscription?.planId,
      hasSubscription: hasStripeSubscription,
    })
  }, [isBillingLoading, currentWorkspace?.id, billingSummary?.planId, subscription?.planId, hasStripeSubscription])

  // Coupled window display: when the weekly window is exhausted the user is
  // maxed out regardless of 5-hour headroom, so the 5-hour bar is forced to
  // 100% and a single at-limit notice (overage vs paused) is surfaced.
  const usageWindowDisplays = getWindowDisplays(usageWindows)
  const usageLimitNotice = getUsageLimitNotice({
    atLimit: usageWindowDisplays.fiveHour.atLimit || usageWindowDisplays.weekly.atLimit,
    overage: effectiveBalance
      ? {
          enabled: effectiveBalance.overageEnabled,
          active: effectiveBalance.overageActive,
          accumulatedUsd: effectiveBalance.overageAccumulatedUsd,
        }
      : undefined,
    countdown: usageWindowDisplays.weekly.atLimit
      ? usageWindowDisplays.weekly.countdown
      : usageWindowDisplays.fiveHour.countdown,
  })
  // Surface the expired-entitlement state even before a window is exhausted.
  const overageEntitlementExpired = !!effectiveBalance?.overageEnabled && effectiveBalance.overageActive === false

  const [billingInterval, setBillingInterval] = useState<'monthly' | 'annual'>('monthly')
  const [businessSeats, setBusinessSeats] = useState(1)

  // The interval and seat controls start from the subscription's own values, so
  // a plan change previews the change the customer actually has.
  const summarySyncedRef = useRef(false)
  useEffect(() => {
    if (summarySyncedRef.current || !billingSummary) return
    summarySyncedRef.current = true
    if (billingSummary.billingInterval) setBillingInterval(billingSummary.billingInterval)
    if (billingSummary.seats > 1) setBusinessSeats(billingSummary.seats)
  }, [billingSummary])

  const [isCheckoutLoading, setIsCheckoutLoading] = useState(false)
  const [isPortalLoading, setIsPortalLoading] = useState(false)
  const [isEndTrialLoading, setIsEndTrialLoading] = useState(false)
  const [endTrialConfirmOpen, setEndTrialConfirmOpen] = useState(false)
  const endTrialConfirmResolve = useRef<((confirmed: boolean) => void) | null>(null)
  const [regionalPricing, setRegionalPricing] = useState<RegionalPricingResponse | null>(null)
  const [isRestoreLoading, setIsRestoreLoading] = useState(false)
  const [licenseCode, setLicenseCode] = useState('')
  const [isRedeeming, setIsRedeeming] = useState(false)
  const licenseInputRef = useRef<TextInput>(null)
  const iapTransactionsInFlightRef = useRef<Map<string, Promise<'processed' | 'failed'>>>(new Map())
  const toast = useToast()
  const { width } = useWindowDimensions()
  const insets = useSafeAreaInsets()
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
    // The box is collapsed by default; a deep link opens it so the recipient
    // does not have to find it.
    setLicenseBoxOpen(true)
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

  const businessPricing = PLAN_PRICING.business
  const basicPricing = PLAN_PRICING.basic

  const fmtPrice = useCallback((usdAmount: number, planKey?: string, intervalOverride?: 'monthly' | 'annual') => {
    if (!regionalPricing || !planKey) return `$${usdAmount}`
    const localPlan = regionalPricing.plans[planKey]
    if (!localPlan) return `$${usdAmount}`
    const interval = intervalOverride ?? billingInterval
    const basePlan = PLAN_PRICING[planKey as keyof typeof PLAN_PRICING]
    const baseAmount = interval === 'monthly'
      ? basePlan?.monthly
      : (basePlan?.annual ? Math.round(basePlan.annual / 12) : undefined)
    const quantity = baseAmount ? Math.max(1, Math.round(usdAmount / baseAmount)) : 1
    const localAmount = interval === 'monthly' ? localPlan.monthly : Math.round(localPlan.annual / 12)
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

  const fmtPlanPrice = useCallback((planKey: 'basic' | 'business', monthlyUsd: number, annualUsd: number) => {
    return billingInterval === 'annual'
      ? fmtAnnualPrice(annualUsd, planKey)
      : fmtPrice(monthlyUsd, planKey)
  }, [billingInterval, fmtAnnualPrice, fmtPrice])

  const fmtMonthlyEquivalent = useCallback((planKey: 'basic' | 'business', annualUsd: number) => {
    return fmtPrice(Math.round(annualUsd / 12), planKey)
  }, [fmtPrice])

  const billingPeriodLabel = billingInterval === 'annual' ? 'per year' : 'per month'

  const fmtBillingDate = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

  // A trial never holds more than `trialMaxSeats` seats (SHO-422). The server
  // is the gate; this only stops the button offering a checkout it would
  // refuse. `trialMaxSeats` comes from workspace-plan, so nothing here
  // hardcodes the number, and the copy is the one shared message.
  const trialSeatLimitReached = trialSeatsExceedCap(businessSeats, trialMaxSeats)
  const trialSeatLimitHint = trialSeatLimitReached
    ? fillErrorCodeMessage('trial_seat_limit', { maxSeats: trialMaxSeats })
    : null

  // What the card is charged if the trial ends now: the plan's price for the
  // seats already on the subscription, at the subscription's OWN interval —
  // not the page's monthly/annual toggle, which the user can flip without
  // touching the subscription.
  //
  // It is exactly the list price: Shogo credit pays for Hoshi usage and never a
  // subscription, and nothing server-side applies it to the Stripe invoice
  // (SHO-572 fixed the quote that used to subtract it).
  const endTrialCharge = useMemo(() => {
    if (!subscription) return null
    const planKey: 'basic' | 'business' = (subscription.planId ?? '').toLowerCase().startsWith('business')
      ? 'business'
      : 'basic'
    const seats = Math.max(1, subscription.seats ?? 1)
    const annual = subscription.billingInterval === 'annual'
    const interval = annual ? 'annual' as const : 'monthly' as const
    const pricing = PLAN_PRICING[planKey]
    const listUsd = (annual ? pricing.annual : pricing.monthly) * seats
    const fmt = (usd: number) =>
      annual ? fmtAnnualPrice(usd, planKey) : fmtPrice(usd, planKey, interval)
    return {
      seats,
      amount: fmt(listUsd),
      listAmount: fmt(listUsd),
    }
  }, [subscription, fmtAnnualPrice, fmtPrice])

  // One string for both the native Alert and the web dialog, so the two cannot
  // drift.
  const endTrialConfirmBody = endTrialCharge
    ? `You'll be charged ${endTrialCharge.amount} today for ${endTrialCharge.seats} × ${planName} and the trial ends immediately. You can add more seats once the plan is paid.`
    : `Your card will be charged for ${planName} and the trial ends immediately. You can add more seats once the plan is paid.`

  const requestEndTrialConfirm = useCallback((): Promise<boolean> => {
    const body = endTrialConfirmBody
    if (Platform.OS !== 'web') {
      return new Promise((resolve) => {
        Alert.alert(
          'End trial and pay now?',
          body,
          [
            { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
            { text: 'End trial and pay', onPress: () => resolve(true) },
          ],
          { onDismiss: () => resolve(false) },
        )
      })
    }
    return new Promise((resolve) => {
      endTrialConfirmResolve.current = resolve
      setEndTrialConfirmOpen(true)
    })
  }, [endTrialConfirmBody])

  const handleEndTrial = useCallback(async () => {
    if (!currentWorkspace?.id) return
    const confirmed = await requestEndTrialConfirm()
    if (!confirmed) return
    setIsEndTrialLoading(true)
    try {
      const result = await api.endTrial(http, currentWorkspace.id)
      refetchSubscription()
      refetchUsageWallet()
      if (result?.latestInvoiceStatus === 'paid') {
        showIapToast('success', "Trial ended — you're on the paid plan", 'Your card was charged. You can add more seats now.')
      } else {
        showIapToast('info', 'Trial ended', 'Your first invoice is open. Pay it in Billing to finish switching to the paid plan.')
      }
    } catch (e) {
      showIapToast('error', 'Could not end the trial', formatApiError(e))
    } finally {
      setIsEndTrialLoading(false)
    }
  }, [currentWorkspace?.id, http, requestEndTrialConfirm, refetchSubscription, refetchUsageWallet, showIapToast])

  const closeEndTrialConfirm = useCallback((confirmed: boolean) => {
    endTrialConfirmResolve.current?.(confirmed)
    endTrialConfirmResolve.current = null
    setEndTrialConfirmOpen(false)
  }, [])

  const handleCheckout = useCallback(async (planType: 'business' | 'basic', seats: number, opts?: { trial?: boolean }) => {
    if (!currentWorkspace?.id) return
    // A workspace that already pays changes its existing subscription in place.
    // Opening a second Checkout would create a second Stripe subscription and
    // leave the first one billing (SHO-451).
    if (hasStripeSubscription && !opts?.trial) {
      trackPlanClick({
        planId: planType,
        action: 'change',
        billingInterval,
        seats,
        workspaceId: currentWorkspace.id,
      })
      setPlanChangeTarget({
        planId: planType,
        billingInterval,
        seats: planType === 'basic' ? 1 : Math.max(1, Math.floor(seats || 1)),
      })
      return
    }
    trackPlanClick({
      planId: planType,
      action: opts?.trial ? 'trial' : 'checkout',
      billingInterval,
      seats,
      workspaceId: currentWorkspace.id,
    })
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

      const redirectBase = checkoutRedirectBase()
      console.log('[Billing] checkout start', { planId, seats: safeSeats, billingInterval, isNative, redirectBase })
      trackInitiateCheckout({ planId, billingInterval, seats: safeSeats, workspaceId: currentWorkspace.id })

      const data = await api.createCheckoutSession(http, {
        workspaceId: currentWorkspace.id,
        planId,
        seats: safeSeats,
        billingInterval,
        userEmail: user?.email,
        referralId: getRewardfulReferral(),
        // Server re-checks eligibility; ineligible accounts get the normal checkout.
        ...(opts?.trial && { trial: true }),
        ...(redirectBase && {
          successUrl: `${redirectBase}/?workspace=${currentWorkspace.id}&checkout=success&session_id={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${redirectBase}/?workspace=${currentWorkspace.id}&checkout=canceled`,
        }),
      })
      console.log('[Billing] checkout session created', { url: data.url ? '(received)' : '(missing)' })

      if (data.url) {
        if (!isNative) {
          redirectToCheckout(data.url)
        } else {
          const { checkout, sessionId, verifiedCheckout } = await completeNativeCheckout(http, data.url)
          if (checkout === 'success' && sessionId && verifiedCheckout) {
            trackPurchase({ planId: verifiedCheckout.planId, billingInterval: verifiedCheckout.billingInterval ?? billingInterval, seats: verifiedCheckout.seats ?? safeSeats, value: verifiedCheckout.amountPaid, currency: verifiedCheckout.currency, workspaceId: currentWorkspace?.id, sessionId })
          }
          console.log('[Billing] refetching billing data...')
          refetchSubscription()
          refetchUsageWallet()
        }
      }
    } catch (e) {
      // Never swallow: the API's refusal (e.g. `trial_seat_limit`) is the only
      // thing that tells the user why the checkout did not open.
      console.warn('[Billing] checkout failed:', e)
      showIapToast('error', 'Could not start checkout', formatApiError(e))
    } finally {
      setIsCheckoutLoading(false)
    }
  }, [http, currentWorkspace?.id, billingInterval, user?.email, router, refetchSubscription, refetchUsageWallet, showIapToast, hasStripeSubscription])

  // The usage notice's "Start free trial" CTA lands here with `?trial=business`:
  // take them straight to Stripe's trial checkout for the Business plan rather
  // than making them find the right card on the page.
  const autoTrialStartedRef = useRef(false)
  useEffect(() => {
    if (trialParam !== 'business') return
    if (isBillingLoading || !currentWorkspace?.id) return
    if (!trialEligible || hasStripeSubscription) return
    // Above the trial seat cap the server would refuse it (SHO-422).
    if (trialSeatLimitReached) return
    if (autoTrialStartedRef.current) return
    autoTrialStartedRef.current = true
    void handleCheckout('business', businessSeats, { trial: true })
  }, [
    trialParam,
    isBillingLoading,
    currentWorkspace?.id,
    trialEligible,
    hasStripeSubscription,
    trialSeatLimitReached,
    businessSeats,
    handleCheckout,
  ])

  const handleManageSubscription = useCallback(async () => {
    if (!currentWorkspace?.id) return
    setIsPortalLoading(true)
    try {
      // iOS: route to native App Store subscriptions screen (Apple requirement).
      if (Platform.OS === 'ios') {
        try {
          await openExternalLink(APP_STORE_SUBSCRIPTIONS_URL)
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


  if (isAuthLoading || isBillingLoading) {
    return (
      <View
        className="flex-1 bg-background px-6"
        style={{ paddingTop: Math.max(insets.top + 24, 32), paddingBottom: Math.max(insets.bottom + 24, 32) }}
      >
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
      <View
        className="flex-1 bg-background px-6"
        style={{ paddingTop: Math.max(insets.top + 24, 32), paddingBottom: Math.max(insets.bottom + 24, 32) }}
      >
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

  const monthlyPill = nativeActivePill(billingInterval === 'monthly', { backgroundClass: 'bg-primary' })
  const annualPill = nativeActivePill(billingInterval === 'annual', { backgroundClass: 'bg-primary' })

  return (
    <>
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{
        paddingHorizontal: contentHorizontalPadding,
        paddingTop: Math.max(insets.top + 20, 28),
        paddingBottom: Math.max(insets.bottom + 32, 60),
        alignItems: 'center',
      }}
      showsVerticalScrollIndicator={false}
    >
      <View style={{ width: '100%', maxWidth: contentMaxWidth }}>
      {/* Header */}
      <View className="mb-6 flex-row items-center gap-3 border-b border-border/70 pb-5">
        <Pressable
          onPress={() => router.canGoBack() ? router.back() : router.replace('/(app)')}
          accessibilityRole="button"
          accessibilityLabel="Back"
          className="h-10 w-10 items-center justify-center rounded-full bg-muted/60 active:bg-muted"
        >
          <ArrowLeft size={20} className="text-foreground" />
        </Pressable>
        <View className="flex-1">
          <Text className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Workspace plan
          </Text>
          <Text className="mt-1 text-2xl font-semibold text-foreground">
            Billing
          </Text>
          <Text className="mt-1 text-sm text-muted-foreground">
            Manage your subscription plan and usage.
          </Text>
        </View>
      </View>

      {/* A payment problem outranks everything else on the page (SHO-451). */}
      <PaymentIssueBanner
        pastDue={billingSummary?.pastDue ?? null}
        isIos={Platform.OS === 'ios'}
        isBusy={isPortalLoading}
        onUpdateCard={handleManageSubscription}
        onPayInvoice={(url) => WebBrowser.openBrowserAsync(url)}
      />

      {/* The summary could not be read — say why instead of rendering a blank
          "Free Plan" card. A desktop install with no cloud link answers
          `cloud_not_connected`; a Stripe outage answers `stripe_error`. */}
      {billingSummaryError ? (
        <View
          className="mb-4 flex-row items-start gap-3 rounded-2xl border border-border bg-muted/60 p-4"
          testID="billing-summary-error"
        >
          <Info size={18} className="mt-0.5 text-muted-foreground" />
          <View className="flex-1 gap-2">
            <Text className="text-sm font-medium text-foreground">
              We couldn't load your plan details.
            </Text>
            <Text className="text-xs text-muted-foreground">{billingSummaryError}</Text>
            <Button variant="outline" size="sm" onPress={refetchBillingSummary} testID="billing-summary-retry">
              Try again
            </Button>
          </View>
        </View>
      ) : null}

      {/* What plan am I on, what will I pay next, which card pays it. Suppressed
          when the summary failed: the card would otherwise claim "Free Plan"
          for a workspace we simply could not read. */}
      {billingSummaryError ? null : (
        <BillingSummaryCard
          summary={billingSummary}
          workspaceName={currentWorkspace.name}
          isIos={Platform.OS === 'ios'}
          isPortalLoading={isPortalLoading}
          isRestoreLoading={isRestoreLoading}
          onManage={handleManageSubscription}
          onChangePlan={() => {
            const planId = (billingSummary?.planId ?? subscription?.planId ?? 'business').toLowerCase()
            setPlanChangeTarget({
              planId: planId.startsWith('basic') ? 'basic' : 'business',
              billingInterval: (billingSummary?.billingInterval ?? billingInterval) as 'monthly' | 'annual',
              seats: Math.max(1, billingSummary?.seats ?? subscription?.seats ?? 1),
            })
          }}
          onRestore={handleRestorePurchases}
        />
      )}

      {/* Shogo credit + free trial status */}
      {(shogoCredit && (shogoCredit.availableUsd > 0 || shogoCredit.pendingVerificationUsd > 0)) || trialEndsAt ? (
        <Card className="mb-4 rounded-2xl border-border shadow-none">
          <CardContent className="p-4 gap-2">
            {shogoCredit && shogoCredit.availableUsd > 0 && (
              <Text className="text-sm font-medium text-foreground">
                Shogo credit · ${shogoCredit.availableUsd.toFixed(2)} · Hoshi models
                {shogoCredit.expiresAt ? ` · expires ${fmtBillingDate(shogoCredit.expiresAt)}` : ''}
              </Text>
            )}
            {shogoCredit && !shogoCredit.emailVerified && shogoCredit.pendingVerificationUsd > 0 && (
              <Text className="text-sm text-muted-foreground">
                Verify your email to unlock ${shogoCredit.pendingVerificationUsd.toFixed(2)} more Shogo credit.
              </Text>
            )}
            {trialEndsAt && (
              <View className="gap-2">
                <Text className="text-sm text-muted-foreground">
                  Free trial ends {fmtBillingDate(trialEndsAt)}. Cancel anytime before then and you won't be charged.
                </Text>
                {/* A trial is capped at `trialMaxSeats` seats, so the way to buy
                    more is to end it and pay now (SHO-422). */}
                <Pressable
                  onPress={handleEndTrial}
                  disabled={isEndTrialLoading}
                  className={cn(
                    'self-start rounded-md border border-border bg-background px-3 py-2 active:bg-muted',
                    isEndTrialLoading && 'opacity-50',
                  )}
                  testID="end-trial-button"
                >
                  <Text className="text-sm font-medium text-foreground">
                    {isEndTrialLoading ? 'Ending trial…' : 'End trial and pay now'}
                  </Text>
                </Pressable>
              </View>
            )}
          </CardContent>
        </Card>
      ) : null}

      {/* Usage Display — time-gated rolling windows */}
      <Card className="mb-6 rounded-2xl border-border shadow-none">
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
              coupledFull={usageWindowDisplays.weekly.atLimit}
            />
            <UsageWindowBar
              label="Weekly window"
              window={usageWindows?.weekly}
            />
          </View>

          {/* Spend limit sits with the bars it caps, not buried in settings. */}
          {Platform.OS !== 'ios' && (
            <View className="flex-row items-center justify-between gap-3" testID="billing-spend-limit">
              <Text className="text-sm text-muted-foreground">
                Spending limit:{' '}
                <Text className="text-sm font-medium text-foreground">
                  {effectiveBalance?.overageHardLimitUsd != null
                    ? `${formatUsd(effectiveBalance.overageHardLimitUsd)} / mo`
                    : 'None'}
                </Text>
              </Text>
              <Pressable
                onPress={() => setSpendLimitOpen(true)}
                className="rounded-md border border-border bg-background px-3 py-1.5 active:bg-muted"
                accessibilityRole="button"
              >
                <Text className="text-xs font-medium text-foreground">Edit</Text>
              </Pressable>
            </View>
          )}

          {usageLimitNotice ? (
            <View
              className={cn(
                'flex-row items-center gap-2 rounded-md p-3',
                usageLimitNotice.tone === 'overage' || usageLimitNotice.tone === 'expired' ? 'bg-destructive/10' : 'bg-muted',
              )}
            >
              <Info
                size={16}
                className={usageLimitNotice.tone === 'overage' || usageLimitNotice.tone === 'expired' ? 'text-destructive' : 'text-muted-foreground'}
              />
              <Text
                className={cn(
                  'flex-1 text-sm',
                  usageLimitNotice.tone === 'overage' || usageLimitNotice.tone === 'expired' ? 'text-foreground font-medium' : 'text-muted-foreground',
                )}
              >
                {usageLimitNotice.text}
              </Text>
            </View>
          ) : !usageLimitNotice && overageEntitlementExpired ? (
            <View className="flex-row items-center gap-2 rounded-md p-3 bg-destructive/10">
              <Info size={16} className="text-destructive" />
              <Text className="flex-1 text-sm text-foreground font-medium">
                Your on-demand billing entitlement has expired. Reactivate your subscription or license to keep using on-demand usage.
              </Text>
            </View>
          ) : null}

          <View className="gap-2">
            <View className="flex-row items-center gap-2">
              <Info size={16} className="text-muted-foreground" />
              <Text className="text-sm text-muted-foreground">
                {Platform.OS === 'ios'
                  ? 'Usage is unlimited within rolling 5-hour and weekly limits. Each window resets on its own schedule.'
                  : 'Usage is billed at the AI provider\'s raw cost plus a flat 20% markup and is unlimited within rolling 5-hour and weekly limits (per seat on Pro/Business). When a window is exhausted, usage resumes after it resets.'}
              </Text>
            </View>
            {Platform.OS !== 'ios' && !usageLimitNotice && effectiveBalance?.overageEnabled && (
              <View className="flex-row items-center gap-2">
                <Info size={16} className="text-muted-foreground" />
                <Text className="text-sm text-muted-foreground">
                  Need more before a window resets? Overage charges in escalating trust blocks ($25 → $500, growing as blocks are paid){effectiveBalance.overageHardLimitUsd != null
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

      {/* Plans. A Free workspace gets the sales layout (Solo Founder + the three
          cards); a paid one gets a comparison with its current plan marked. */}
      {isPaidWorkspace ? (
        <>
          {Platform.OS !== 'ios' && (billingSummary?.planId ?? subscription?.planId ?? '')
            .toLowerCase()
            .startsWith('business') ? (
            <View className="mb-4">
              <SeatCounter
                value={businessSeats}
                onChange={setBusinessSeats}
                min={1}
                max={500}
                label="Seats"
              />
            </View>
          ) : null}
          <PlanComparison
            currentPlanId={billingSummary?.planId ?? subscription?.planId ?? 'free'}
            billingInterval={billingInterval}
            seats={businessSeats}
            isIos={Platform.OS === 'ios'}
            isBusy={isCheckoutLoading}
            onSelect={(planId) => {
              trackPlanClick({
                planId,
                action: 'change',
                billingInterval,
                seats: planId === 'basic' ? 1 : businessSeats,
                workspaceId: currentWorkspace.id,
              })
              setPlanChangeTarget({
                planId,
                billingInterval,
                seats: planId === 'basic' ? 1 : Math.max(1, businessSeats),
              })
            }}
            onContactSales={() => {
              trackPlanClick({ planId: 'enterprise', action: 'contact', workspaceId: currentWorkspace.id })
              openExternalLink('mailto:sales@shogo.ai')
            }}
          />
        </>
      ) : (
        <>
          {/* The $99 Solo Founder offer: only for a Free workspace. iOS never
              shows the buy panel, and the card says so itself on any native build. */}
          <SoloFounderCard
            workspaceId={currentWorkspace.id}
            onPurchased={() => {
              refetchSubscription()
              refetchUsageWallet()
              refetchBillingSummary()
            }}
          />

          {/* Regional Currency Indicator */}
          {regionalPricing && (
            <View className="items-center mb-4">
              <View className="rounded-full border border-border bg-muted/60 px-3 py-1">
                <Text className="text-xs font-medium text-muted-foreground">
                  Prices shown in {regionalPricing.currency.name} ({regionalPricing.currency.code})
                </Text>
              </View>
            </View>
          )}

          {/* Billing Interval Toggle */}
          <View className="items-center mb-6">
            <View className="flex-row rounded-full border border-border bg-muted/60 p-1">
              <Pressable
                onPress={() => setBillingInterval('monthly')}
                className={cn(
                  'px-5 py-2 rounded-full',
                  monthlyPill.className,
                )}
                style={monthlyPill.style}
              >
                <Text className={cn(
                  'text-sm font-medium',
                  billingInterval === 'monthly' ? 'text-primary-foreground' : 'text-muted-foreground'
                )}>
                  Monthly
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setBillingInterval('annual')}
                className={cn(
                  'flex-row items-center gap-1.5 px-5 py-2 rounded-full',
                  annualPill.className,
                )}
                style={annualPill.style}
              >
                <Text className={cn(
                  'text-sm font-medium',
                  billingInterval === 'annual' ? 'text-primary-foreground' : 'text-muted-foreground'
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
      <View className="gap-4 lg:flex-row lg:flex-wrap lg:items-stretch xl:flex-nowrap" testID="plan-cards-row">
        {/* Basic Plan */}
        <View className="lg:w-[calc(50%-12px)] lg:flex-grow-0 xl:w-auto xl:flex-1 xl:basis-0 flex flex-col w-full max-w-[640px] self-center lg:max-w-none lg:self-auto" testID="plan-card-basic">
          <View className="hidden lg:block lg:min-h-8" />
          <Card className="lg:flex-1 flex flex-col rounded-2xl border-border shadow-none">
            <CardContent className="lg:flex-1 flex flex-col p-5 gap-5">
              <View className="flex-row items-center gap-2.5">
                <View className="h-9 w-9 items-center justify-center rounded-full bg-green-500/10">
                  <Sparkles size={18} className="text-green-500" />
                </View>
                <Text className="text-lg font-semibold text-foreground">Basic</Text>
              </View>
              <Text className="lg:min-h-[44px] text-sm text-muted-foreground">
                More usage with the fast AI model for individuals getting started.
              </Text>

              <View className="lg:min-h-[100px] gap-0.5">
                <Text className="text-3xl lg:text-4xl font-bold text-foreground tracking-tight">
                  {fmtPlanPrice('basic', basicPricing.monthly, basicPricing.annual)}
                </Text>
                <Text className="text-sm text-muted-foreground">{billingPeriodLabel}</Text>
                {billingInterval === 'annual' && (
                  <Text className="text-xs text-muted-foreground">
                    Equivalent to {fmtMonthlyEquivalent('basic', basicPricing.annual)}/month
                  </Text>
                )}
              </View>

              <View className="hidden lg:block lg:min-h-[76px]" />

              {trialEligible && !hasStripeSubscription && (
                <StartTrialButton
                  onPress={() => handleCheckout('basic', 1, { trial: true })}
                  disabled={isCheckoutLoading}
                />
              )}
              <Pressable
                onPress={() => handleCheckout('basic', 1)}
                disabled={isCheckoutLoading}
                className="w-full items-center justify-center py-3 rounded-md border border-border bg-background active:bg-muted"
              >
                <Text className="text-sm font-medium text-foreground">
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

        {/* Business Plan */}
        <View className="lg:w-[calc(50%-12px)] lg:flex-grow-0 xl:w-auto xl:flex-1 xl:basis-0 flex flex-col w-full max-w-[640px] self-center lg:max-w-none lg:self-auto" testID="plan-card-business">
          <View className="min-h-8 items-center justify-center px-1">
            <Badge className="rounded-full bg-primary px-3 py-1">
              <Text className="text-xs text-primary-foreground font-semibold">Most Popular</Text>
            </Badge>
          </View>
          <Card className="lg:flex-1 flex flex-col rounded-2xl border-2 border-primary bg-primary/[0.03] shadow-none">
            <CardContent className="lg:flex-1 flex flex-col p-5 gap-5">
              <View className="flex-row items-center gap-2.5">
                <View className="h-9 w-9 items-center justify-center rounded-full bg-purple-500/10">
                  <Building2 size={18} className="text-purple-500" />
                </View>
                <Text className="text-lg font-semibold text-foreground">Business</Text>
              </View>
              <Text className="lg:min-h-[44px] text-sm text-muted-foreground">
                Advanced controls and power features for growing departments
              </Text>

              <View className="lg:min-h-[100px] gap-0.5">
                <Text className="text-3xl lg:text-4xl font-bold text-foreground tracking-tight">
                  {fmtPlanPrice('business', businessPricing.monthly * businessSeats, businessPricing.annual * businessSeats)}
                </Text>
                <Text className="text-sm text-muted-foreground">{billingPeriodLabel}</Text>
                {billingInterval === 'annual' && (
                  <Text className="text-xs text-muted-foreground">
                    Equivalent to {fmtMonthlyEquivalent('business', businessPricing.annual * businessSeats)}/month
                  </Text>
                )}
              </View>

              {Platform.OS !== 'ios' && (
                <View className="lg:min-h-[76px]">
                  <SeatCounter
                    value={businessSeats}
                    onChange={setBusinessSeats}
                    min={1}
                    max={500}
                    label="Seats"
                  />
                </View>
              )}

              {trialEligible && !hasStripeSubscription && (
                <StartTrialButton
                  onPress={() => handleCheckout('business', businessSeats, { trial: true })}
                  disabled={isCheckoutLoading || trialSeatLimitReached}
                  hint={trialSeatLimitHint}
                />
              )}
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
        {Platform.OS !== 'ios' && (
        <View className="lg:w-[calc(50%-12px)] lg:flex-grow-0 xl:w-auto xl:flex-1 xl:basis-0 flex flex-col w-full max-w-[640px] self-center lg:max-w-none lg:self-auto" testID="plan-card-enterprise">
          <View className="hidden lg:block lg:min-h-8" />
          <Card className="lg:flex-1 flex flex-col rounded-2xl border-border shadow-none">
            <CardContent className="lg:flex-1 flex flex-col p-5 gap-5">
              <View className="flex-row items-center gap-2.5">
                <View className="h-9 w-9 items-center justify-center rounded-full bg-amber-500/10">
                  <Crown size={18} className="text-amber-500" />
                </View>
                <Text className="text-lg font-semibold text-foreground">Enterprise</Text>
              </View>
              <Text className="lg:min-h-[44px] text-sm text-muted-foreground">
                Built for large orgs needing flexibility, scale, and governance.
              </Text>

              <View className="lg:min-h-[100px] gap-0.5">
                <Text className="text-3xl lg:text-4xl font-bold text-foreground tracking-tight">Custom</Text>
                <Text className="text-sm text-muted-foreground">Flexible plans</Text>
              </View>

              <View className="hidden lg:block lg:min-h-[76px]" />

              <Pressable
                onPress={() => openExternalLink('mailto:sales@shogo.ai')}
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
        )}
      </View>
        </>
      )}

      {/* Invoices, pricing note, license key, cancel — the reference material. */}
      {Platform.OS !== 'ios' && (
        <BillingHistory workspaceId={currentWorkspace.id} limit={3} showViewAll />
      )}

      <View className="mb-4 gap-1 px-1">
        <Text className="text-xs text-muted-foreground">
          Usage beyond your plan is billed at model cost + 20%, capped by your spending limit.
        </Text>
        <Pressable
          onPress={() => WebBrowser.openBrowserAsync('https://docs.shogo.ai/billing')}
          accessibilityRole="link"
        >
          <Text className="text-xs text-primary underline">How usage billing works</Text>
        </Pressable>
      </View>

      {/* Redeem a license key — collapsed until asked for, and auto-opened by a
          `?redeem=` deep link (the recipient should not have to find it). */}
      {Platform.OS !== 'ios' && (
        <Card className="mb-4 rounded-2xl border-border shadow-none">
          <CardContent className="p-4 gap-3">
            <Pressable
              onPress={() => setLicenseBoxOpen((open) => !open)}
              className="flex-row items-center gap-2"
              accessibilityRole="button"
              testID="license-box-toggle"
            >
              <KeyRound size={16} className="text-primary" />
              <Text className="flex-1 text-sm font-medium text-foreground">
                Have a license key?
              </Text>
              <Text className="text-xs text-muted-foreground">
                {licenseBoxOpen || licenseCode ? 'Hide' : 'Redeem'}
              </Text>
            </Pressable>
            {licenseBoxOpen || licenseCode ? (
              <>
                <Text className="text-xs text-muted-foreground">
                  Redeem it to upgrade this workspace.
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
              </>
            ) : null}
          </CardContent>
        </Card>
      )}

      {/* Self-serve cancel / resume. iOS points at App Store subscriptions
          instead, which the legal block below already does. */}
      {Platform.OS !== 'ios' && hasStripeSubscription ? (
        <Pressable
          onPress={() => setCancelDialogOpen(true)}
          className="mb-6 self-center py-2"
          accessibilityRole="button"
          testID="billing-cancel-link"
        >
          <Text className="text-sm text-muted-foreground underline">
            {billingSummary?.cancelAtPeriodEnd ? 'Resume subscription' : 'Cancel subscription'}
          </Text>
        </Pressable>
      ) : null}


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
              onPress={() => openExternalLink(APP_STORE_SUBSCRIPTIONS_URL)}
            >
              <Text className="text-xs text-primary underline">Manage subscription</Text>
            </Pressable>
          </View>
        </View>
      )}

      </View>
    </ScrollView>

    {/* Plan change: price first, then confirm (SHO-451). */}
    <PlanChangeDialog
      visible={planChangeTarget != null}
      onClose={() => setPlanChangeTarget(null)}
      workspaceId={currentWorkspace.id}
      currentPlanId={billingSummary?.planId ?? subscription?.planId}
      target={planChangeTarget}
      localMode={localMode}
      onApplied={(result) => {
        trackPlanChange({
          fromPlanId: billingSummary?.planId ?? subscription?.planId,
          planId: result.planId,
          billingInterval: result.billingInterval,
          seats: result.seats,
          workspaceId: currentWorkspace.id,
        })
        refetchSubscription()
        refetchUsageWallet()
        refetchBillingSummary()
        showIapToast(
          'success',
          'Plan changed',
          `You're now on ${getPlanDisplayName(result.planId)} with ${result.seats} seat${result.seats === 1 ? '' : 's'}.`,
        )
      }}
    />

    {/* Self-serve cancel / resume. */}
    <CancelSubscriptionDialog
      visible={cancelDialogOpen}
      onClose={() => setCancelDialogOpen(false)}
      workspaceId={currentWorkspace.id}
      planId={billingSummary?.planId ?? subscription?.planId}
      currentPeriodEnd={billingSummary?.currentPeriodEnd ?? subscription?.currentPeriodEnd}
      cancelAtPeriodEnd={Boolean(billingSummary?.cancelAtPeriodEnd ?? subscription?.cancelAtPeriodEnd)}
      localMode={localMode}
      onSwitchToBasic={() =>
        setPlanChangeTarget({ planId: 'basic', billingInterval, seats: 1 })
      }
      onChanged={(action) => {
        trackCancel({
          planId: billingSummary?.planId ?? subscription?.planId,
          action,
          workspaceId: currentWorkspace.id,
        })
        refetchSubscription()
        refetchUsageWallet()
        refetchBillingSummary()
        showIapToast(
          'success',
          action === 'cancel' ? 'Subscription cancelled' : 'Subscription resumed',
          action === 'cancel'
            ? 'You keep access until the end of the period you paid for.'
            : 'Your plan will keep renewing.',
        )
      }}
    />

    {/* Spending limit, editable from the usage card. */}
    <SetSpendLimitDialog
      visible={spendLimitOpen}
      onClose={() => setSpendLimitOpen(false)}
      workspaceId={currentWorkspace.id}
      currentLimitUsd={effectiveBalance?.overageHardLimitUsd ?? null}
      accumulatedUsageUsd={effectiveBalance?.overageAccumulatedUsd}
      onSaved={() => {
        refetchUsageWallet()
        refetchBillingSummary()
      }}
    />

    {/* Web confirm for "End trial and pay now" (SHO-422). Native uses
        `Alert.alert` with the same copy, so the action always has friction. */}
    {Platform.OS === 'web' && (
      <AlertDialog isOpen={endTrialConfirmOpen} onClose={() => closeEndTrialConfirm(false)} size="sm">
        <AlertDialogBackdrop />
        <AlertDialogContent testID="end-trial-confirm">
          <AlertDialogHeader>
            <Heading size="md" className="text-typography-950">
              End trial and pay now?
            </Heading>
          </AlertDialogHeader>
          <AlertDialogBody className="mb-4 mt-3">
            <UIText size="sm" className="text-typography-700">
              {endTrialConfirmBody}
            </UIText>
          </AlertDialogBody>
          <AlertDialogFooter>
            <UIButton variant="outline" action="secondary" onPress={() => closeEndTrialConfirm(false)} accessibilityLabel="Cancel">
              <ButtonText>Cancel</ButtonText>
            </UIButton>
            <UIButton action="primary" onPress={() => closeEndTrialConfirm(true)} accessibilityLabel="End trial and pay">
              <ButtonText>End trial and pay</ButtonText>
            </UIButton>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    )}
  </>
  )
})

