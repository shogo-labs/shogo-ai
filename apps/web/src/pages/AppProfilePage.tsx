/**
 * AppProfilePage - User profile page within the /app context
 *
 * Shows current user info and their organization memberships.
 */

import { observer } from "mobx-react-lite"
import { Link } from "react-router-dom"
import { ArrowLeft, User, Building2, Mail, Calendar } from "lucide-react"

import { useDomains } from "@/contexts/DomainProvider"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"

/**
 * AppProfilePage component
 *
 * User profile page showing user info and organization memberships.
 */
export const AppProfilePage = observer(function AppProfilePage() {
  const { auth, studioCore } = useDomains()

  const currentUser = auth.currentUser
  const isLoading = auth.isLoading

  // Get user's organizations via their memberships
  const userOrgs = currentUser
    ? studioCore.organizationCollection.findByMembership(currentUser.id)
    : []

  // Get membership details for role display
  const userMemberships = currentUser
    ? studioCore.memberCollection.findByUserId(currentUser.id)
    : []

  // Helper to get role for an org
  const getRoleForOrg = (orgId: string) => {
    const membership = userMemberships.find(
      (m: any) => m.organization?.id === orgId
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
          <Link to="/app">
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
        <Link to="/app">
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

      {/* Organizations Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5" />
            Organizations
          </CardTitle>
          <CardDescription>
            Organizations you belong to ({userOrgs.length})
          </CardDescription>
        </CardHeader>
        <CardContent>
          {userOrgs.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Building2 className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p>You don't belong to any organizations yet.</p>
              <p className="text-sm mt-1">
                Create one using the org switcher in the header.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {userOrgs.map((org: any) => (
                <div
                  key={org.id}
                  className="flex items-center justify-between p-3 rounded-lg border bg-card hover:bg-accent/50 transition-colors"
                >
                  <div>
                    <p className="font-medium">{org.name}</p>
                    <p className="text-sm text-muted-foreground">{org.slug}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={getRoleForOrg(org.id) === "owner" ? "default" : "secondary"}>
                      {getRoleForOrg(org.id)}
                    </Badge>
                    <Link to={`/app/members?org=${org.slug}`}>
                      <Button variant="ghost" size="sm">
                        Manage
                      </Button>
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
})
