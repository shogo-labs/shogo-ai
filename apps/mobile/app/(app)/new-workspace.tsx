// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * NewWorkspacePage - Create a paid workspace
 *
 * Reuses the billing page layout with plan cards, a per-seat counter, and a
 * monthly/annual toggle. Adds a workspace name input at the top. On
 * checkout, creates the workspace + Stripe subscription.
 */

import { useState, useCallback, useEffect } from 'react'
import {
  View,
  Text,
  ScrollView,
  Pressable,
  TextInput,
  Linking,
  Platform,
  KeyboardAvoidingView,
} from 'react-native'
import * as WebBrowser from 'expo-web-browser'
import * as ExpoLinking from 'expo-linking'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  ArrowLeft,
  Building2,
  Zap,
  Crown,
} from 'lucide-react-native'
import { useAuth } from '../../contexts/auth'
import { useDomainHttp, useWorkspaceCollection } from '../../contexts/domain'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { usePooledWorkspaceCreation } from '../../hooks/usePooledWorkspaceCreation'
import { api } from '../../lib/api'
import { getRewardfulReferral } from '../../lib/rewardful'
import { trackInitiateCheckout, trackPurchase } from '../../lib/tracking'
import {
  PLAN_PRICING,
  SEAT_INCLUDED_USD,
  PRO_FEATURES,
  BUSINESS_FEATURES,
  ENTERPRISE_FEATURES,
  formatUsd,
} from '../../lib/billing-config'
import { SeatCounter } from '../../components/billing/SeatCounter'
import { FeatureList } from '../../components/billing/FeatureList'
import { CreateWorkspaceModal } from '../../components/layout/sidebar/CreateWorkspaceModal'
import {
  Card,
  CardContent,
  Badge,
  cn,
} from '@shogo/shared-ui/primitives'

export default function NewWorkspacePage() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { user } = useAuth()
  const http = useDomainHttp()
  const workspaces = useWorkspaceCollection()
  const currentWorkspace = useActiveWorkspace()

  const [workspaceName, setWorkspaceName] = useState('')
  const [billingInterval, setBillingInterval] = useState<'monthly' | 'annual'>('monthly')
  const [proSeats, setProSeats] = useState(1)
  const [businessSeats, setBusinessSeats] = useState(1)
  const [isCheckoutLoading, setIsCheckoutLoading] = useState(false)
  const [pooledCreateOpen, setPooledCreateOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const goHome = useCallback(() => router.replace('/(app)'), [router])
  const { parent: pooledWorkspaceParent, createPooledWorkspace } = usePooledWorkspaceCreation({
    workspaces: workspaces?.all ?? [],
    currentWorkspaceId: currentWorkspace?.id,
    enabled: true,
    onCreated: goHome,
  })

  useEffect(() => {
    void workspaces.loadAll().catch(() => undefined)
  }, [workspaces])

  const proPricing = PLAN_PRICING.pro
  const businessPricing = PLAN_PRICING.business

  const handleCheckout = useCallback(async (planType: 'pro' | 'business', seats: number) => {
    if (!user?.id) return
    if (Platform.OS === 'ios') {
      setError('Additional workspace creation is not available in the iOS app.')
      return
    }
    if (!workspaceName.trim()) {
      setError('Give your workspace a name before subscribing.')
      return
    }
    setIsCheckoutLoading(true)
    setError(null)
    try {
      const planId = planType
      const safeSeats = Math.max(1, Math.floor(seats || 1))
      const isNative = Platform.OS !== 'web'

      const redirectBase = isNative
        ? ExpoLinking.createURL('checkout-return')
        : (typeof window !== 'undefined' ? window.location.origin : undefined)
      console.log('[NewWorkspace] checkout start', { planId, seats: safeSeats, billingInterval, isNative, redirectBase })
      trackInitiateCheckout({ planId, billingInterval, seats: safeSeats, workspaceId: 'new' })

      const data = await api.createWorkspaceCheckout(http, {
        workspaceName: workspaceName.trim(),
        planId,
        seats: safeSeats,
        billingInterval,
        userId: user.id,
        userEmail: user.email ?? undefined,
        referralId: getRewardfulReferral(),
        ...(redirectBase && {
          successUrl: `${redirectBase}/?workspace={WORKSPACE_ID}&checkout=workspace_created&session_id={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${redirectBase}/?workspace={WORKSPACE_ID}&checkout=canceled`,
        }),
      })
      console.log('[NewWorkspace] checkout session created', { url: data?.url ? '(received)' : '(missing)', workspaceId: (data as any)?.workspaceId })

      if (data?.url) {
        if (!isNative) {
          window.location.href = data.url
        } else {
          const scheme = ExpoLinking.createURL('')
          console.log('[NewWorkspace] opening auth session, scheme prefix:', scheme)
          const result = await WebBrowser.openAuthSessionAsync(data.url, scheme)
          console.log('[NewWorkspace] auth session result:', { type: result.type, url: 'url' in result ? result.url : undefined })

          if (result.type === 'success' && 'url' in result && result.url) {
            try {
              const qs = result.url.split('?')[1] || ''
              const params = new URLSearchParams(qs)
              const checkout = params.get('checkout')
              const sessionId = params.get('session_id')
              const wsId = params.get('workspace')
              console.log('[NewWorkspace] parsed redirect params:', { checkout, sessionId, wsId })

              if (sessionId) {
                console.log('[NewWorkspace] verifying checkout session...')
                try {
                  const verifyResult = await api.verifyCheckout(http, sessionId)
                  console.log('[NewWorkspace] verify result:', verifyResult)
                  trackPurchase({
                    planId: verifyResult.planId,
                    billingInterval,
                    seats: (verifyResult as { seats?: number }).seats ?? safeSeats,
                    workspaceId: verifyResult.workspaceId ?? wsId ?? undefined,
                    sessionId,
                  })
                } catch (verifyErr) {
                  console.warn('[NewWorkspace] verify failed (webhook will handle):', verifyErr)
                }
              }

              console.log('[NewWorkspace] checkout complete, navigating home')
              router.replace('/(app)')
            } catch (parseErr) {
              console.warn('[NewWorkspace] error parsing redirect URL:', parseErr)
            }
          }
        }
      } else {
        setError('No checkout URL received. Please try again.')
      }
    } catch (e: any) {
      console.warn('[NewWorkspace] checkout failed:', e)
      setError(e?.message || 'Failed to start checkout. Please try again.')
    } finally {
      setIsCheckoutLoading(false)
    }
  }, [http, workspaceName, billingInterval, user?.id, user?.email, router])

  if (Platform.OS === 'ios') {
    return (
      <View
        className="flex-1 bg-muted/20 px-4"
        style={{ paddingTop: Math.max(insets.top, 16), paddingBottom: Math.max(insets.bottom, 16) }}
      >
        <View className="mx-auto w-full max-w-xl">
          <View className="mb-8 flex-row items-center gap-3">
            <Pressable
              onPress={() => router.back()}
              className="h-11 w-11 items-center justify-center rounded-full border border-border bg-background"
              accessibilityRole="button"
              accessibilityLabel="Go back"
            >
              <ArrowLeft size={20} className="text-foreground" />
            </Pressable>
            <View>
              <Text className="text-xs font-semibold uppercase tracking-[1.5px] text-primary">
                Workspace
              </Text>
              <Text className="text-xl font-semibold text-foreground">
                Create workspace
              </Text>
            </View>
          </View>

          <Card className="rounded-2xl border-border/80 bg-card">
            <CardContent className="gap-3 p-5">
              <View className="h-10 w-10 items-center justify-center rounded-xl bg-muted">
                <Building2 size={20} className="text-foreground" />
              </View>
              <Text className="text-base font-semibold text-foreground">
                Additional workspaces are not available in the iOS app.
              </Text>
              <Text className="text-sm leading-5 text-muted-foreground">
                You can continue using workspaces that are already available on your account.
              </Text>
            </CardContent>
          </Card>
        </View>
      </View>
    )
  }

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-muted/20"
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      enabled={Platform.OS !== 'web'}
    >
      <ScrollView
        className="flex-1"
        contentContainerClassName="px-4"
        contentContainerStyle={{ paddingTop: Math.max(insets.top, 20), paddingBottom: Math.max(insets.bottom + 32, 72) }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View className="mx-auto w-full max-w-6xl">
          {/* Header */}
          <View className="mb-8 flex-row items-start gap-3">
            <Pressable
              onPress={() => router.back()}
              className="mt-1 h-11 w-11 items-center justify-center rounded-full border border-border bg-background"
              accessibilityRole="button"
              accessibilityLabel="Go back"
            >
              <ArrowLeft size={20} className="text-foreground" />
            </Pressable>
            <View className="flex-1">
              <Text className="mb-1 text-xs font-semibold uppercase tracking-[1.5px] text-primary">
                New workspace
              </Text>
              <Text className="text-3xl font-semibold tracking-tight text-foreground">
                Set up your team space
              </Text>
              <Text className="mt-2 max-w-xl text-sm leading-5 text-muted-foreground">
                Name your workspace, choose the access your team needs, and continue securely to checkout.
              </Text>
            </View>
          </View>

          {pooledWorkspaceParent && (
            <Card className="mb-6 rounded-2xl border-primary/40 bg-primary/5">
              <CardContent className="gap-3 p-5">
                <Text className="text-base font-semibold text-foreground">
                  Your plan includes unlimited workspaces
                </Text>
                <Text className="text-sm leading-5 text-muted-foreground">
                  Create a workspace under {pooledWorkspaceParent.name || 'your plan'} at no extra cost. It shares usage, billing, and seats with the parent workspace.
                </Text>
                <Pressable
                  onPress={() => setPooledCreateOpen(true)}
                  className="min-h-11 items-center justify-center rounded-xl bg-primary px-4 active:bg-primary/80"
                  accessibilityRole="button"
                  accessibilityLabel="Create included workspace"
                >
                  <Text className="text-sm font-semibold text-primary-foreground">
                    Create included workspace
                  </Text>
                </Pressable>
              </CardContent>
            </Card>
          )}

          {/* Workspace Name */}
          <Card className="mb-6 rounded-2xl border-border/80 bg-card">
            <CardContent className="p-5">
              <View className="mb-4 flex-row items-center gap-3">
                <View className="h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
                  <Building2 size={19} className="text-primary" />
                </View>
                <View className="flex-1">
                  <Text className="text-base font-semibold text-foreground">1. Name your workspace</Text>
                  <Text className="mt-0.5 text-sm text-muted-foreground">You can change this later in settings.</Text>
                </View>
              </View>
              <TextInput
                value={workspaceName}
                onChangeText={(t) => { setWorkspaceName(t); if (error) setError(null) }}
                placeholder="e.g. My Team, Acme Corp"
                placeholderTextColor="#9ca3af"
                className="min-h-12 rounded-xl border border-border bg-background px-4 py-3 text-base text-foreground"
                autoFocus={Platform.OS === 'web'}
                accessibilityLabel="Workspace name"
                returnKeyType="done"
              />
            </CardContent>
          </Card>

          {/* Error */}
          {error && (
            <View className="mb-6 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3">
              <Text className="text-sm font-medium text-destructive">{error}</Text>
            </View>
          )}

          <View className="mb-4 flex-row flex-wrap items-end justify-between gap-3">
            <View>
              <Text className="text-xs font-semibold uppercase tracking-[1.5px] text-primary">2. Choose a plan</Text>
              <Text className="mt-1 text-xl font-semibold text-foreground">Simple pricing for growing teams</Text>
            </View>
            {/* Billing Interval Toggle */}
            <View className="flex-row rounded-xl border border-border bg-background p-1">
              <Pressable
                onPress={() => setBillingInterval('monthly')}
                className={cn(
                  'min-h-10 justify-center rounded-lg px-4',
                  billingInterval === 'monthly' && 'bg-primary'
                )}
                accessibilityRole="button"
                accessibilityState={{ selected: billingInterval === 'monthly' }}
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
                  'min-h-10 flex-row items-center justify-center gap-1.5 rounded-lg px-4',
                  billingInterval === 'annual' && 'bg-primary'
                )}
                accessibilityRole="button"
                accessibilityState={{ selected: billingInterval === 'annual' }}
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

          {/* Plan Cards */}
          <View className="gap-5 md:flex-row md:items-stretch">
            {/* Pro Plan */}
            <View className="md:flex-1 md:w-0">
              <Card className="h-full rounded-2xl border-border/80 bg-card">
                <CardContent className="gap-5 p-5">
                  <View className="flex-row items-center gap-2">
                    <View className="h-9 w-9 items-center justify-center rounded-lg bg-blue-500/10">
                      <Zap size={18} className="text-blue-500" />
                    </View>
                    <Text className="text-lg font-semibold text-foreground">Pro</Text>
                  </View>
                  <Text className="text-sm leading-5 text-muted-foreground">
                    Designed for fast-moving teams building together in real time.
                  </Text>

                  <View>
                    <View className="flex-row items-baseline gap-1">
                      <Text className="text-4xl font-bold text-foreground">
                        ${billingInterval === 'monthly' ? proPricing.monthly * proSeats : Math.round((proPricing.annual / 12) * proSeats)}
                      </Text>
                      <Text className="text-sm text-muted-foreground">per month</Text>
                    </View>
                    <Text className="mt-1 text-sm text-muted-foreground">
                      ${proPricing.monthly}/seat × {proSeats} seat{proSeats === 1 ? '' : 's'} — raw cost + 20% on usage
                    </Text>
                  </View>

                  <View>
                    <Text className="mb-2 text-sm font-medium text-foreground">
                      Seats
                    </Text>
                    <SeatCounter
                      value={proSeats}
                      onChange={setProSeats}
                      min={1}
                      max={500}
                      label={`$${SEAT_INCLUDED_USD.pro} / seat / month`}
                    />
                  </View>

                  <Pressable
                    onPress={() => handleCheckout('pro', proSeats)}
                    disabled={isCheckoutLoading}
                    className={cn(
                      'min-h-12 w-full items-center justify-center rounded-xl',
                      isCheckoutLoading ? 'bg-muted' : 'bg-primary active:bg-primary/80'
                    )}
                    accessibilityRole="button"
                    accessibilityLabel="Subscribe to Pro and create workspace"
                    accessibilityState={{ disabled: isCheckoutLoading }}
                  >
                    <Text className={cn(
                      'text-sm font-semibold',
                      isCheckoutLoading ? 'text-muted-foreground' : 'text-primary-foreground'
                    )}>
                      {isCheckoutLoading ? 'Redirecting...' : 'Subscribe & Create'}
                    </Text>
                  </Pressable>

                  <View className="gap-2 border-t border-border pt-4">
                    <Text className="text-sm font-medium text-foreground">
                      {formatUsd(SEAT_INCLUDED_USD.pro * proSeats)} of usage / month
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
            <View className="md:flex-1 md:w-0">
              <View className="items-center -mb-3 z-10">
                <Badge className="bg-primary">
                  <Text className="text-xs text-primary-foreground font-medium">Most Popular</Text>
                </Badge>
              </View>
              <Card className="h-full rounded-2xl border-primary bg-card">
                <CardContent className="gap-5 p-5 pt-7">
                  <View className="flex-row items-center gap-2">
                    <View className="h-9 w-9 items-center justify-center rounded-lg bg-purple-500/10">
                      <Building2 size={18} className="text-purple-500" />
                    </View>
                    <Text className="text-lg font-semibold text-foreground">Business</Text>
                  </View>
                  <Text className="text-sm leading-5 text-muted-foreground">
                    Advanced controls and power features for growing departments
                  </Text>

                  <View>
                    <View className="flex-row items-baseline gap-1">
                      <Text className="text-4xl font-bold text-foreground">
                        ${billingInterval === 'monthly' ? businessPricing.monthly * businessSeats : Math.round((businessPricing.annual / 12) * businessSeats)}
                      </Text>
                      <Text className="text-sm text-muted-foreground">per month</Text>
                    </View>
                    <Text className="mt-1 text-sm text-muted-foreground">
                      ${businessPricing.monthly}/seat × {businessSeats} seat{businessSeats === 1 ? '' : 's'} — raw cost + 20% on usage
                    </Text>
                  </View>

                  <View>
                    <Text className="mb-2 text-sm font-medium text-foreground">
                      Seats
                    </Text>
                    <SeatCounter
                      value={businessSeats}
                      onChange={setBusinessSeats}
                      min={1}
                      max={500}
                      label={`$${SEAT_INCLUDED_USD.business} / seat / month`}
                    />
                  </View>

                  <Pressable
                    onPress={() => handleCheckout('business', businessSeats)}
                    disabled={isCheckoutLoading}
                    className={cn(
                      'min-h-12 w-full items-center justify-center rounded-xl',
                      isCheckoutLoading ? 'bg-muted' : 'bg-primary active:bg-primary/80'
                    )}
                    accessibilityRole="button"
                    accessibilityLabel="Subscribe to Business and create workspace"
                    accessibilityState={{ disabled: isCheckoutLoading }}
                  >
                    <Text className={cn(
                      'text-sm font-semibold',
                      isCheckoutLoading ? 'text-muted-foreground' : 'text-primary-foreground'
                    )}>
                      {isCheckoutLoading ? 'Redirecting...' : 'Subscribe & Create'}
                    </Text>
                  </Pressable>

                  <View className="gap-2 border-t border-border pt-4">
                    <Text className="text-sm font-medium text-foreground">
                      {formatUsd(SEAT_INCLUDED_USD.business * businessSeats)} of usage / month
                    </Text>
                    <FeatureList features={BUSINESS_FEATURES} />
                  </View>
                </CardContent>
              </Card>
            </View>

            {/* Enterprise Plan */}
            <View className="md:flex-1 md:w-0">
              <Card className="h-full rounded-2xl border-border/80 bg-card">
                <CardContent className="gap-5 p-5">
                  <View className="flex-row items-center gap-2">
                    <View className="h-9 w-9 items-center justify-center rounded-lg bg-amber-500/10">
                      <Crown size={18} className="text-amber-500" />
                    </View>
                    <Text className="text-lg font-semibold text-foreground">Enterprise</Text>
                  </View>
                  <Text className="text-sm leading-5 text-muted-foreground">
                    Built for large orgs needing flexibility, scale, and governance.
                  </Text>

                  <View>
                    <Text className="text-4xl font-bold text-foreground">Custom</Text>
                    <Text className="mt-1 text-sm text-muted-foreground">Flexible plans</Text>
                  </View>

                  <Pressable
                    onPress={() => Linking.openURL('mailto:sales@shogo.ai')}
                    className="min-h-12 w-full items-center justify-center rounded-xl border border-border active:bg-muted"
                    accessibilityRole="link"
                    accessibilityLabel="Book an Enterprise demo"
                  >
                    <Text className="text-sm font-semibold text-foreground">Book a demo</Text>
                  </Pressable>

                  <View className="border-t border-border pt-4">
                    <FeatureList features={ENTERPRISE_FEATURES} />
                  </View>
                </CardContent>
              </Card>
            </View>
          </View>
          <Text className="mt-5 text-center text-xs leading-5 text-muted-foreground">
            Payments are handled through Stripe. You can review plan details before completing checkout.
          </Text>
          <CreateWorkspaceModal
            visible={pooledCreateOpen}
            onClose={() => setPooledCreateOpen(false)}
            onSubmit={createPooledWorkspace}
            parentName={pooledWorkspaceParent?.name}
          />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}
