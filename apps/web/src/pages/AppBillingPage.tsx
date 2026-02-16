/**
 * AppBillingPage - Workspace billing and plan management
 *
 * Allows users to view current plan, upgrade/downgrade, and manage billing.
 * Matches Lovable.dev's billing page pattern.
 */

import { useState, useEffect } from "react"
import { observer } from "mobx-react-lite"
import { Link, useSearchParams } from "react-router-dom"
import { ArrowLeft, Building2, CheckCircle2, Info } from "lucide-react"

import { useWorkspaceData } from "@/components/app/workspace/hooks"
import { useBillingData } from "@/hooks/useBillingData"
import { useSession } from "@/contexts/SessionProvider"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { PlanSelector } from "@/components/app/billing/PlanSelector"
import { ManageBillingDialog } from "@/components/app/billing/ManageBillingDialog"

export const AppBillingPage = observer(function AppBillingPage() {
  const { data: session, isPending: isAuthLoading } = useSession()
  const { currentWorkspace, isLoading: isWorkspaceLoading } = useWorkspaceData()
  const [searchParams, setSearchParams] = useSearchParams()

  // Use the billing data hook to load subscription and credit data from API
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

  const currentUser = session?.user

  // Check for successful checkout redirect
  const isSuccess = searchParams.get("success") === "true"

  // Handle successful checkout - show message and refresh subscription data
  useEffect(() => {
    if (isSuccess && currentWorkspace) {
      setShowSuccess(true)
      // Clear the success param from URL to prevent re-triggering
      const newParams = new URLSearchParams(searchParams)
      newParams.delete("success")
      newParams.delete("session_id")
      setSearchParams(newParams, { replace: true })

      // Refresh subscription and credit data from the API
      refetchSubscription()
      refetchCreditLedger()
    }
  }, [isSuccess, currentWorkspace, searchParams, setSearchParams, refetchSubscription, refetchCreditLedger])

  // Calculate credits from actual ledger data
  const creditsRemaining = effectiveBalance?.total ?? 5
  // Plan max: daily(5) + monthly allocation based on plan
  const planMonthlyMax = subscription ? { pro: 500, business: 2000, enterprise: 10000 }[subscription.planId as string] ?? 50 : 50
  const creditsTotal = planMonthlyMax + 5

  // Get plan name
  const planName = subscription
    ? `${subscription.planId.charAt(0).toUpperCase() + subscription.planId.slice(1)} Plan`
    : "Free Plan"

  if (isAuthLoading || isWorkspaceLoading || isBillingLoading) {
    return (
      <div className="p-6 max-w-6xl mx-auto">
        <div className="animate-pulse space-y-4">
          <div className="h-8 w-48 bg-muted rounded" />
          <div className="h-96 bg-muted rounded" />
        </div>
      </div>
    )
  }

  if (!currentUser || !currentWorkspace) {
    return (
      <div className="p-6 max-w-6xl mx-auto text-center py-12">
        <Building2 className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
        <h2 className="text-xl font-semibold mb-2">No Workspace Selected</h2>
        <p className="text-muted-foreground mb-4">
          Please select or create a workspace to manage billing.
        </p>
        <Link to="/">
          <Button variant="outline">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to App
          </Button>
        </Link>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-4 mb-8">
        <Link to="/">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-bold">Plans & credits</h1>
          <p className="text-muted-foreground">Manage your subscription plan and credit balance.</p>
        </div>
      </div>

      {/* Success Message */}
      {showSuccess && (
        <Alert className="mb-8 border-green-500 bg-green-50 dark:bg-green-950">
          <CheckCircle2 className="h-5 w-5 text-green-600" />
          <AlertTitle className="text-green-800 dark:text-green-200">Thank you for subscribing!</AlertTitle>
          <AlertDescription className="text-green-700 dark:text-green-300">
            Your subscription is now active. Your workspace has been upgraded and your credits are ready to use.
          </AlertDescription>
        </Alert>
      )}

      {/* Current Plan & Credits Section */}
      <div className="mb-8 space-y-4">
        {/* Current Plan Card */}
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
                  <span className="text-lg font-semibold text-primary">
                    {currentWorkspace.name[0]?.toUpperCase() || "W"}
                  </span>
                </div>
                <div>
                  <div className="font-medium">You're on {planName}</div>
                  <div className="text-sm text-muted-foreground">Upgrade anytime</div>
                </div>
              </div>
              <Button variant="outline" onClick={() => setManageDialogOpen(true)}>
                Manage
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Credits Display */}
        <Card>
          <CardContent className="p-6">
            <div className="space-y-4">
              <div>
                <p className="text-sm font-medium mb-1">Credits remaining</p>
                <p className="text-2xl font-bold">
                  {creditsRemaining} of {creditsTotal}
                </p>
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium">Daily credits used first</p>
                <div className="flex flex-col gap-2 text-sm text-muted-foreground">
                  <div className="flex items-center gap-2">
                    <Info className="h-4 w-4" />
                    <span>
                      {subscription ? "Credits will rollover" : "No credits will rollover"}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Info className="h-4 w-4" />
                    <span>Daily credits reset at midnight UTC</span>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Plan Selection */}
      <PlanSelector
        workspaceId={currentWorkspace.id}
        currentPlanId={subscription?.planId}
      />

      {/* Manage Billing Dialog */}
      <ManageBillingDialog
        open={manageDialogOpen}
        onOpenChange={setManageDialogOpen}
        workspaceId={currentWorkspace.id}
        currentPlanName={planName}
      />
    </div>
  )
})
