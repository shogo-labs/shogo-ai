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
  Zap,
  Crown,
} from 'lucide-react-native'
import { useAuth } from '../../contexts/auth'
import { useDomainHttp } from '../../contexts/domain'
import { api } from '../../lib/api'
import {
  PRO_TIERS,
  BUSINESS_TIERS,
  PRO_FEATURES,
  BUSINESS_FEATURES,
  ENTERPRISE_FEATURES,
  BASE_TIER_CREDITS,
} from '../../lib/billing-config'
import { TierSelector } from '../../components/billing/TierSelector'
import { FeatureList } from '../../components/billing/FeatureList'
import {
  Card,
  CardContent,
  Badge,
  cn,
} from '@shogo/shared-ui/primitives'

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
      const planId = credits === BASE_TIER_CREDITS ? planType : `${planType}_${credits}`
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
