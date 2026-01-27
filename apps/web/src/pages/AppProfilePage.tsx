/**
 * AppProfilePage - User profile page within the /app context
 *
 * Shows current user info, workspace memberships, and billing/credits.
 */

import { observer } from "mobx-react-lite"
import { Link } from "react-router-dom"
import { ArrowLeft, User, Building2, Mail, Calendar, CreditCard, Zap, TrendingUp, Settings } from "lucide-react"

import { useSDKDomain, useDomains } from "@/contexts/DomainProvider"
import type { IDomainStore } from "@/generated/domain"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Progress } from "@/components/ui/progress"
import { useSettingsModal } from "@/components/app/shared"
import { useWorkspaceNavigation } from "@/components/app/workspace"

/**
 * AppProfilePage component
 *
 * User profile page showing user info, workspace memberships, and billing.
 */
export const AppProfilePage = observer(function AppProfilePage() {
  const { auth, billing } = useDomains()
  const store = useSDKDomain() as IDomainStore
  const { openSettings } = useSettingsModal()
  const { setWorkspaceSlug } = useWorkspaceNavigation()

  const currentUser = auth.currentUser
  const isLoading = auth.isLoading

  // Get user's workspaces via their memberships
  const userMemberships = currentUser
    ? store.memberCollection?.all?.filter((m: any) => m.userId === currentUser.id) || []
    : []
  
  // Get workspaces the user is a member of
  const userWorkspaceIds = userMemberships.map((m: any) => m.workspaceId)
  const userWorkspaces = currentUser
    ? store.workspaceCollection?.all?.filter((w: any) => userWorkspaceIds.includes(w.id)) || []
    : []

  // Helper to get role for a workspace
  const getRoleForWorkspace = (workspaceId: string) => {
    const membership = userMemberships.find(
      (m: any) => m.workspace?.id === workspaceId
    )
    return membership?.role || "member"
  }

  // Loading state
  if (isLoading) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <div className="space-y-6">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    )
  }

  // Not logged in
  if (!currentUser) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <div className="text-center py-12">
          <User className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
          <h2 className="text-xl font-semibold mb-2">Not Logged In</h2>
          <p className="text-muted-foreground mb-4">
            Please log in to view your profile.
          </p>
          <Link to="/">
            <Button variant="outline">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to App
            </Button>
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-4 mb-6">
        <Link to="/">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back
          </Button>
        </Link>
        <h1 className="text-2xl font-bold">Profile</h1>
      </div>

      {/* User Info Card */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <User className="h-5 w-5" />
            Account Information
          </CardTitle>
          <CardDescription>Your account details</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <Mail className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Email:</span>
            <span className="font-medium">{currentUser.email}</span>
          </div>
          {currentUser.name && (
            <div className="flex items-center gap-3">
              <User className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Name:</span>
              <span className="font-medium">{currentUser.name}</span>
            </div>
          )}
          {currentUser.createdAt && (
            <div className="flex items-center gap-3">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Joined:</span>
              <span className="font-medium">
                {new Date(currentUser.createdAt).toLocaleDateString()}
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Workspaces Card */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5" />
            Workspaces
          </CardTitle>
          <CardDescription>
            Workspaces you belong to ({userWorkspaces.length})
          </CardDescription>
        </CardHeader>
        <CardContent>
          {userWorkspaces.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Building2 className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p>You don't belong to any workspaces yet.</p>
              <p className="text-sm mt-1">
                Create one using the workspace switcher in the header.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {userWorkspaces.map((workspace: any) => {
                // Get billing info for this workspace
                const subscription = billing.subscriptionCollection.findByWorkspace(workspace.id)[0]
                const creditLedger = billing.creditLedgerCollection.findByWorkspace(workspace.id)
                const effectiveBalance = creditLedger?.effectiveBalance

                return (
                  <div
                    key={workspace.id}
                    className="p-4 rounded-lg border bg-card hover:bg-accent/50 transition-colors"
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div>
                        <p className="font-medium">{workspace.name}</p>
                        <p className="text-sm text-muted-foreground">{workspace.slug}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant={getRoleForWorkspace(workspace.id) === "owner" ? "default" : "secondary"}>
                          {getRoleForWorkspace(workspace.id)}
                        </Badge>
                        <Button 
                          variant="ghost" 
                          size="sm"
                          onClick={() => {
                            // Switch to this workspace and open settings
                            setWorkspaceSlug(workspace.slug)
                            openSettings("workspace")
                          }}
                        >
                          <Settings className="h-4 w-4 mr-1" />
                          Manage
                        </Button>
                      </div>
                    </div>

                    {/* Billing Section for Workspace Owners */}
                    {getRoleForWorkspace(workspace.id) === "owner" && (
                      <div className="pt-3 border-t">
                        {subscription ? (
                          <div className="space-y-3">
                            {/* Plan & Credits Row */}
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <CreditCard className="h-4 w-4 text-muted-foreground" />
                                <span className="text-sm font-medium capitalize">
                                  {subscription.planId} Plan
                                </span>
                                <Badge variant={subscription.isActive ? "default" : "secondary"} className="text-xs">
                                  {subscription.status}
                                </Badge>
                              </div>
                              <Link to="/billing">
                                <Button variant="outline" size="sm">
                                  <TrendingUp className="h-3 w-3 mr-1" />
                                  Manage Plan
                                </Button>
                              </Link>
                            </div>

                            {/* Credits Display */}
                            {effectiveBalance && (
                              <div className="bg-muted/50 rounded-lg p-3">
                                <div className="flex items-center justify-between mb-2">
                                  <span className="text-sm font-medium flex items-center gap-1">
                                    <Zap className="h-4 w-4 text-yellow-500" />
                                    Credits
                                  </span>
                                  <span className="text-sm font-bold">
                                    {effectiveBalance.total.toFixed(1)} total
                                  </span>
                                </div>
                                <div className="grid grid-cols-3 gap-2 text-xs">
                                  <div className="text-center p-2 bg-background rounded">
                                    <div className="font-medium">{effectiveBalance.dailyCredits.toFixed(1)}</div>
                                    <div className="text-muted-foreground">Daily</div>
                                  </div>
                                  <div className="text-center p-2 bg-background rounded">
                                    <div className="font-medium">{effectiveBalance.monthlyCredits.toFixed(1)}</div>
                                    <div className="text-muted-foreground">Monthly</div>
                                  </div>
                                  <div className="text-center p-2 bg-background rounded">
                                    <div className="font-medium">{effectiveBalance.rolloverCredits.toFixed(1)}</div>
                                    <div className="text-muted-foreground">Rollover</div>
                                  </div>
                                </div>
                                <div className="mt-2">
                                  <Progress
                                    value={(effectiveBalance.monthlyCredits / 100) * 100}
                                    className="h-1.5"
                                  />
                                  <p className="text-xs text-muted-foreground mt-1">
                                    {subscription.daysRemaining} days until renewal
                                  </p>
                                </div>
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="flex items-center justify-between">
                            <div className="text-sm text-muted-foreground">
                              No active subscription
                            </div>
                            <Link to="/billing">
                              <Button size="sm">
                                <TrendingUp className="h-3 w-3 mr-1" />
                                View Plans
                              </Button>
                            </Link>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
})
