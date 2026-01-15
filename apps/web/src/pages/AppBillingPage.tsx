/**
 * AppBillingPage - Workspace billing and plan management
 *
 * Allows users to view current plan, upgrade/downgrade, and manage billing.
 */

import { useState } from "react"
import { observer } from "mobx-react-lite"
import { Link } from "react-router-dom"
import { ArrowLeft, Check, Zap, Building2, Crown, ExternalLink } from "lucide-react"

import { useDomains } from "@/contexts/DomainProvider"
import { useWorkspaceData } from "@/components/app/workspace/hooks"
import { useSession } from "@/auth/client"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"

// Plan tier definitions
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
  "5 daily credits (up to 150/month)",
  "Usage-based Cloud + AI",
  "Credit rollovers",
  "Unlimited domains",
  "Custom domains",
  "Remove branding",
  "User roles & permissions",
]

const BUSINESS_FEATURES = [
  "Everything in Pro, plus:",
  "SSO authentication",
  "Personal Projects",
  "Opt out of data training",
  "Design templates",
  "Priority support",
]

const ENTERPRISE_FEATURES = [
  "Everything in Business, plus:",
  "Dedicated support",
  "Onboarding services",
  "Custom connections",
  "Group-based access control",
  "SCIM provisioning",
  "Custom design systems",
]

export const AppBillingPage = observer(function AppBillingPage() {
  const { billing } = useDomains()
  const { data: session, isPending: isAuthLoading } = useSession()
  const { currentOrg, isLoading: isWorkspaceLoading } = useWorkspaceData()

  const [billingInterval, setBillingInterval] = useState<"monthly" | "annual">("monthly")
  const [selectedProTier, setSelectedProTier] = useState(0)
  const [selectedBusinessTier, setSelectedBusinessTier] = useState(4)
  const [isLoading, setIsLoading] = useState(false)

  const currentUser = session?.user

  // Get current subscription
  const subscription = currentOrg
    ? billing.subscriptionCollection.findByOrg(currentOrg.id)[0]
    : null

  const handleCheckout = async (planType: "pro" | "business", credits: number) => {
    if (!currentOrg) return

    setIsLoading(true)
    try {
      const planId = credits === 100
        ? planType
        : `${planType}_${credits}`

      const response = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          organizationId: currentOrg.id,
          planId,
          billingInterval,
        }),
      })
      const data = await response.json()
      if (data.url) {
        window.location.href = data.url
      }
    } catch (err) {
      console.error('Failed to start checkout:', err)
    } finally {
      setIsLoading(false)
    }
  }

  const handleManageBilling = async () => {
    if (!currentOrg) return

    setIsLoading(true)
    try {
      const response = await fetch(`/api/billing/portal?organizationId=${currentOrg.id}`, {
        method: 'POST',
        credentials: 'include',
      })
      const data = await response.json()
      if (data.url) {
        window.location.href = data.url
      }
    } catch (err) {
      console.error('Failed to open portal:', err)
    } finally {
      setIsLoading(false)
    }
  }

  if (isAuthLoading || isWorkspaceLoading) {
    return (
      <div className="p-6 max-w-6xl mx-auto">
        <div className="animate-pulse space-y-4">
          <div className="h-8 w-48 bg-muted rounded" />
          <div className="h-96 bg-muted rounded" />
        </div>
      </div>
    )
  }

  if (!currentUser || !currentOrg) {
    return (
      <div className="p-6 max-w-6xl mx-auto text-center py-12">
        <Building2 className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
        <h2 className="text-xl font-semibold mb-2">No Workspace Selected</h2>
        <p className="text-muted-foreground mb-4">
          Please select or create a workspace to manage billing.
        </p>
        <Link to="/app">
          <Button variant="outline">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to App
          </Button>
        </Link>
      </div>
    )
  }

  const proTier = PRO_TIERS[selectedProTier]
  const businessTier = BUSINESS_TIERS[selectedBusinessTier]

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-4">
          <Link to="/app">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold">Plans & Billing</h1>
            <p className="text-muted-foreground">{currentOrg.name}</p>
          </div>
        </div>
        {subscription && (
          <Button variant="outline" onClick={handleManageBilling} disabled={isLoading}>
            <ExternalLink className="h-4 w-4 mr-2" />
            Manage Billing
          </Button>
        )}
      </div>

      {/* Billing Interval Toggle */}
      <div className="flex justify-center mb-8">
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
              {subscription?.planId?.startsWith("pro") ? "Change Plan" : "Upgrade to Pro"}
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
              {subscription?.planId?.startsWith("business") ? "Change Plan" : "Upgrade to Business"}
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

      {/* Current Plan Info */}
      {subscription && (
        <Card className="mt-8">
          <CardHeader>
            <CardTitle className="text-lg">Current Plan</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium capitalize">{subscription.planId} Plan</p>
                <p className="text-sm text-muted-foreground">
                  {subscription.billingInterval === "annual" ? "Annual" : "Monthly"} billing
                </p>
              </div>
              <Badge variant={subscription.isActive ? "default" : "secondary"}>
                {subscription.status}
              </Badge>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
})
