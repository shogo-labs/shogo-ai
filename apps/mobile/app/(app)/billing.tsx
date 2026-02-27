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
  Check,
  Zap,
  Crown,
  ChevronDown,
} from 'lucide-react-native'
import { useAuth } from '../../contexts/auth'
import { useWorkspaceCollection, useDomainHttp } from '../../contexts/domain'
import { useBillingData } from '@shogo/shared-app/hooks'
import { api } from '../../lib/api'
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

const PRO_TIERS = [
  { credits: 100, monthly: 25, annual: 250 },
  { credits: 200, monthly: 50, annual: 500 },
  { credits: 400, monthly: 98, annual: 980 },
  { credits: 800, monthly: 190, annual: 1900 },
  { credits: 1200, monthly: 280, annual: 2800 },
  { credits: 2000, monthly: 460, annual: 4600 },
  { credits: 3000, monthly: 680, annual: 6800 },
  { credits: 5000, monthly: 1100, annual: 11000 },
  { credits: 7500, monthly: 1650, annual: 16500 },
  { credits: 10000, monthly: 2200, annual: 22000 },
]

const BUSINESS_TIERS = [
  { credits: 100, monthly: 50, annual: 500 },
  { credits: 200, monthly: 100, annual: 1000 },
  { credits: 400, monthly: 195, annual: 1950 },
  { credits: 800, monthly: 380, annual: 3800 },
  { credits: 1200, monthly: 560, annual: 5600 },
  { credits: 2000, monthly: 920, annual: 9200 },
  { credits: 3000, monthly: 1350, annual: 13500 },
  { credits: 5000, monthly: 2200, annual: 22000 },
  { credits: 7500, monthly: 3200, annual: 32000 },
  { credits: 10000, monthly: 4200, annual: 42000 },
]

const PRO_FEATURES = [
  '5 daily credits (up to 150/month)',
  'Usage-based Cloud + AI',
  'Credit rollovers',
  'Unlimited domains',
  'Custom domains',
  'Remove branding',
  'User roles & permissions',
]

const BUSINESS_FEATURES = [
  'Everything in Pro, plus:',
  'SSO authentication',
  'Personal Projects',
  'Opt out of data training',
  'Design templates',
  'Priority support',
]

const ENTERPRISE_FEATURES = [
  'Everything in Business, plus:',
  'Dedicated support',
  'Onboarding services',
  'Custom connections',
  'Group-based access control',
  'SCIM provisioning',
  'Custom design systems',
]

const PLAN_CREDITS: Record<string, number> = {
  free: 50,
  pro: 100,
  business: 100,
  enterprise: 10000,
}
const DAILY_CREDITS_VAL = 5

function getTotalCreditsForPlan(planId: string | undefined): number {
  if (!planId) return (PLAN_CREDITS['free'] || 0) + DAILY_CREDITS_VAL
  return (PLAN_CREDITS[planId] || 0) + DAILY_CREDITS_VAL
}

function formatCredits(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return n % 1 === 0 ? String(n) : n.toFixed(2)
}

// ─── TierSelector ──────────────────────────────────────────

function TierSelector({
  tiers,
  selectedIndex,
  onSelect,
}: {
  tiers: typeof PRO_TIERS
  selectedIndex: number
  onSelect: (idx: number) => void
}) {
  const [open, setOpen] = useState(false)
  const selected = tiers[selectedIndex]

  return (
    <View>
      <Pressable
        onPress={() => setOpen(!open)}
        className="flex-row items-center justify-between border border-border rounded-md px-3 py-2.5 bg-background"
      >
        <Text className="text-sm text-foreground">
          {selected.credits.toLocaleString()} credits
        </Text>
        <ChevronDown size={16} className="text-muted-foreground" />
      </Pressable>
      {open && (
        <View className="border border-border rounded-md mt-1 bg-card overflow-hidden">
          {tiers.map((tier, i) => (
            <Pressable
              key={tier.credits}
              onPress={() => { onSelect(i); setOpen(false) }}
              className={cn(
                'px-3 py-2 active:bg-muted',
                i === selectedIndex && 'bg-accent'
              )}
            >
              <Text className={cn(
                'text-sm',
                i === selectedIndex ? 'text-foreground font-medium' : 'text-foreground'
              )}>
                {tier.credits.toLocaleString()} credits
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  )
}

// ─── FeatureList ───────────────────────────────────────────

function FeatureList({ features }: { features: string[] }) {
  return (
    <View className="gap-2">
      {features.map((feature) => (
        <View key={feature} className="flex-row items-start gap-2">
          <Check size={14} className="text-green-500 mt-0.5" />
          <Text className="text-sm text-foreground flex-1">{feature}</Text>
        </View>
      ))}
    </View>
  )
}

// ─── Main Page ─────────────────────────────────────────────

export default observer(function BillingPage() {
  const router = useRouter()
  const { user, isLoading: isAuthLoading } = useAuth()
  const workspaces = useWorkspaceCollection()
  const http = useDomainHttp()

  useEffect(() => {
    if (user?.id && workspaces) {
      workspaces.loadAll({ userId: user.id }).catch(() => {})
    }
  }, [user?.id, workspaces])

  let currentWorkspace: any
  try {
    currentWorkspace = workspaces?.all?.[0] ?? null
  } catch {
    currentWorkspace = null
  }

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

  const creditsTotal = getTotalCreditsForPlan(subscription?.planId)
  const creditsRemaining = effectiveBalance?.total ?? creditsTotal

  const planName = subscription
    ? `${subscription.planId.charAt(0).toUpperCase() + subscription.planId.slice(1)} Plan`
    : 'Free Plan'

  const proTier = PRO_TIERS[selectedProTier]
  const businessTier = BUSINESS_TIERS[selectedBusinessTier]

  const handleCheckout = useCallback(async (planType: 'pro' | 'business', credits: number) => {
    if (!currentWorkspace?.id) return
    setIsCheckoutLoading(true)
    try {
      const planId = credits === 100 ? planType : `${planType}_${credits}`
      const isNative = Platform.OS !== 'web'

      const redirectBase = isNative ? ExpoLinking.createURL('billing') : undefined
      console.log('[Billing] checkout start', { planId, billingInterval, isNative, redirectBase })

      const data = await api.createCheckoutSession(http, {
        workspaceId: currentWorkspace.id,
        planId,
        billingInterval,
        userEmail: user?.email,
        ...(isNative && redirectBase && {
          successUrl: `${redirectBase}?workspace=${currentWorkspace.id}&checkout=success&session_id={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${redirectBase}?workspace=${currentWorkspace.id}&checkout=canceled`,
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
        <Pressable onPress={() => router.back()}>
          <ArrowLeft size={20} className="text-foreground" />
        </Pressable>
        <View className="flex-1">
          <Text className="text-2xl font-bold text-foreground">
            Plans & credits
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
                  {subscription
                    ? 'Credits will rollover'
                    : 'No credits will rollover'}
                </Text>
              </View>
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

      {/* Plan Cards — 3 columns on md+, stacked on mobile */}
      <View className="gap-6 md:flex-row md:items-start">
        {/* Pro Plan */}
        <View className="md:flex-1 md:w-0">
          <Card>
            <CardContent className="p-5 gap-5">
              <View className="flex-row items-center gap-2">
                <Zap size={20} className="text-blue-500" />
                <Text className="text-lg font-semibold text-foreground">Pro</Text>
              </View>
              <Text className="text-sm text-muted-foreground">
                Designed for fast-moving teams building together in real time.
              </Text>

              <View>
                <View className="flex-row items-baseline gap-1">
                  <Text className="text-4xl font-bold text-foreground">
                    ${billingInterval === 'monthly' ? proTier.monthly : Math.round(proTier.annual / 12)}
                  </Text>
                  <Text className="text-sm text-muted-foreground">per month</Text>
                </View>
                <Text className="text-sm text-muted-foreground">
                  shared across unlimited users
                </Text>
              </View>

              <View>
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

              <View className="gap-2">
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
        <View className="md:flex-1 md:w-0">
          <View className="items-center" style={{ marginBottom: -12, zIndex: 1 }}>
            <Badge className="bg-primary">
              <Text className="text-xs text-primary-foreground font-medium">Most Popular</Text>
            </Badge>
          </View>
          <Card className="border-primary">
            <CardContent className="p-5 gap-5 pt-6">
              <View className="flex-row items-center gap-2">
                <Building2 size={20} className="text-purple-500" />
                <Text className="text-lg font-semibold text-foreground">Business</Text>
              </View>
              <Text className="text-sm text-muted-foreground">
                Advanced controls and power features for growing departments
              </Text>

              <View>
                <View className="flex-row items-baseline gap-1">
                  <Text className="text-4xl font-bold text-foreground">
                    ${billingInterval === 'monthly' ? businessTier.monthly : Math.round(businessTier.annual / 12)}
                  </Text>
                  <Text className="text-sm text-muted-foreground">per month</Text>
                </View>
                <Text className="text-sm text-muted-foreground">
                  shared across unlimited users
                </Text>
              </View>

              <View>
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

              <View className="gap-2">
                <Text className="text-sm font-medium text-foreground">
                  {businessTier.credits.toLocaleString()} credits / month
                </Text>
                <FeatureList features={BUSINESS_FEATURES} />
              </View>
            </CardContent>
          </Card>
        </View>

        {/* Enterprise Plan */}
        <View className="md:flex-1 md:w-0">
          <Card>
            <CardContent className="p-5 gap-5">
              <View className="flex-row items-center gap-2">
                <Crown size={20} className="text-amber-500" />
                <Text className="text-lg font-semibold text-foreground">Enterprise</Text>
              </View>
              <Text className="text-sm text-muted-foreground">
                Built for large orgs needing flexibility, scale, and governance.
              </Text>

              <View>
                <Text className="text-4xl font-bold text-foreground">Custom</Text>
                <Text className="text-sm text-muted-foreground">Flexible plans</Text>
              </View>

              <Pressable
                onPress={() => Linking.openURL('mailto:sales@shogo.ai')}
                className="w-full items-center justify-center py-3 rounded-md border border-border active:bg-muted"
              >
                <Text className="text-sm font-medium text-foreground">Book a demo</Text>
              </Pressable>

              <FeatureList features={ENTERPRISE_FEATURES} />
            </CardContent>
          </Card>
        </View>
      </View>
    </ScrollView>
  )
})
