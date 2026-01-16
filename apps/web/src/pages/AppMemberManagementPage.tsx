/**
 * AppMemberManagementPage - Member management within the /app context
 *
 * Uses the current workspace from URL state.
 * Renders member list, invite modal, and pending invitations.
 */

import { useState } from "react"
import { observer } from "mobx-react-lite"
import { Link } from "react-router-dom"
import { ArrowLeft, Users, UserPlus, Mail } from "lucide-react"

import { useWorkspaceData } from "@/components/app/workspace/hooks"
import { MemberList, InviteMemberModal, PendingInvitationsView, MyInvitationsView } from "@/components/app/workspace/members"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useSession } from "@/auth/client"

/**
 * AppMemberManagementPage component
 *
 * Member management page integrated into the /app route.
 * Uses current org from workspace URL state via useWorkspaceData hook.
 */
export const AppMemberManagementPage = observer(function AppMemberManagementPage() {
  // Get current org and role from workspace context
  const { currentOrg, currentOrgRole, isLoading } = useWorkspaceData()

  // Get current user session
  const { data: session } = useSession()
  const currentUserId = session?.user?.id

  // Modal state
  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false)

  // Loading state
  if (isLoading) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 w-48 bg-muted rounded" />
          <div className="h-64 bg-muted rounded" />
        </div>
      </div>
    )
  }

  // No org selected or not logged in
  if (!currentOrg || !currentUserId) {
    return (
      <div className="p-6">
        <div className="text-center py-12">
          <Users className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
          <h2 className="text-xl font-semibold mb-2">No Workspace Selected</h2>
          <p className="text-muted-foreground mb-4">
            Select a workspace from the dropdown to manage members.
          </p>
          <Link to="/app">
            <Button variant="outline">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Workspace
            </Button>
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <Link to="/app">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold">Members</h1>
            <p className="text-sm text-muted-foreground">{currentOrg.name}</p>
          </div>
        </div>
        <Button onClick={() => setIsInviteModalOpen(true)}>
          <UserPlus className="h-4 w-4 mr-2" />
          Invite Member
        </Button>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="members" className="space-y-4">
        <TabsList>
          <TabsTrigger value="members" className="gap-2">
            <Users className="h-4 w-4" />
            Members
          </TabsTrigger>
          <TabsTrigger value="pending" className="gap-2">
            <Mail className="h-4 w-4" />
            Pending Invitations
          </TabsTrigger>
          <TabsTrigger value="my-invitations" className="gap-2">
            <UserPlus className="h-4 w-4" />
            My Invitations
          </TabsTrigger>
        </TabsList>

        <TabsContent value="members">
          <MemberList
            orgId={currentOrg.id}
            currentUserId={currentUserId}
            currentUserRole={currentOrgRole || "viewer"}
          />
        </TabsContent>

        <TabsContent value="pending">
          <PendingInvitationsView orgId={currentOrg.id} />
        </TabsContent>

        <TabsContent value="my-invitations">
          <MyInvitationsView />
        </TabsContent>
      </Tabs>

      {/* Invite Modal */}
      <InviteMemberModal
        open={isInviteModalOpen}
        onOpenChange={setIsInviteModalOpen}
        orgId={currentOrg.id}
      />
    </div>
  )
})
