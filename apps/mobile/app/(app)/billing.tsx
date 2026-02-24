/**
 * AppBillingPage - Mobile (Expo)
 *
 * Workspace billing and plan management.
 * Shows current plan, credits, upgrade options.
 */

import { useState, useEffect } from 'react'
import { View, Text, ScrollView, Pressable, ActivityIndicator } from 'react-native'
import { useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import {
  ArrowLeft,
  Building2,
  CheckCircle2,
  Info,
  Check,
  Sparkles,
} from 'lucide-react-native'
import { useAuth } from '../../contexts/auth'
import { useWorkspaceCollection } from '../../contexts/domain'
import { useBillingData } from '@shogo/shared-app/hooks'
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

const PLAN_CREDITS: Record<string, number> = {
  free: 0,
  starter: 50,
  pro: 200,
  team: 500,
  enterprise: 2000,
}

const DAILY_CREDITS: Record<string, number> = {
  free: 5,
  starter: 10,
  pro: 25,
  team: 50,
  enterprise: 100,
}

function getTotalCreditsForPlan(
  planId: string | undefined,
  planCredits: Record<string, number>,
  dailyCredits: Record<string, number>
): number {
  if (!planId) return (planCredits['free'] || 0) + (dailyCredits['free'] || 0)
  return (planCredits[planId] || 0) + (dailyCredits[planId] || 0)
}

function formatCredits(n: number): string {
  return n % 1 === 0 ? n.toString() : n.toFixed(1)
}

interface PlanCardProps {
  planId: string
  label: string
  monthlyCredits: number
  dailyCredits: number
  price: string
  isCurrentPlan: boolean
  onSelect?: () => void
}

function PlanCard({
  planId,
  label,
  monthlyCredits,
  dailyCredits,
  price,
  isCurrentPlan,
  onSelect,
}: PlanCardProps) {
  return (
    <Card className={isCurrentPlan ? 'border-primary' : undefined}>
      <CardContent className="p-4 gap-3">
        <View className="flex-row items-center justify-between">
          <View>
            <Text className="text-lg font-semibold text-foreground">
              {label}
            </Text>
            <Text className="text-sm text-muted-foreground">{price}</Text>
          </View>
          {isCurrentPlan && <Badge>Current Plan</Badge>}
        </View>

        <View className="gap-2">
          <View className="flex-row items-center gap-2">
            <Check size={14} className="text-primary" />
            <Text className="text-sm text-foreground">
              {monthlyCredits} monthly credits
            </Text>
          </View>
          <View className="flex-row items-center gap-2">
            <Check size={14} className="text-primary" />
            <Text className="text-sm text-foreground">
              {dailyCredits} daily credits
            </Text>
          </View>
          <View className="flex-row items-center gap-2">
            <Check size={14} className="text-primary" />
            <Text className="text-sm text-foreground">
              Credits rollover monthly
            </Text>
          </View>
        </View>

        {!isCurrentPlan && (
          <Button
            variant="outline"
            onPress={onSelect}
            className="w-full mt-1"
          >
            {planId === 'free' ? 'Downgrade' : 'Upgrade'}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

export default observer(function BillingPage() {
  const router = useRouter()
  const { user, isLoading: isAuthLoading } = useAuth()
  const workspaces = useWorkspaceCollection()

  useEffect(() => {
    if (user?.id && workspaces) {
      workspaces.loadAll({ userId: user.id }).catch(() => {})
    }
  }, [user?.id, workspaces])

  const currentWorkspace = workspaces.all.length > 0 ? workspaces.all[0] : null

  const {
    subscription,
    creditLedger,
    effectiveBalance,
    hasActiveSubscription,
    isLoading: isBillingLoading,
    refetchSubscription,
    refetchCreditLedger,
  } = useBillingData(currentWorkspace?.id)

  const [showSuccess, setShowSuccess] = useState(false)
  const [manageDialogOpen, setManageDialogOpen] = useState(false)

  const creditsTotal = getTotalCreditsForPlan(
    subscription?.planId,
    PLAN_CREDITS,
    DAILY_CREDITS
  )
  const creditsRemaining = effectiveBalance?.total ?? creditsTotal

  const planName = subscription
    ? `${subscription.planId.charAt(0).toUpperCase() + subscription.planId.slice(1)} Plan`
    : 'Free Plan'

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
      contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
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

      {/* Success Message */}
      {showSuccess && (
        <Alert className="mb-6 border-green-500 bg-green-50">
          <View className="flex-row items-start gap-3">
            <CheckCircle2 size={20} className="text-green-600 mt-0.5" />
            <View className="flex-1">
              <AlertTitle className="text-green-800">
                Thank you for subscribing!
              </AlertTitle>
              <AlertDescription className="text-green-700">
                Your subscription is now active. Your workspace has been
                upgraded and your credits are ready to use.
              </AlertDescription>
            </View>
          </View>
        </Alert>
      )}

      {/* Current Plan Card */}
      <Card className="mb-4">
        <CardContent className="p-4">
          <View className="flex-row items-center justify-between">
            <View className="flex-row items-center gap-3 flex-1">
              <View className="h-10 w-10 rounded-full bg-primary/10 items-center justify-center">
                <Text className="text-lg font-semibold text-primary">
                  {currentWorkspace.name[0]?.toUpperCase() || 'W'}
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
            <Button
              variant="outline"
              size="sm"
              onPress={() => setManageDialogOpen(true)}
            >
              Manage
            </Button>
          </View>
        </CardContent>
      </Card>

      {/* Credits Display */}
      <Card className="mb-6">
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

      {/* Plan Selection */}
      <View className="mb-4">
        <Text className="text-lg font-semibold text-foreground mb-4">
          Choose a plan
        </Text>
        <View className="gap-4">
          <PlanCard
            planId="free"
            label="Free"
            monthlyCredits={PLAN_CREDITS['free']}
            dailyCredits={DAILY_CREDITS['free']}
            price="$0 / month"
            isCurrentPlan={!subscription}
          />
          <PlanCard
            planId="starter"
            label="Starter"
            monthlyCredits={PLAN_CREDITS['starter']}
            dailyCredits={DAILY_CREDITS['starter']}
            price="$20 / month"
            isCurrentPlan={subscription?.planId === 'starter'}
          />
          <PlanCard
            planId="pro"
            label="Pro"
            monthlyCredits={PLAN_CREDITS['pro']}
            dailyCredits={DAILY_CREDITS['pro']}
            price="$50 / month"
            isCurrentPlan={subscription?.planId === 'pro'}
          />
          <PlanCard
            planId="team"
            label="Team"
            monthlyCredits={PLAN_CREDITS['team']}
            dailyCredits={DAILY_CREDITS['team']}
            price="$100 / month"
            isCurrentPlan={subscription?.planId === 'team'}
          />
          <PlanCard
            planId="enterprise"
            label="Enterprise"
            monthlyCredits={PLAN_CREDITS['enterprise']}
            dailyCredits={DAILY_CREDITS['enterprise']}
            price="Custom pricing"
            isCurrentPlan={subscription?.planId === 'enterprise'}
          />
        </View>
      </View>
    </ScrollView>
  )
})
