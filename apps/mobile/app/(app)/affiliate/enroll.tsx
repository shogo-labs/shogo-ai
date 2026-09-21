// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Affiliate enrollment screen — opt-in flow.
 *
 * Captures (optional) parent referrer code, optional custom slug, and
 * explicit terms acceptance. Server enforces all hard constraints
 * (self-referral, code-taken, parent depth, terms required).
 */

import { useCallback, useState } from 'react'
import { View, Text, ScrollView, Pressable, ActivityIndicator } from 'react-native'
import { useRouter } from 'expo-router'
import { ArrowLeft, AlertTriangle, Sparkles } from 'lucide-react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Card, CardContent, Button, Input } from '@shogo/shared-ui/primitives'
import { useDomainHttp } from '../../../contexts/domain'
import { affiliateApi } from '../../../lib/affiliate-api'

function describeError(code: string): string {
  switch (code) {
    case 'terms_required': return 'You must accept the affiliate terms to continue.'
    case 'invalid_code': return 'That code is not valid (use 2–40 letters, numbers, or dashes).'
    case 'code_taken': return 'That code is already taken.'
    case 'parent_not_found': return 'Referrer code not found.'
    case 'parent_too_deep': return 'Referrer is at the maximum chain depth.'
    case 'parent_inactive': return 'Referrer is not currently active.'
    case 'self_referral': return 'You cannot use your own code as the referrer.'
    case 'cycle': return 'That referrer link would create a cycle.'
    case 'feature_disabled': return 'The affiliate program is not yet available.'
    default: return 'Could not enroll right now. Please try again.'
  }
}

export default function AffiliateEnrollScreen() {
  const router = useRouter()
  const http = useDomainHttp()
  const insets = useSafeAreaInsets()
  const [code, setCode] = useState('')
  const [accepted, setAccepted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = useCallback(async () => {
    if (!accepted) {
      setError('Please accept the terms.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const res = await affiliateApi.enroll(http, {
        termsAccepted: true,
        code: code.trim() || undefined,
      })
      if (res?.ok) {
        router.replace('/(app)/creator?tab=refer')
      } else {
        setError(describeError(res?.error?.code ?? 'unknown'))
      }
    } catch (err: any) {
      const errCode = err?.body?.error?.code ?? err?.response?.body?.error?.code
      setError(describeError(errCode ?? 'unknown'))
    } finally {
      setSubmitting(false)
    }
  }, [accepted, code, http, router])

  return (
    <View className="flex-1 bg-background">
      <View
        className="flex-row items-center gap-3 px-5 pb-3 border-b border-border"
        style={{ paddingTop: Math.max(insets.top, 12) }}
      >
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <ArrowLeft size={22} className="text-foreground" />
        </Pressable>
        <View>
          <Text className="text-[11px] uppercase tracking-[1.5px] font-semibold text-muted-foreground">
            Creator earnings
          </Text>
          <Text className="text-lg font-semibold text-foreground">Become an affiliate</Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 20,
          paddingBottom: Math.max(insets.bottom, 16) + 28,
          gap: 20,
        }}
      >
        <View className="gap-2">
          <View className="h-10 w-10 rounded-xl bg-primary/10 items-center justify-center">
            <Sparkles size={19} className="text-primary" />
          </View>
          <Text className="text-2xl font-semibold tracking-tight text-foreground">
            Earn when you introduce Shogo
          </Text>
          <Text className="text-sm text-muted-foreground leading-5">
            Set up your referral link in a minute. You can customize your code now or
            let us make one for you.
          </Text>
        </View>

        <Card className="border-primary/20">
          <CardContent className="gap-3 p-5">
            <Text className="text-sm font-medium text-foreground">
              You'll get a unique link. When someone clicks it and pays for
              Shogo, you earn 20% of their seat subscription for the first 12
              months, then 10% forever after.
            </Text>
            <Text className="text-xs text-muted-foreground leading-5">
              Stripe issues a 1099-NEC if you earn $600+ in a calendar year.
              Self-referrals are not eligible. Commissions are held for a
              refund window before becoming payable.
            </Text>
          </CardContent>
        </Card>

        <View className="gap-2">
          <Text className="text-[11px] uppercase text-muted-foreground tracking-[1.5px] font-semibold">
            Custom slug (optional)
          </Text>
          <Input
            value={code}
            onChangeText={setCode}
            placeholder="your-name"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Text className="text-xs text-muted-foreground">
            Letters, numbers, and dashes. We'll generate one for you if you skip this.
          </Text>
        </View>

        <Pressable
          onPress={() => setAccepted((v) => !v)}
          className="flex-row items-start gap-3 rounded-xl bg-muted/40 p-4"
        >
          <View className={`w-5 h-5 rounded-md border ${accepted ? 'bg-primary border-primary' : 'border-border'} items-center justify-center mt-0.5`}>
            {accepted ? <Text className="text-primary-foreground text-xs">✓</Text> : null}
          </View>
          <Text className="text-xs text-foreground flex-1 leading-5">
            I have read and agree to the Shogo Affiliate Terms, including the
            FTC disclosure requirement when sharing my link, and I understand
            that commissions may be reversed on refund or chargeback.
          </Text>
        </Pressable>

        {error ? (
          <Card>
            <CardContent className="flex-row items-start gap-2 p-3">
              <AlertTriangle size={16} className="text-red-500 mt-0.5" />
              <Text className="text-xs text-foreground flex-1">{error}</Text>
            </CardContent>
          </Card>
        ) : null}

        <Button onPress={submit} disabled={submitting || !accepted} className="mt-1">
          {submitting ? <ActivityIndicator /> : (
            <Text className="text-primary-foreground font-medium">Enroll</Text>
          )}
        </Button>
      </ScrollView>
    </View>
  )
}
