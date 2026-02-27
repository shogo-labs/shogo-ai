/**
 * NewWorkspacePage - Create a paid workspace
 *
 * Reuses the billing page layout with plan cards, credit tier selectors,
 * and monthly/annual toggle. Adds a workspace name input at the top.
 * On checkout, creates the workspace + Stripe subscription.
 */

import { useState, useCallback } from 'react'
import {
  View,
  Text,
  ScrollView,
  Pressable,
  TextInput,
  Linking,
  Platform,
} from 'react-native'
import { useRouter } from 'expo-router'
import {
  ArrowLeft,
  Building2,
  Check,
  Zap,
  Crown,
  ChevronDown,
} from 'lucide-react-native'
import { useAuth } from '../../contexts/auth'
import { useDomainHttp } from '../../contexts/domain'
import { api } from '../../lib/api'
import {
  Card,
  CardContent,
  Badge,
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

export default function NewWorkspacePage() {
  const router = useRouter()
  const { user } = useAuth()
  const http = useDomainHttp()

  const [workspaceName, setWorkspaceName] = useState('')
  const [billingInterval, setBillingInterval] = useState<'monthly' | 'annual'>('monthly')
  const [selectedProTier, setSelectedProTier] = useState(0)
  const [selectedBusinessTier, setSelectedBusinessTier] = useState(0)
  const [isCheckoutLoading, setIsCheckoutLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const proTier = PRO_TIERS[selectedProTier]
  const businessTier = BUSINESS_TIERS[selectedBusinessTier]

  const handleCheckout = useCallback(async (planType: 'pro' | 'business', credits: number) => {
    if (!workspaceName.trim() || !user?.id) return
    setIsCheckoutLoading(true)
    setError(null)
    try {
      const planId = credits === 100 ? planType : `${planType}_${credits}`
      const data = await api.createWorkspaceCheckout(http, {
        workspaceName: workspaceName.trim(),
        planId,
        billingInterval,
        userId: user.id,
        userEmail: user.email ?? undefined,
      })
      if (data?.url) {
        if (Platform.OS === 'web') {
          window.location.href = data.url
        } else {
          Linking.openURL(data.url)
        }
      } else {
        setError('No checkout URL received. Please try again.')
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to start checkout. Please try again.')
    } finally {
      setIsCheckoutLoading(false)
    }
  }, [http, workspaceName, billingInterval, user?.id, user?.email])

  const nameValid = workspaceName.trim().length > 0

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
            Create workspace
          </Text>
          <Text className="text-sm text-muted-foreground">
            Additional workspaces require a paid subscription. Choose a plan to get started.
          </Text>
        </View>
      </View>

      {/* Workspace Name */}
      <Card className="mb-6">
        <CardContent className="p-4">
          <Text className="text-sm font-medium text-foreground mb-2">
            Workspace name
          </Text>
          <TextInput
            value={workspaceName}
            onChangeText={setWorkspaceName}
            placeholder="e.g. My Team, Acme Corp"
            placeholderTextColor="#9ca3af"
            className="border border-border rounded-md px-3 py-2.5 text-sm text-foreground bg-background"
            autoFocus
          />
        </CardContent>
      </Card>

      {/* Error */}
      {error && (
        <View className="mb-4 rounded-md bg-destructive/10 border border-destructive/30 px-4 py-3">
          <Text className="text-sm text-destructive">{error}</Text>
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

      {/* Plan Cards */}
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
                disabled={isCheckoutLoading || !nameValid}
                className={cn(
                  'w-full items-center justify-center py-3 rounded-md',
                  nameValid && !isCheckoutLoading ? 'bg-primary active:bg-primary/80' : 'bg-muted'
                )}
              >
                <Text className={cn(
                  'text-sm font-medium',
                  nameValid && !isCheckoutLoading ? 'text-primary-foreground' : 'text-muted-foreground'
                )}>
                  {isCheckoutLoading ? 'Redirecting...' : !nameValid ? 'Enter workspace name' : 'Subscribe & Create'}
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
                disabled={isCheckoutLoading || !nameValid}
                className={cn(
                  'w-full items-center justify-center py-3 rounded-md',
                  nameValid && !isCheckoutLoading ? 'bg-primary active:bg-primary/80' : 'bg-muted'
                )}
              >
                <Text className={cn(
                  'text-sm font-medium',
                  nameValid && !isCheckoutLoading ? 'text-primary-foreground' : 'text-muted-foreground'
                )}>
                  {isCheckoutLoading ? 'Redirecting...' : !nameValid ? 'Enter workspace name' : 'Subscribe & Create'}
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
}
