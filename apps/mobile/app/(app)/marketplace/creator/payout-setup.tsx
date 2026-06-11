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
import { ArrowLeft, AlertCircle, ShieldCheck, Building2, ExternalLink } from 'lucide-react-native'
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
  const params = useLocalSearchParams<{ connect?: string }>()

  const [payoutStatus, setPayoutStatus] = useState<string>('not_setup')
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadStatus = useCallback(async () => {
    try {
      const res = await http.get<{ profile: { payoutStatus: string } }>(
        '/api/marketplace/creator/profile',
      )
      setPayoutStatus(res.data.profile.payoutStatus)
    } catch {
      // Profile may not exist yet; ignore.
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

  const startOnboarding = useCallback(async () => {
    setWorking(true)
    setError(null)
    try {
      const res = await http.post<{ onboardUrl?: string; error?: string }>(
        '/api/marketplace/creator/connect/onboard',
        {},
      )
      const url = res.data?.onboardUrl
      if (!url) {
        setError('Could not start payout onboarding. Please try again.')
        return
      }
      if (Platform.OS === 'web') {
        if (typeof window !== 'undefined') window.open(url, '_self')
        return
      }
      await WebBrowser.openBrowserAsync(url)
      await loadStatus()
    } catch {
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

  return (
    <View className="flex-1 bg-background">
      <View className="flex-row items-center gap-3 px-5 pt-3 pb-2 border-b border-border">
        <Pressable onPress={() => router.back()} hitSlop={6} className="p-1">
          <ArrowLeft size={20} color="#71717a" />
        </Pressable>
        <Text className="text-base font-semibold text-foreground flex-1">
          Payout setup
        </Text>
      </View>

      <ScrollView
        className="flex-1"
        contentContainerStyle={{ padding: 20, paddingBottom: 40 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Status pill */}
        <View className="flex-row items-center gap-3 mb-5 px-4 py-3 rounded-2xl border border-border bg-card">
          <View className={cn('w-3 h-3 rounded-full', payoutStatusColor(payoutStatus))} />
          <View className="flex-1">
            <Text className="text-sm font-semibold text-foreground">Payout status</Text>
            <Text className="text-xs text-muted-foreground">
              {payoutStatusLabel(payoutStatus)}
            </Text>
          </View>
        </View>

        {/* Trust paragraph */}
        <View className="rounded-2xl border border-blue-500/30 bg-blue-500/5 p-4 mb-5 flex-row gap-3">
          <View className="rounded-full bg-blue-500/15 w-8 h-8 items-center justify-center mt-0.5">
            <ShieldCheck size={14} color="#3b82f6" />
          </View>
          <View className="flex-1">
            <Text className="text-sm font-semibold text-foreground mb-1">
              Get paid through Stripe
            </Text>
            <Text className="text-xs text-foreground/70 leading-5">
              We use Stripe Connect to verify your identity and send payouts.
              You&apos;ll complete a short, secure onboarding hosted by Stripe —
              none of these details touch Shogo&apos;s servers. If you&apos;re
              also an affiliate, this is the same account used for both.
            </Text>
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
        ) : (
          <Pressable
            onPress={startOnboarding}
            disabled={working}
            className={cn(
              'flex-row items-center justify-center gap-2 py-3.5 rounded-xl',
              working ? 'bg-primary/60' : 'bg-primary',
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
      </ScrollView>
    </View>
  )
})
