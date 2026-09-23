// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Creator payout setup — launches Stripe-hosted Connect onboarding.
 *
 * Creators (and affiliates, when the same user) are paid through a single
 * shared Stripe Express account. KYC/identity + bank details are collected on
 * Stripe's hosted onboarding page rather than an in-app form; `account.updated`
 * webhooks drive the creator's payoutStatus. On return from the hosted flow
 * (return_url adds `?connect=done`) we re-read the live status.
 */

import { useState, useEffect, useCallback } from 'react'
import {
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
  Platform,
} from 'react-native'
import * as WebBrowser from 'expo-web-browser'
import { useRouter, useLocalSearchParams } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { ArrowLeft, AlertCircle, ShieldCheck, Building2, ExternalLink, Check } from 'lucide-react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useDomainHttp } from '../../../../contexts/domain'
import { cn } from '@shogo/shared-ui/primitives'

function payoutStatusColor(status: string): string {
  if (status === 'verified') return 'bg-green-500'
  if (status === 'pending_verification' || status === 'requires_update') return 'bg-yellow-500'
  if (status === 'disabled') return 'bg-red-500'
  return 'bg-gray-400'
}

function payoutStatusLabel(status: string): string {
  if (status === 'verified') return 'Verified'
  if (status === 'pending_verification') return 'Pending verification'
  if (status === 'requires_update') return 'Action required'
  if (status === 'disabled') return 'Disabled'
  return 'Not set up'
}

export default observer(function PayoutSetupScreen() {
  const router = useRouter()
  const http = useDomainHttp()
  const insets = useSafeAreaInsets()
  const params = useLocalSearchParams<{ connect?: string }>()

  const [payoutStatus, setPayoutStatus] = useState<string>('not_setup')
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Re-read the live Connect status (the endpoint re-syncs from Stripe and
  // persists), so the screen reflects a now-verified/pending account without
  // waiting on the `account.updated` webhook.
  const loadStatus = useCallback(async () => {
    try {
      const res = await http.get<{ payoutStatus: string }>(
        '/api/marketplace/creator/connect/status',
      )
      if (res.data?.payoutStatus) setPayoutStatus(res.data.payoutStatus)
    } catch {
      // Profile/account may not exist yet; ignore.
    } finally {
      setLoading(false)
    }
  }, [http])

  useEffect(() => {
    loadStatus()
  }, [loadStatus])

  // Returning from Stripe-hosted onboarding (return_url adds ?connect=done) —
  // re-read status so the screen reflects a now-verified account.
  useEffect(() => {
    if (params.connect === 'done' || params.connect === 'refresh') {
      loadStatus()
    }
  }, [params.connect, loadStatus])

  // Onboarding now opens in a separate tab on web, so the return lands there,
  // not here. Re-sync when this tab regains focus so it catches up too.
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return
    const onFocus = () => {
      if (document.visibilityState === 'visible') loadStatus()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [loadStatus])

  const startOnboarding = useCallback(async () => {
    // Open the tab synchronously inside the click handler so popup blockers
    // (which block window.open after an awaited request) allow it.
    const popup =
      Platform.OS === 'web' && typeof window !== 'undefined'
        ? window.open('', '_blank')
        : null
    setWorking(true)
    setError(null)
    try {
      const res = await http.post<{ onboardUrl?: string; error?: string }>(
        '/api/marketplace/creator/connect/onboard',
        {},
      )
      const url = res.data?.onboardUrl
      if (!url) {
        if (popup) popup.close()
        setError('Could not start payout onboarding. Please try again.')
        return
      }
      if (Platform.OS === 'web') {
        if (popup) popup.location.href = url
        else if (typeof window !== 'undefined') window.location.assign(url)
        return
      }
      await WebBrowser.openBrowserAsync(url)
      await loadStatus()
    } catch {
      if (popup) popup.close()
      setError('Could not start payout onboarding. Please try again.')
    } finally {
      setWorking(false)
    }
  }, [http, loadStatus])

  if (loading) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator size="large" />
      </View>
    )
  }

  const verified = payoutStatus === 'verified'
  // Details submitted; Stripe is still verifying. Don't offer to re-run
  // onboarding (that just loops through Stripe's review-and-confirm screen).
  const pending = payoutStatus === 'pending_verification'

  return (
    <View className="flex-1 bg-background">
      <View
        className="flex-row items-center gap-3 px-5 pb-3 border-b border-border/80 bg-background"
        style={{ paddingTop: Math.max(insets.top, 12) }}
      >
        <Pressable
          onPress={() => router.back()}
          hitSlop={8}
          className="w-9 h-9 items-center justify-center rounded-full border border-border bg-card active:opacity-70"
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <ArrowLeft size={18} color="#71717a" />
        </Pressable>
        <View className="flex-1">
          <Text className="text-[10px] font-semibold uppercase tracking-[1.5px] text-primary">
            Creator earnings
          </Text>
          <Text className="text-lg font-semibold tracking-tight text-foreground">
            Payout setup
          </Text>
        </View>
      </View>

      <ScrollView
        className="flex-1"
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 24,
          paddingBottom: Math.max(insets.bottom + 36, 64),
        }}
        showsVerticalScrollIndicator={false}
      >
        <View className="mx-auto w-full max-w-2xl">
          <View className="mb-6">
            <Text className="text-3xl font-semibold tracking-tight text-foreground">
              Get paid for your work.
            </Text>
            <Text className="mt-2 max-w-lg text-sm leading-5 text-muted-foreground">
              Connect the account that receives your marketplace earnings. Stripe
              handles verification and bank details securely.
            </Text>
          </View>

          {/* Status pill */}
          <View className="flex-row items-center gap-3 mb-4 px-4 py-3.5 rounded-2xl border border-primary/15 bg-primary/5">
            <View className={cn('w-2.5 h-2.5 rounded-full', payoutStatusColor(payoutStatus))} />
            <View className="flex-1">
              <Text className="text-[10px] font-semibold uppercase tracking-[1.2px] text-muted-foreground">
                Payout status
              </Text>
              <Text className="mt-0.5 text-sm font-semibold text-foreground">
                {payoutStatusLabel(payoutStatus)}
              </Text>
            </View>
            {verified ? <Check size={17} color="#16a34a" /> : <Building2 size={17} color="#e27927" />}
          </View>

          {/* Trust paragraph */}
          <View className="rounded-2xl border border-border/80 bg-card p-5 mb-5">
            <View className="flex-row gap-3">
              <View className="rounded-xl bg-primary/10 w-10 h-10 items-center justify-center">
                <ShieldCheck size={18} color="#e27927" />
              </View>
              <View className="flex-1">
                <Text className="text-sm font-semibold text-foreground mb-1">
                  A secure, hosted handoff
                </Text>
                <Text className="text-xs text-foreground/70 leading-5">
                  Stripe Connect verifies your identity and sends payouts. Your
                  bank and identity details stay on Stripe&apos;s secure onboarding
                  page, not in Shogo. Affiliates use this same connected account.
                </Text>
              </View>
            </View>
            <View className="mt-5 gap-3 border-t border-border/70 pt-4">
              <PayoutStep index="01" label="Confirm your details" />
              <PayoutStep index="02" label="Add a payout method" />
              <PayoutStep index="03" label="Stripe verifies your account" last />
            </View>
          </View>

          {error && (
            <View className="flex-row items-center gap-2 mb-4 px-4 py-3 rounded-xl bg-destructive/10">
              <AlertCircle size={16} color="#dc2626" />
              <Text className="text-sm text-destructive flex-1">{error}</Text>
            </View>
          )}

          {verified ? (
            <View className="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-4 flex-row items-center gap-3">
              <ShieldCheck size={18} color="#16a34a" />
              <Text className="text-sm text-foreground flex-1">
                Your payouts are set up. Earnings will be sent to your connected
                bank account.
              </Text>
            </View>
          ) : pending ? (
            <View className="rounded-2xl border border-yellow-500/30 bg-yellow-500/5 p-4 flex-row items-center gap-3">
              <ShieldCheck size={18} color="#ca8a04" />
              <Text className="text-sm text-foreground flex-1">
                Your details were submitted and Stripe is verifying your account.
                This can take a little while — you don&apos;t need to do anything
                else. We&apos;ll enable payouts as soon as it&apos;s approved.
              </Text>
            </View>
          ) : (
            <Pressable
              onPress={startOnboarding}
              disabled={working}
              className={cn(
                'flex-row items-center justify-center gap-2 py-4 rounded-2xl',
                working ? 'bg-primary/60' : 'bg-primary active:opacity-90',
              )}
            >
              {working ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  {payoutStatus === 'not_setup' ? (
                    <Building2 size={16} color="#fff" />
                  ) : (
                    <ExternalLink size={16} color="#fff" />
                  )}
                  <Text className="text-sm font-semibold text-primary-foreground">
                    {payoutStatus === 'not_setup'
                      ? 'Set up payouts with Stripe'
                      : 'Continue payout setup'}
                  </Text>
                </>
              )}
            </Pressable>
          )}
        </View>
      </ScrollView>
    </View>
  )
})

function PayoutStep({
  index,
  label,
  last = false,
}: {
  index: string
  label: string
  last?: boolean
}) {
  return (
    <View className={cn('flex-row items-center gap-3', !last && 'pb-3 border-b border-border/60')}>
      <Text className="w-5 text-[10px] font-semibold text-primary">{index}</Text>
      <Text className="flex-1 text-xs font-medium text-foreground">{label}</Text>
      <Check size={13} color="#a1a1aa" />
    </View>
  )
}
