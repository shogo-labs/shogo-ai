// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SoloFounderCard — the $99 Solo Founder offer on the Billing screen (SHO-428).
 *
 * Three states, all driven by `GET /api/billing/solo-founder`:
 * - Free workspace, eligible → the offer: what it costs, what it installs, and
 *   a promo-code field for codes handed out by a partner.
 * - Enrolled → lesson progress on the Course board and a link into #course.
 * - Not eligible because the workspace already pays, or nobody is signed in →
 *   nothing at all. A refusal card on your own billing page is just noise; the
 *   only one worth showing is the risk review, which needs a support ticket.
 *
 * The buy panel is web only: store rules require subscriptions to be sold
 * through IAP on iOS and Android, so a native build gets a one-line card that
 * says what it costs and opens the web page instead.
 */
import { useCallback, useEffect, useState } from 'react'
import { View, Text, TextInput, Platform, Linking } from 'react-native'
import { useRouter } from 'expo-router'
import { Sparkles, ArrowRight, GraduationCap } from 'lucide-react-native'
import { ERROR_CODE_MESSAGES } from '@shogo/shared-app/chat'
import { Card, CardContent, Button, Badge } from '@shogo/shared-ui/primitives'
import { useDomainHttp } from '../../contexts/domain'
import { api, type SoloFounderState } from '../../lib/api'
import { checkoutRedirectBase, completeNativeCheckout, redirectToCheckout } from '../../lib/stripe-checkout'

/** The offer is sold through Stripe Checkout, which store billing rules keep off iOS and Android. */
const WEB_BILLING_URL = `${process.env.EXPO_PUBLIC_WEB_URL ?? 'https://studio.shogo.ai'}/billing?offer=solo-founder`

/**
 * Turn a checkout failure into something a buyer can act on. The server sends
 * `{ error: { code, message, reason } }`; the SDK puts that body on `details`.
 * The shared `ERROR_CODE_MESSAGES` map covers a code that arrives without its
 * message.
 */
function offerErrorMessage(err: unknown): string {
  const detail = (err as { details?: { error?: { code?: string; message?: string } } })?.details?.error
  if (detail?.message) return detail.message
  if (detail?.code && ERROR_CODE_MESSAGES[detail.code]) return ERROR_CODE_MESSAGES[detail.code]
  const message = err instanceof Error ? err.message : ''
  if (message && !/status code|Unexpected/i.test(message)) return message
  return 'Could not start checkout. Please try again in a moment.'
}

function ProgressBar({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
  return (
    <View className="h-2 w-full overflow-hidden rounded-full bg-muted">
      <View className="h-2 rounded-full bg-primary" style={{ width: `${pct}%` }} />
    </View>
  )
}

export function SoloFounderCard({
  workspaceId,
  onPurchased,
}: {
  workspaceId: string | undefined
  /** Called after a completed checkout so the screen can refetch plan + usage. */
  onPurchased?: () => void
}) {
  const http = useDomainHttp()
  const router = useRouter()
  const [state, setState] = useState<SoloFounderState | null>(null)
  const [promo, setPromo] = useState('')
  const [isBuying, setIsBuying] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!workspaceId) return
    try {
      setState(await api.getSoloFounderState(http, workspaceId))
    } catch (err) {
      // Billing still works without the offer; do not shout about it.
      console.warn('[SoloFounder] state failed:', err)
    }
  }, [http, workspaceId])

  useEffect(() => {
    void load()
  }, [load])

  const handleBuy = useCallback(async () => {
    if (!workspaceId) return
    setIsBuying(true)
    setError(null)
    try {
      const redirectBase = checkoutRedirectBase()
      const data = await api.createSoloFounderCheckout(http, {
        workspaceId,
        offer: 'solo_founder',
        ...(promo.trim() ? { promoCode: promo.trim() } : {}),
        ...(redirectBase && {
          successUrl: `${redirectBase}/?workspace=${workspaceId}&checkout=success&offer=solo_founder&session_id={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${redirectBase}/?workspace=${workspaceId}&checkout=canceled`,
        }),
      })
      if (!data?.url) {
        setError('Could not start checkout. Please try again in a moment.')
        return
      }
      if (Platform.OS === 'web') {
        redirectToCheckout(data.url)
        return
      }
      const { checkout, sessionId, verifiedCheckout } = await completeNativeCheckout(http, data.url)
      if (checkout === 'success' && sessionId && verifiedCheckout) {
        await load()
        onPurchased?.()
      }
    } catch (err) {
      console.warn('[SoloFounder] checkout failed:', err)
      setError(offerErrorMessage(err))
    } finally {
      setIsBuying(false)
    }
  }, [http, workspaceId, promo, load, onPurchased])

  if (!state) return null

  const { pricing } = state

  if (state.enrolled) {
    const done = state.completedLessons.length
    const total = state.totalLessons
    const installing = state.installStatus !== 'installed'
    return (
      <Card className="mb-4 rounded-2xl border-border shadow-none">
        <CardContent className="p-4 gap-3">
          <View className="flex-row items-center gap-2">
            <GraduationCap size={18} className="text-primary" />
            <Text className="text-sm font-medium text-foreground">Solo Founder</Text>
            <Badge variant="secondary">
              {state.completedAt ? 'Course finished' : `Lesson ${Math.min(done + 1, total)} of ${total}`}
            </Badge>
          </View>
          <ProgressBar done={done} total={total} />
          <Text className="text-xs text-muted-foreground">
            {state.completedAt
              ? 'Every lesson is done. Your company of one is running on the Solo Founder OS.'
              : installing
                ? 'Setting up your course and agents. This takes a moment — reopening Billing picks it up if it stalled.'
                : `${done} of ${total} lessons done. Each card closes once its lesson's work is checked.`}
          </Text>
          {state.courseChannelId && (
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              onPress={() => router.push(`/c/${state.courseChannelId}`)}
            >
              Open #course
            </Button>
          )}
        </CardContent>
      </Card>
    )
  }

  const eligibility = state.eligibility
  if (!eligibility.eligible) {
    if (eligibility.reason === 'risk_review') {
      return (
        <Card className="mb-4 rounded-2xl border-border shadow-none">
          <CardContent className="p-4 gap-2">
            <Text className="text-sm font-medium text-foreground">Solo Founder offer</Text>
            <Text className="text-xs text-muted-foreground">
              This purchase needs a quick review before it can go through. Contact support and we will sort it out.
            </Text>
          </CardContent>
        </Card>
      )
    }
    return null
  }

  // Store billing rules: a subscription sold through Stripe Checkout cannot be
  // bought from an iOS or Android build. Show what it costs and where to buy it.
  if (Platform.OS !== 'web') {
    return (
      <Card className="mb-4 rounded-2xl border-primary/30 shadow-none">
        <CardContent className="p-4 gap-2">
          <View className="flex-row items-center gap-2">
            <Sparkles size={18} className="text-primary" />
            <Text className="text-sm font-semibold text-foreground">
              Shogo Solo Founder — ${pricing.firstYearUsd} first year
            </Text>
          </View>
          <Text className="text-xs text-muted-foreground">
            The course plus a year of Business for one seat, then ${pricing.renewalUsd}/yr. Buy it on the web.
          </Text>
          <Button size="sm" className="self-start" onPress={() => Linking.openURL(WEB_BILLING_URL)}>
            Open on the web
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="mb-4 rounded-2xl border-primary/30 shadow-none">
      <CardContent className="p-4 gap-3">
        <View className="flex-row items-center gap-2">
          <Sparkles size={18} className="text-primary" />
          <Text className="text-sm font-semibold text-foreground">Shogo Solo Founder</Text>
        </View>
        <Text className="text-xs text-muted-foreground">
          Run a company of one like a company of ten.
        </Text>

        <View className="flex-row items-end gap-2">
          <Text className="text-2xl font-semibold text-foreground">${pricing.firstYearUsd}</Text>
          <Text className="text-xs text-muted-foreground">first year, then ${pricing.renewalUsd}/yr</Text>
        </View>
        <Text className="text-[11px] text-muted-foreground">
          Business annual ${pricing.businessAnnualUsd} + course ${pricing.courseUsd} − ${pricing.firstYearDiscountUsd} first-year discount.
          One seat.
        </Text>

        <View className="gap-1.5">
          <Text className="text-xs text-foreground">
            • A {state.totalLessons}-lesson course on your own Course board — the Coach checks the work before a card can close
          </Text>
          <Text className="text-xs text-foreground">
            • The Solo Founder OS: build, marketing, sales, support and ops agents, installed and running
          </Text>
          <Text className="text-xs text-foreground">
            • $20/mo of AI included; usage beyond that at cost +20%, capped at ${pricing.overageCapUsd}/mo by default
          </Text>
        </View>

        <View className="flex-row items-center gap-2">
          <TextInput
            value={promo}
            onChangeText={setPromo}
            placeholder="Promo code (optional)"
            placeholderTextColor="#9ca3af"
            autoCapitalize="characters"
            autoCorrect={false}
            editable={!isBuying}
            className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
          />
          <Button size="sm" onPress={handleBuy} disabled={isBuying} className="flex-row items-center gap-1">
            <Text className="text-sm font-medium text-primary-foreground">
              {isBuying ? 'Opening…' : `Get it — $${pricing.firstYearUsd}`}
            </Text>
            {!isBuying && <ArrowRight size={14} className="text-primary-foreground" />}
          </Button>
        </View>

        {error && <Text className="text-xs text-destructive">{error}</Text>}

        <Text className="text-[11px] text-muted-foreground">
          Card only. Renews at ${pricing.renewalUsd}/yr; cancel anytime before then. The overage cap is yours to change in Billing.
        </Text>
      </CardContent>
    </Card>
  )
}
