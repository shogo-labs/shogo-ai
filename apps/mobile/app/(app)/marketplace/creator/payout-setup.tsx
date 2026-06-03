// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Creator payout setup screen.
 *
 * Default: redirects the creator to Stripe's hosted onboarding flow
 * via an Account Links URL minted server-side by
 * `POST /api/marketplace/creator/payout-onboarding-link`. Stripe collects
 * all KYC fields (identity, address, DOB, SSN, document upload, bank
 * account) on their own pages, then redirects back here.
 *
 * Escape hatch: append `?legacy=1` to the URL to render the previous
 * hand-rolled KYC form, which posts to `/api/marketplace/creator/payout-details`.
 * Useful if the hosted flow has issues — we can fall back without a
 * redeploy. Remove once hosted onboarding is proven.
 */

import { useState, useEffect, useCallback } from 'react'
import { View, Text, Pressable, ActivityIndicator, Platform } from 'react-native'
import { useRouter, useLocalSearchParams } from 'expo-router'
import { observer } from 'mobx-react-lite'
import * as ExpoLinking from 'expo-linking'
import * as WebBrowser from 'expo-web-browser'
import {
  ArrowLeft,
  AlertCircle,
  ExternalLink,
  ShieldCheck,
  RefreshCw,
} from 'lucide-react-native'
import { useDomainHttp } from '../../../../contexts/domain'
import { cn } from '@shogo/shared-ui/primitives'
import PayoutLegacyForm from '../../../../components/marketplace/PayoutLegacyForm'

type PayoutStatusValue =
  | 'not_setup'
  | 'pending'
  | 'pending_verification'
  | 'verified'
  | 'requires_update'
  | 'disabled'

interface CreatorProfile {
  payoutStatus: PayoutStatusValue
}

interface AccountStatus {
  chargesEnabled: boolean
  payoutsEnabled: boolean
  detailsSubmitted: boolean
  requiresAction: boolean
  currentlyDue: string[]
}

function payoutStatusColor(status: PayoutStatusValue | string): string {
  if (status === 'verified') return 'bg-green-500'
  if (status === 'pending' || status === 'pending_verification')
    return 'bg-yellow-500'
  if (status === 'requires_update') return 'bg-orange-500'
  if (status === 'disabled') return 'bg-red-500'
  return 'bg-gray-400'
}

function payoutStatusLabel(status: PayoutStatusValue | string): string {
  if (status === 'verified') return 'Verified — payouts enabled'
  if (status === 'pending' || status === 'pending_verification')
    return 'Pending verification'
  if (status === 'requires_update') return 'Action needed'
  if (status === 'disabled') return 'Disabled'
  return 'Not set up'
}

function buildReturnUrls(): { refreshUrl: string; returnUrl: string } {
  // Stripe needs absolute URLs. On web, the user is already at
  // /marketplace/creator/payout-setup — round-trip back to it with
  // marker query params so we know to refetch status on return.
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    const base = `${window.location.origin}/marketplace/creator/payout-setup`
    return {
      refreshUrl: `${base}?refresh=1`,
      returnUrl: `${base}?return=1`,
    }
  }
  // Native: use the app's deep link so Stripe redirects back into the app.
  const base = ExpoLinking.createURL('marketplace/creator/payout-setup')
  return {
    refreshUrl: `${base}?refresh=1`,
    returnUrl: `${base}?return=1`,
  }
}

export default observer(function PayoutSetupScreen() {
  const router = useRouter()
  const http = useDomainHttp()
  const params = useLocalSearchParams<{ legacy?: string; return?: string }>()

  if (params.legacy === '1') {
    return <PayoutLegacyForm />
  }

  return <HostedPayoutSetup http={http} router={router} returnedFromStripe={params.return === '1'} />
})

function HostedPayoutSetup({
  http,
  router,
  returnedFromStripe,
}: {
  http: ReturnType<typeof useDomainHttp>
  router: ReturnType<typeof useRouter>
  returnedFromStripe: boolean
}) {
  const [payoutStatus, setPayoutStatus] = useState<PayoutStatusValue>('not_setup')
  const [acctStatus, setAcctStatus] = useState<AccountStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadStatus = useCallback(async () => {
    setError(null)
    try {
      const profileRes = await http.get<{ profile: CreatorProfile }>(
        '/api/marketplace/creator/profile',
      )
      setPayoutStatus(profileRes.data.profile.payoutStatus)

      // Best-effort: fetch live Stripe status too so we can show
      // "what's missing" if Stripe says action is required.
      try {
        const acctRes = await http.get<AccountStatus>(
          '/api/marketplace/creator/payout-status',
        )
        setAcctStatus(acctRes.data)
      } catch {
        // 400 here just means no Connect account yet — that's expected
        // pre-onboarding. Swallow and continue.
        setAcctStatus(null)
      }
    } catch (err: unknown) {
      const apiMsg =
        (err as { response?: { data?: { error?: string } } })?.response?.data
          ?.error ??
        (err as { data?: { error?: string } })?.data?.error
      setError(apiMsg || 'Failed to load payout status')
    } finally {
      setLoading(false)
    }
  }, [http])

  useEffect(() => {
    loadStatus()
  }, [loadStatus])

  // When the user comes back from Stripe's hosted flow, Stripe redirects
  // through our return_url with `?return=1`. Refetch so the UI reflects
  // the new state immediately.
  useEffect(() => {
    if (returnedFromStripe) {
      loadStatus()
    }
  }, [returnedFromStripe, loadStatus])

  const handleStartOnboarding = useCallback(async () => {
    setOpening(true)
    setError(null)
    try {
      const urls = buildReturnUrls()
      const res = await http.post<{ url: string }>(
        '/api/marketplace/creator/payout-onboarding-link',
        urls,
      )
      const { url } = res.data
      if (!url) {
        throw new Error('No onboarding URL returned')
      }
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        window.location.href = url
        return
      }
      try {
        const scheme = ExpoLinking.createURL('')
        await WebBrowser.openAuthSessionAsync(url, scheme)
      } finally {
        // After native flow closes, refresh status either way.
        await loadStatus()
      }
    } catch (err: unknown) {
      const apiMsg =
        (err as { response?: { data?: { error?: string } } })?.response?.data
          ?.error ??
        (err as { data?: { error?: string } })?.data?.error ??
        (err as Error)?.message
      setError(apiMsg || 'Failed to start Stripe onboarding')
    } finally {
      setOpening(false)
    }
  }, [http, loadStatus])

  if (loading) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator size="large" />
      </View>
    )
  }

  const isVerified = payoutStatus === 'verified'
  const isPending =
    payoutStatus === 'pending' || payoutStatus === 'pending_verification'
  const needsAction =
    payoutStatus === 'requires_update' ||
    payoutStatus === 'disabled' ||
    (!!acctStatus && acctStatus.requiresAction)
  const notStarted = payoutStatus === 'not_setup'

  const ctaLabel = (() => {
    if (isVerified) return 'Update payout details on Stripe'
    if (isPending) return 'Continue setup on Stripe'
    if (needsAction) return 'Resolve required info on Stripe'
    if (notStarted) return 'Set up payouts with Stripe'
    return 'Open Stripe onboarding'
  })()

  return (
    <View className="flex-1 bg-background">
      <View className="flex-row items-center gap-3 px-5 pt-3 pb-2 border-b border-border">
        <Pressable onPress={() => router.back()} hitSlop={6} className="p-1">
          <ArrowLeft size={20} color="#71717a" />
        </Pressable>
        <Text className="text-base font-semibold text-foreground flex-1">
          Payout setup
        </Text>
        <Pressable
          onPress={loadStatus}
          hitSlop={6}
          className="p-1"
          accessibilityLabel="Refresh status"
        >
          <RefreshCw size={16} color="#71717a" />
        </Pressable>
      </View>

      <View className="flex-1 px-5 pt-6 pb-10 gap-5 max-w-2xl">
        {/* Status pill */}
        <View className="flex-row items-center gap-3 px-4 py-3 rounded-2xl border border-border bg-card">
          <View
            className={cn(
              'w-3 h-3 rounded-full',
              payoutStatusColor(payoutStatus),
            )}
          />
          <View className="flex-1">
            <Text className="text-sm font-semibold text-foreground">
              Payout status
            </Text>
            <Text className="text-xs text-muted-foreground">
              {payoutStatusLabel(payoutStatus)}
            </Text>
          </View>
        </View>

        {/* Trust copy */}
        <View className="rounded-2xl border border-blue-500/30 bg-blue-500/5 p-4 flex-row gap-3">
          <View className="rounded-full bg-blue-500/15 w-8 h-8 items-center justify-center mt-0.5">
            <ShieldCheck size={14} color="#3b82f6" />
          </View>
          <View className="flex-1">
            <Text className="text-sm font-semibold text-foreground mb-1">
              Stripe handles the rest
            </Text>
            <Text className="text-xs text-foreground/70 leading-5">
              We&apos;ll send you to Stripe to verify your identity and link
              your bank account. None of this information is stored on
              Shogo&apos;s servers — it goes straight to Stripe.
            </Text>
          </View>
        </View>

        {/* What's currently due, if Stripe told us */}
        {acctStatus &&
          acctStatus.currentlyDue.length > 0 && (
            <View className="rounded-2xl border border-orange-500/30 bg-orange-500/5 p-4 gap-2">
              <Text className="text-sm font-semibold text-foreground">
                Stripe still needs:
              </Text>
              <View className="gap-1">
                {acctStatus.currentlyDue.map((field) => (
                  <Text
                    key={field}
                    className="text-xs text-foreground/80 leading-5"
                  >
                    • {humanizeStripeField(field)}
                  </Text>
                ))}
              </View>
            </View>
          )}

        {error && (
          <View className="flex-row items-center gap-2 px-4 py-3 rounded-xl bg-destructive/10">
            <AlertCircle size={16} color="#dc2626" />
            <Text className="text-sm text-destructive flex-1">{error}</Text>
          </View>
        )}

        <Pressable
          onPress={handleStartOnboarding}
          disabled={opening}
          className={cn(
            'flex-row items-center justify-center gap-2 py-3.5 rounded-xl',
            opening ? 'bg-primary/60' : 'bg-primary',
          )}
        >
          {opening ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <>
              <ExternalLink size={16} color="#fff" />
              <Text className="text-sm font-semibold text-primary-foreground">
                {ctaLabel}
              </Text>
            </>
          )}
        </Pressable>

        {isVerified && (
          <Text className="text-xs text-muted-foreground text-center">
            Your account is verified. Use the button above only to update
            payout details with Stripe.
          </Text>
        )}
      </View>
    </View>
  )
}

function humanizeStripeField(field: string): string {
  const map: Record<string, string> = {
    'individual.first_name': 'First name',
    'individual.last_name': 'Last name',
    'individual.email': 'Email',
    'individual.dob.day': 'Date of birth',
    'individual.dob.month': 'Date of birth',
    'individual.dob.year': 'Date of birth',
    'individual.address.line1': 'Street address',
    'individual.address.city': 'City',
    'individual.address.state': 'State',
    'individual.address.postal_code': 'Postal code',
    'individual.ssn_last_4': 'SSN (last 4)',
    'individual.id_number': 'Full SSN / ID number',
    'individual.verification.document':
      'Identity document upload (driver license or passport)',
    external_account: 'Bank account',
    'tos_acceptance.date': 'Terms of service acceptance',
    'tos_acceptance.ip': 'Terms of service acceptance',
  }
  return map[field] ?? field
}
