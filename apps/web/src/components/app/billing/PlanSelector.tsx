/**
 * PlanSelector Component
 *
 * Reusable plan selection UI used in:
 * - AppBillingPage (upgrade existing workspace)
 * - WorkspaceSwitcher (create new workspace with plan)
 */

import { useState } from "react"
import { Check, Zap, Building2, Crown } from "lucide-react"
import { useSession } from "@/auth/client"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"

// Plan tier definitions
export const PRO_TIERS = [
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

export const BUSINESS_TIERS = [
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

export const PRO_FEATURES = [
  "5 daily credits (up to 150/month)",
  "Usage-based Cloud + AI",
  "Credit rollovers",
  "Unlimited domains",
  "Custom domains",
  "Remove branding",
  "User roles & permissions",
]

export const BUSINESS_FEATURES = [
  "Everything in Pro, plus:",
  "SSO authentication",
  "Personal Projects",
  "Opt out of data training",
  "Design templates",
  "Priority support",
]

export const ENTERPRISE_FEATURES = [
  "Everything in Business, plus:",
  "Dedicated support",
  "Onboarding services",
  "Custom connections",
  "Group-based access control",
  "SCIM provisioning",
  "Custom design systems",
]

export interface PlanSelectorProps {
  /** For existing workspace upgrade */
  workspaceId?: string
  /** For new workspace creation - provide name and onCreateWorkspace callback */
  workspaceName?: string
  /** Callback to create workspace before checkout, returns the new workspace ID */
  onCreateWorkspace?: (name: string) => Promise<string>
  /** Current subscription plan (for showing "Change Plan" vs "Upgrade") */
  currentPlanId?: string
  /** Callback after successful checkout redirect */
  onCheckoutStart?: () => void
}

export function PlanSelector({
  workspaceId,
  workspaceName,
  onCreateWorkspace,
  currentPlanId,
  onCheckoutStart,
}: PlanSelectorProps) {
  const { data: session } = useSession()
  const [billingInterval, setBillingInterval] = useState<"monthly" | "annual">("monthly")
  const [selectedProTier, setSelectedProTier] = useState(0)
  const [selectedBusinessTier, setSelectedBusinessTier] = useState(4)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const proTier = PRO_TIERS[selectedProTier]
  const businessTier = BUSINESS_TIERS[selectedBusinessTier]

  const handleCheckout = async (planType: "pro" | "business", credits: number) => {
    setIsLoading(true)
    setError(null)

    try {
      const planId = credits === 100 ? planType : `${planType}_${credits}`

      // Determine the workspace ID - either existing or create new
      let checkoutWorkspaceId = workspaceId

      // If creating a new workspace, create it first
      if (!workspaceId && workspaceName && onCreateWorkspace) {
        try {
          checkoutWorkspaceId = await onCreateWorkspace(workspaceName)
        } catch (err) {
          console.error('Failed to create workspace:', err)
          setError('Failed to create workspace. Please try again.')
          setIsLoading(false)
          return
        }
      }

      if (!checkoutWorkspaceId) {
        setError('No workspace specified')
        setIsLoading(false)
        return
      }

      // Now proceed to checkout with the workspace ID
      const response = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          workspaceId: checkoutWorkspaceId,
          planId,
          billingInterval,
          userEmail: session?.user?.email,
        }),
      })
      const data = await response.json()

      if (data.error) {
        setError(data.error.message || 'Failed to start checkout')
        setIsLoading(false)
        return
      }

      if (data.url) {
        onCheckoutStart?.()
        window.location.href = data.url
      }
    } catch (err) {
      console.error('Failed to start checkout:', err)
      setError('Failed to start checkout. Please try again.')
      setIsLoading(false)
    }
  }

  const getProButtonText = () => {
    if (currentPlanId?.startsWith("pro")) return "Change Plan"
    return "Upgrade to Pro"
  }

  const getBusinessButtonText = () => {
    if (currentPlanId?.startsWith("business")) return "Change Plan"
    return "Upgrade to Business"
  }

  return (
    <div className="space-y-8">
      {/* Error Display */}
      {error && (
        <div className="p-3 bg-destructive/10 border border-destructive/30 rounded-md text-destructive text-sm text-center">
          {error}
        </div>
      )}

      {/* Billing Interval Toggle */}
      <div className="flex justify-center">
        <Tabs value={billingInterval} onValueChange={(v) => setBillingInterval(v as "monthly" | "annual")}>
          <TabsList>
            <TabsTrigger value="monthly">Monthly</TabsTrigger>
            <TabsTrigger value="annual">
              Annual
              <Badge variant="secondary" className="ml-2 text-xs">Save ~17%</Badge>
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* Plan Cards */}
      <div className="grid md:grid-cols-3 gap-6">
        {/* Pro Plan */}
        <Card className="relative">
          <CardHeader>
            <div className="flex items-center gap-2 mb-2">
              <Zap className="h-5 w-5 text-blue-500" />
              <CardTitle>Pro</CardTitle>
            </div>
            <CardDescription>
              Designed for fast-moving teams building together in real time.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Price */}
            <div>
              <div className="flex items-baseline gap-1">
                <span className="text-4xl font-bold">
                  ${billingInterval === "monthly" ? proTier.monthly : Math.round(proTier.annual / 12)}
                </span>
                <span className="text-muted-foreground">per month</span>
              </div>
              <p className="text-sm text-muted-foreground">shared across unlimited users</p>
            </div>

            {/* Credit Selector */}
            <div>
              <label className="text-sm font-medium mb-2 block">Monthly credits</label>
              <select
                value={selectedProTier}
                onChange={(e) => setSelectedProTier(Number(e.target.value))}
                className="w-full p-2 border rounded-md bg-background"
              >
                {PRO_TIERS.map((tier, i) => (
                  <option key={tier.credits} value={i}>
                    {tier.credits.toLocaleString()} credits - ${billingInterval === "monthly" ? tier.monthly : tier.annual}/{billingInterval === "monthly" ? "mo" : "yr"}
                  </option>
                ))}
              </select>
            </div>

            {/* CTA */}
            <Button
              className="w-full"
              onClick={() => handleCheckout("pro", proTier.credits)}
              disabled={isLoading}
            >
              {getProButtonText()}
            </Button>

            {/* Features */}
            <div className="space-y-2">
              <p className="text-sm font-medium">{proTier.credits.toLocaleString()} credits / month</p>
              <p className="text-sm text-muted-foreground">All features in Free, plus:</p>
              <ul className="space-y-2">
                {PRO_FEATURES.map((feature) => (
                  <li key={feature} className="flex items-start gap-2 text-sm">
                    <Check className="h-4 w-4 text-green-500 mt-0.5 shrink-0" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
            </div>
          </CardContent>
        </Card>

        {/* Business Plan */}
        <Card className="relative border-primary">
          <div className="absolute -top-3 left-1/2 -translate-x-1/2">
            <Badge className="bg-primary">Most Popular</Badge>
          </div>
          <CardHeader>
            <div className="flex items-center gap-2 mb-2">
              <Building2 className="h-5 w-5 text-purple-500" />
              <CardTitle>Business</CardTitle>
            </div>
            <CardDescription>
              Advanced controls and power features for growing departments
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Price */}
            <div>
              <div className="flex items-baseline gap-1">
                <span className="text-4xl font-bold">
                  ${billingInterval === "monthly" ? businessTier.monthly : Math.round(businessTier.annual / 12)}
                </span>
                <span className="text-muted-foreground">per month</span>
              </div>
              <p className="text-sm text-muted-foreground">shared across unlimited users</p>
            </div>

            {/* Credit Selector */}
            <div>
              <label className="text-sm font-medium mb-2 block">Monthly credits</label>
              <select
                value={selectedBusinessTier}
                onChange={(e) => setSelectedBusinessTier(Number(e.target.value))}
                className="w-full p-2 border rounded-md bg-background"
              >
                {BUSINESS_TIERS.map((tier, i) => (
                  <option key={tier.credits} value={i}>
                    {tier.credits.toLocaleString()} credits - ${billingInterval === "monthly" ? tier.monthly : tier.annual}/{billingInterval === "monthly" ? "mo" : "yr"}
                  </option>
                ))}
              </select>
            </div>

            {/* CTA */}
            <Button
              className="w-full"
              variant="default"
              onClick={() => handleCheckout("business", businessTier.credits)}
              disabled={isLoading}
            >
              {getBusinessButtonText()}
            </Button>

            {/* Features */}
            <div className="space-y-2">
              <p className="text-sm font-medium">{businessTier.credits.toLocaleString()} credits / month</p>
              <ul className="space-y-2">
                {BUSINESS_FEATURES.map((feature) => (
                  <li key={feature} className="flex items-start gap-2 text-sm">
                    <Check className="h-4 w-4 text-green-500 mt-0.5 shrink-0" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
            </div>
          </CardContent>
        </Card>

        {/* Enterprise Plan */}
        <Card className="relative">
          <CardHeader>
            <div className="flex items-center gap-2 mb-2">
              <Crown className="h-5 w-5 text-amber-500" />
              <CardTitle>Enterprise</CardTitle>
            </div>
            <CardDescription>
              Built for large orgs needing flexibility, scale, and governance.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Price */}
            <div>
              <div className="flex items-baseline gap-1">
                <span className="text-4xl font-bold">Custom</span>
              </div>
              <p className="text-sm text-muted-foreground">Flexible plans</p>
            </div>

            {/* CTA */}
            <Button className="w-full" variant="outline" asChild>
              <a href="mailto:sales@shogo.ai">Book a demo</a>
            </Button>

            {/* Features */}
            <div className="space-y-2">
              <ul className="space-y-2">
                {ENTERPRISE_FEATURES.map((feature) => (
                  <li key={feature} className="flex items-start gap-2 text-sm">
                    <Check className="h-4 w-4 text-green-500 mt-0.5 shrink-0" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
