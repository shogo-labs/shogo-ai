/**
 * AppBillingPage - Workspace billing and plan management
 *
 * Allows users to view current plan, upgrade/downgrade, and manage billing.
 */

import { useState, useEffect } from "react"
import { observer } from "mobx-react-lite"
import { Link, useSearchParams } from "react-router-dom"
import { ArrowLeft, Building2, ExternalLink, CheckCircle2 } from "lucide-react"

import { useDomains } from "@/contexts/DomainProvider"
import { useWorkspaceData } from "@/components/app/workspace/hooks"
import { useSession } from "@/auth/client"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { PlanSelector } from "@/components/app/billing/PlanSelector"

export const AppBillingPage = observer(function AppBillingPage() {
  const { billing } = useDomains()
  const { data: session, isPending: isAuthLoading } = useSession()
  const { currentWorkspace, isLoading: isWorkspaceLoading } = useWorkspaceData()
  const [searchParams, setSearchParams] = useSearchParams()

  const [isLoading, setIsLoading] = useState(false)
  const [showSuccess, setShowSuccess] = useState(false)

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

      // Refresh subscription data from the server
      billing.subscriptionCollection.query().toArray().catch(console.error)
      billing.creditLedgerCollection.query().toArray().catch(console.error)
    }
  }, [isSuccess, currentWorkspace, searchParams, setSearchParams, billing])

  // Get current subscription
  const subscription = currentWorkspace
    ? billing.subscriptionCollection.findByWorkspace(currentWorkspace.id)[0]
    : null

  const handleManageBilling = async () => {
    if (!currentWorkspace) return

    setIsLoading(true)
    try {
      const response = await fetch(`/api/billing/portal?workspaceId=${currentWorkspace.id}`, {
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

  if (!currentUser || !currentWorkspace) {
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
            <p className="text-muted-foreground">{currentWorkspace.name}</p>
          </div>
        </div>
        {subscription && (
          <Button variant="outline" onClick={handleManageBilling} disabled={isLoading}>
            <ExternalLink className="h-4 w-4 mr-2" />
            Manage Billing
          </Button>
        )}
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

      {/* Plan Selection */}
      <PlanSelector
        workspaceId={currentWorkspace.id}
        currentPlanId={subscription?.planId}
      />

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
