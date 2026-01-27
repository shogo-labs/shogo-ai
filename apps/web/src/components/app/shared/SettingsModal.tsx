/**
 * SettingsModal - Unified settings modal with tabbed navigation
 * 
 * Combines all settings into a single modal dialog with tabs:
 * - Workspace settings (name, avatar, leave)
 * - People (members, invitations)
 * - Plans & credits (billing, subscription)
 * - Account (profile, linked accounts)
 * - Integrations (GitHub, connectors)
 * 
 * Inspired by Lovable.dev's settings modal design.
 */

import { useState, useEffect, useCallback, createContext, useContext } from "react"
import { observer } from "mobx-react-lite"
import { useNavigate } from "react-router-dom"
import { format } from "date-fns"
import {
  Building2,
  Users,
  CreditCard,
  User,
  Link2,
  Github,
  Settings,
  ExternalLink,
  Search,
  UserPlus,
  Download,
  MoreHorizontal,
  Loader2,
  Trash2,
  ChevronDown,
  Check,
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { useWorkspaceData } from "../workspace"
import { useSDKDomain, useDomains } from "@/contexts/DomainProvider"
import { useDomainActions } from "@/generated/domain-actions"
import type { IDomainStore } from "@/generated/domain"
import { useSession } from "@/contexts/SessionProvider"
import { InviteMemberModal } from "../workspace/members/InviteMemberModal"

type TabId = "workspace" | "people" | "billing" | "account" | "integrations"

interface SettingsModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultTab?: TabId
}

interface TabItemProps {
  id: TabId
  label: string
  icon: React.ElementType
  active: boolean
  onClick: () => void
  badge?: string
}

function TabItem({ id, label, icon: Icon, active, onClick, badge }: TabItemProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-3 w-full px-3 py-2 rounded-md text-sm transition-colors text-left",
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground"
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="flex-1">{label}</span>
      {badge && (
        <Badge variant="secondary" className="text-[10px] h-5">
          {badge}
        </Badge>
      )}
    </button>
  )
}

// Workspace Settings Tab
function WorkspaceTab({ onClose }: { onClose?: () => void }) {
  const navigate = useNavigate()
  const { currentWorkspace, workspaces } = useWorkspaceData()
  const store = useSDKDomain() as IDomainStore
  const actions = useDomainActions()
  const { data: session } = useSession()
  const [name, setName] = useState(currentWorkspace?.name || "")
  const [isSaving, setIsSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">("idle")
  
  // Delete workspace state
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [deleteConfirmText, setDeleteConfirmText] = useState("")

  const originalName = currentWorkspace?.name || ""
  const hasChanges = name !== originalName
  const isValid = name.trim().length > 0 && name.length <= 50
  
  // Check if user is the owner of this workspace
  const currentUserId = session?.user?.id
  const members = currentWorkspace?.id 
    ? store?.memberCollection?.all?.filter((m: any) => m.workspaceId === currentWorkspace.id) || []
    : []
  const currentUserMember = members.find((m: any) => m.userId === currentUserId)
  const isOwner = currentUserMember?.role === "owner"
  
  // Check if this is a personal workspace (cannot be deleted)
  const isPersonalWorkspace = 
    currentWorkspace?.slug?.includes("personal") || 
    currentWorkspace?.name?.toLowerCase().includes("personal")
  
  // Can only delete if owner, have more than one workspace, and not a personal workspace
  const canDelete = isOwner && workspaces.length > 1 && !isPersonalWorkspace
  const deleteConfirmRequired = currentWorkspace?.name || "delete"
  const isDeleteConfirmed = deleteConfirmText === deleteConfirmRequired

  useEffect(() => {
    setName(currentWorkspace?.name || "")
    setSaveStatus("idle")
  }, [currentWorkspace?.name])

  const handleSave = async () => {
    if (!hasChanges || !isValid || !currentWorkspace?.id) return
    
    setIsSaving(true)
    setSaveStatus("idle")
    
    try {
      // Update workspace name via SDK actions
      await actions?.updateWorkspace(currentWorkspace.id, {
        name: name.trim(),
      })
      
      setSaveStatus("saved")
      // Clear the "saved" status after 2 seconds
      setTimeout(() => setSaveStatus("idle"), 2000)
    } catch (error) {
      console.error("Failed to save workspace name:", error)
      setSaveStatus("error")
    } finally {
      setIsSaving(false)
    }
  }

  const handleDeleteWorkspace = async () => {
    if (!currentWorkspace?.id || !isDeleteConfirmed || !actions) return
    
    setIsDeleting(true)
    
    try {
      // Delete workspace with all members via SDK action
      await actions.deleteWorkspaceWithMembers(currentWorkspace.id)
      
      // Close the dialog and modal
      setIsDeleteDialogOpen(false)
      onClose?.()
      
      // Navigate to home - the workspace switcher will select the next available workspace
      navigate("/")
    } catch (error) {
      console.error("Failed to delete workspace:", error)
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">Workspace settings</h3>
        <p className="text-sm text-muted-foreground">
          Manage your workspace configuration.
        </p>
      </div>

      <div className="space-y-4">
        {/* Workspace avatar */}
        <div className="flex items-start justify-between">
          <div>
            <Label>Workspace avatar</Label>
            <p className="text-xs text-muted-foreground">
              Set an avatar for your workspace.
            </p>
          </div>
          <div className="h-12 w-12 rounded-lg bg-primary/10 flex items-center justify-center text-lg font-medium">
            {currentWorkspace?.name?.[0]?.toUpperCase() || "W"}
          </div>
        </div>

        {/* Workspace name */}
        <div className="space-y-2">
          <Label htmlFor="workspace-name">Workspace name</Label>
          <p className="text-xs text-muted-foreground">
            Your full workspace name, as visible to others.
          </p>
          <div className="flex gap-2 items-start">
            <div className="flex-1 max-w-md space-y-1">
              <Input
                id="workspace-name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  setSaveStatus("idle")
                }}
                maxLength={50}
              />
              <p className="text-xs text-muted-foreground">
                {name.length} / 50 characters
              </p>
            </div>
            <Button 
              onClick={handleSave}
              disabled={!hasChanges || !isValid || isSaving}
              size="sm"
            >
              {isSaving ? "Saving..." : "Save"}
            </Button>
          </div>
          {saveStatus === "saved" && (
            <p className="text-xs text-green-600">Changes saved successfully!</p>
          )}
          {saveStatus === "error" && (
            <p className="text-xs text-destructive">Failed to save changes. Please try again.</p>
          )}
        </div>

        <Separator className="my-6" />

        {/* Danger zone */}
        <div className="space-y-4">
          <div>
            <h4 className="text-sm font-medium text-destructive">Danger zone</h4>
            <p className="text-xs text-muted-foreground">
              Irreversible and destructive actions.
            </p>
          </div>

          {/* Leave workspace */}
          <div className="flex items-start justify-between p-4 rounded-lg border border-destructive/20 bg-destructive/5">
            <div>
              <Label>Leave workspace</Label>
              <p className="text-xs text-muted-foreground">
                Remove yourself from this workspace. You cannot leave your last workspace.
              </p>
            </div>
            <Button variant="outline" size="sm" disabled className="border-destructive/50 text-destructive hover:bg-destructive/10">
              Leave
            </Button>
          </div>

          {/* Delete workspace - only for owners */}
          {isOwner && (
            <div className="flex items-start justify-between p-4 rounded-lg border border-destructive/20 bg-destructive/5">
              <div>
                <Label className="text-destructive">Delete workspace</Label>
                <p className="text-xs text-muted-foreground">
                  {canDelete 
                    ? "Permanently delete this workspace and all its data. This action cannot be undone."
                    : isPersonalWorkspace
                    ? "Your personal workspace cannot be deleted."
                    : "You cannot delete your only workspace. Create another workspace first."}
                </p>
              </div>
              <Button 
                variant="destructive" 
                size="sm" 
                disabled={!canDelete}
                onClick={() => setIsDeleteDialogOpen(true)}
              >
                <Trash2 className="h-4 w-4 mr-1" />
                Delete
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Delete Workspace Confirmation Dialog */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-destructive">Delete workspace</AlertDialogTitle>
            <AlertDialogDescription className="space-y-3">
              <p>
                This action <strong>cannot be undone</strong>. This will permanently delete the 
                workspace <strong>{currentWorkspace?.name}</strong> and remove all associated data including:
              </p>
              <ul className="list-disc list-inside text-sm space-y-1">
                <li>All projects and their contents</li>
                <li>All member access and invitations</li>
                <li>All billing and subscription data</li>
              </ul>
              <p className="pt-2">
                Please type <strong>{deleteConfirmRequired}</strong> to confirm.
              </p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            value={deleteConfirmText}
            onChange={(e) => setDeleteConfirmText(e.target.value)}
            placeholder={`Type "${deleteConfirmRequired}" to confirm`}
            className="mt-2"
          />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting} onClick={() => setDeleteConfirmText("")}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteWorkspace}
              disabled={!isDeleteConfirmed || isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Deleting...
                </>
              ) : (
                <>
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete workspace
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// Role level mapping for permission checks
const RoleLevels: Record<string, number> = {
  owner: 40,
  admin: 30,
  member: 20,
  viewer: 10,
}

// Member interface
interface Member {
  id: string
  userId: string
  role: "owner" | "admin" | "member" | "viewer"
  createdAt: number
  updatedAt?: number
}

// People Tab - Full member management
function PeopleTab() {
  const { currentWorkspace } = useWorkspaceData()
  const store = useSDKDomain() as IDomainStore
  const actions = useDomainActions()
  const { data: session } = useSession()
  const currentUserId = session?.user?.id || ""
  const currentUserName = session?.user?.name || "User"
  const currentUserEmail = session?.user?.email || ""

  // State
  const [members, setMembers] = useState<Member[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState("")
  const [roleFilter, setRoleFilter] = useState<string>("all")
  const [activeSubTab, setActiveSubTab] = useState("all")
  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false)
  const [memberToRemove, setMemberToRemove] = useState<Member | null>(null)
  const [isRemoving, setIsRemoving] = useState(false)
  const [updatingMemberId, setUpdatingMemberId] = useState<string | null>(null)

  // Determine current user's role
  const currentUserMember = members.find(m => m.userId === currentUserId)
  const currentUserRole = currentUserMember?.role || "viewer"
  const currentUserLevel = RoleLevels[currentUserRole] ?? 0
  const canManageMembers = currentUserLevel >= RoleLevels.admin

  // Load members
  const loadMembers = useCallback(async () => {
    if (!store?.memberCollection || !currentWorkspace?.id) {
      setIsLoading(false)
      return
    }

    setIsLoading(true)
    try {
      await store.memberCollection.loadAll({ workspaceId: currentWorkspace.id })
      const workspaceMembers = store.memberCollection.all.filter((m: any) => m.workspaceId === currentWorkspace.id)
      setMembers(workspaceMembers.map((m: any) => ({
        id: m.id,
        userId: m.userId,
        role: m.role,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
      })))
    } catch (err) {
      console.error("[PeopleTab] Failed to load members:", err)
    } finally {
      setIsLoading(false)
    }
  }, [store, currentWorkspace?.id])

  useEffect(() => {
    loadMembers()
  }, [loadMembers])

  // Filter members
  const filteredMembers = members.filter(member => {
    if (roleFilter !== "all" && member.role !== roleFilter) return false
    if (searchQuery) {
      const query = searchQuery.toLowerCase()
      return member.userId.toLowerCase().includes(query)
    }
    return true
  })

  // Check if current user can manage a specific member
  const canManageMember = (member: Member): boolean => {
    if (member.userId === currentUserId) return false
    const memberLevel = RoleLevels[member.role] ?? 0
    return currentUserLevel > memberLevel
  }

  // Get available roles for a member
  const getAvailableRoles = (member: Member): string[] => {
    if (member.role === "owner" && currentUserRole !== "owner") return []
    return Object.keys(RoleLevels).filter((role) => {
      if (role === "owner" && currentUserRole !== "owner") return false
      return RoleLevels[role] <= currentUserLevel
    })
  }

  // Handle role change
  const handleRoleChange = async (memberId: string, newRole: string) => {
    if (!actions) return
    setUpdatingMemberId(memberId)
    try {
      await actions.updateMemberRole(memberId, newRole as any, currentUserId)
      await loadMembers()
    } catch (err) {
      console.error("[PeopleTab] Failed to update role:", err)
    } finally {
      setUpdatingMemberId(null)
    }
  }

  // Handle member removal
  const handleRemoveMember = async () => {
    if (!memberToRemove || !actions) return
    setIsRemoving(true)
    try {
      await actions.removeMember(memberToRemove.id, currentUserId)
      setMembers(prev => prev.filter(m => m.id !== memberToRemove.id))
      setMemberToRemove(null)
    } catch (err) {
      console.error("[PeopleTab] Failed to remove member:", err)
    } finally {
      setIsRemoving(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <h3 className="text-lg font-semibold">People</h3>
        <p className="text-sm text-muted-foreground">
          Inviting people to <strong>{currentWorkspace?.name}</strong> gives access to workspace shared projects and credits.
          You have {members.length} {members.length === 1 ? "builder" : "builders"} in this workspace.
        </p>
      </div>

      {/* Sub-tabs and actions bar */}
      <div className="space-y-3">
        <Tabs value={activeSubTab} onValueChange={setActiveSubTab}>
          <div className="flex items-center justify-between gap-4">
            <TabsList className="h-8">
              <TabsTrigger value="all" className="text-xs px-3 h-7">All</TabsTrigger>
              <TabsTrigger value="invitations" className="text-xs px-3 h-7">Invitations</TabsTrigger>
            </TabsList>

            {/* Search and actions */}
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-8 h-8 w-40 text-sm"
                />
              </div>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8 gap-1">
                    {roleFilter === "all" ? "All roles" : roleFilter.charAt(0).toUpperCase() + roleFilter.slice(1)}
                    <ChevronDown className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => setRoleFilter("all")}>
                    All roles
                    {roleFilter === "all" && <Check className="ml-auto h-4 w-4" />}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {["owner", "admin", "member", "viewer"].map(role => (
                    <DropdownMenuItem key={role} onClick={() => setRoleFilter(role)}>
                      {role.charAt(0).toUpperCase() + role.slice(1)}
                      {roleFilter === role && <Check className="ml-auto h-4 w-4" />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              <Button variant="outline" size="sm" className="h-8 gap-1">
                <Download className="h-3.5 w-3.5" />
                Export
              </Button>

              <Button size="sm" className="h-8 gap-1" onClick={() => setIsInviteModalOpen(true)}>
                <UserPlus className="h-3.5 w-3.5" />
                Invite members
              </Button>
            </div>
          </div>

          <TabsContent value="all" className="mt-3">
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                <span className="ml-2 text-sm text-muted-foreground">Loading members...</span>
              </div>
            ) : filteredMembers.length === 0 ? (
              <div className="text-center py-8 text-sm text-muted-foreground">
                {searchQuery ? "No members found matching your search" : "No members found"}
              </div>
            ) : (
              <div className="rounded-md border overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="px-3 py-2 text-left font-medium text-muted-foreground">Name</th>
                      <th className="px-3 py-2 text-left font-medium text-muted-foreground">Role</th>
                      <th className="px-3 py-2 text-left font-medium text-muted-foreground">Joined date</th>
                      <th className="px-3 py-2 w-10"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredMembers.map((member) => {
                      const isCurrentUser = member.userId === currentUserId
                      const canManage = canManageMembers && canManageMember(member)
                      const availableRoles = getAvailableRoles(member)

                      return (
                        <tr key={member.id} className={cn("border-b last:border-b-0", isCurrentUser && "bg-primary/5")}>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-2">
                              <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center text-xs font-medium shrink-0">
                                {isCurrentUser ? currentUserName[0]?.toUpperCase() : member.userId[0]?.toUpperCase() || "U"}
                              </div>
                              <div className="min-w-0">
                                <div className="font-medium truncate">
                                  {isCurrentUser ? `${currentUserName} (you)` : `User ${member.userId.slice(0, 8)}`}
                                </div>
                                <div className="text-xs text-muted-foreground truncate">
                                  {isCurrentUser ? currentUserEmail : `${member.userId.slice(0, 16)}...`}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            {canManage && availableRoles.length > 1 ? (
                              <Select
                                value={member.role}
                                onValueChange={(value) => handleRoleChange(member.id, value)}
                                disabled={updatingMemberId === member.id}
                              >
                                <SelectTrigger className="h-7 w-24 text-xs">
                                  {updatingMemberId === member.id ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                  ) : (
                                    <SelectValue />
                                  )}
                                </SelectTrigger>
                                <SelectContent>
                                  {availableRoles.map((role) => (
                                    <SelectItem key={role} value={role} className="text-xs">
                                      {role.charAt(0).toUpperCase() + role.slice(1)}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            ) : (
                              <Badge variant="outline" className="text-xs font-normal">
                                {member.role.charAt(0).toUpperCase() + member.role.slice(1)}
                              </Badge>
                            )}
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">
                            {format(new Date(member.createdAt), "MMM d, yyyy")}
                          </td>
                          <td className="px-3 py-2">
                            {canManage && (
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button variant="ghost" size="icon" className="h-7 w-7">
                                    <MoreHorizontal className="h-4 w-4" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuItem
                                    onClick={() => setMemberToRemove(member)}
                                    className="text-destructive"
                                  >
                                    <Trash2 className="mr-2 h-4 w-4" />
                                    Remove member
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </TabsContent>

          <TabsContent value="invitations" className="mt-3">
            <div className="text-center py-8 text-sm text-muted-foreground">
              <UserPlus className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p>No pending invitations</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => setIsInviteModalOpen(true)}
              >
                Invite members
              </Button>
            </div>
          </TabsContent>
        </Tabs>
      </div>

      {/* Invite Member Modal */}
      <InviteMemberModal
        open={isInviteModalOpen}
        onOpenChange={setIsInviteModalOpen}
        workspaceId={currentWorkspace?.id || ""}
        onSuccess={loadMembers}
      />

      {/* Remove Member Confirmation Dialog */}
      <AlertDialog open={!!memberToRemove} onOpenChange={(open) => !open && setMemberToRemove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Member</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove this member from the workspace?
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isRemoving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRemoveMember}
              disabled={isRemoving}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isRemoving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Removing...
                </>
              ) : (
                "Remove"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// Billing Tab
function BillingTab() {
  const navigate = useNavigate()

  // Mock data - would come from billing domain
  const planType = "Free"
  const creditsUsed = 0
  const creditsTotal = 5

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">Plans & credits</h3>
        <p className="text-sm text-muted-foreground">
          Manage your subscription and credits.
        </p>
      </div>

      {/* Current plan */}
      <div className="p-4 bg-card rounded-lg border space-y-4">
        <div className="flex items-center gap-4">
          <div className="h-12 w-12 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
            <CreditCard className="h-6 w-6 text-white" />
          </div>
          <div>
            <div className="font-medium">You're on {planType} Plan</div>
            <div className="text-sm text-muted-foreground">Upgrade anytime</div>
          </div>
          <Button className="ml-auto" onClick={() => navigate("/billing")}>
            Manage
          </Button>
        </div>

        <Separator />

        {/* Credits */}
        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Credits remaining</span>
            <span className="font-medium">{creditsTotal - creditsUsed} of {creditsTotal}</span>
          </div>
          <Progress value={((creditsTotal - creditsUsed) / creditsTotal) * 100} className="h-2" />
          <p className="text-xs text-muted-foreground">
            Daily credits reset at midnight UTC
          </p>
        </div>
      </div>

      {/* View plans button */}
      <Button variant="outline" className="w-full" onClick={() => navigate("/billing")}>
        View all plans
        <ExternalLink className="h-4 w-4 ml-2" />
      </Button>
    </div>
  )
}

// Account Tab
function AccountTab() {
  const { data: session } = useSession()
  const { auth } = useDomains()
  const user = session?.user
  
  // Form state
  const [name, setName] = useState(user?.name || "")
  const [isSaving, setIsSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">("idle")

  // Track original values for change detection
  const originalName = user?.name || ""
  const hasChanges = name !== originalName
  const isValid = name.trim().length > 0

  // Reset form when user data changes
  useEffect(() => {
    setName(user?.name || "")
    setSaveStatus("idle")
  }, [user?.name])

  // Handle cancel - reset to original values
  const handleCancel = () => {
    setName(originalName)
    setSaveStatus("idle")
  }

  // Handle save
  const handleSave = async () => {
    if (!hasChanges || !isValid || isSaving || !user?.id) return

    setIsSaving(true)
    setSaveStatus("idle")

    try {
      // Update user profile via domain collection (MCP persistence)
      await auth?.userCollection?.updateOne(user.id, {
        name: name.trim(),
        updatedAt: new Date().toISOString(),
      })

      setSaveStatus("saved")
      setTimeout(() => setSaveStatus("idle"), 2000)
    } catch (error) {
      console.error("Failed to save account settings:", error)
      setSaveStatus("error")
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 space-y-6">
        <div>
          <h3 className="text-lg font-semibold">Account settings</h3>
          <p className="text-sm text-muted-foreground">
            Personalize how others see and interact with you.
          </p>
        </div>

        <div className="space-y-4">
          {/* Avatar */}
          <div className="flex items-start justify-between">
            <div>
              <Label>Your avatar</Label>
              <p className="text-xs text-muted-foreground">
                Your avatar is automatically generated.
              </p>
            </div>
            <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center text-lg font-medium">
              {user?.name?.[0]?.toUpperCase() || "U"}
            </div>
          </div>

          {/* Email */}
          <div className="space-y-2">
            <Label>Email</Label>
            <p className="text-xs text-muted-foreground">
              Your email address associated with your account.
            </p>
            <Input value={user?.email || ""} disabled className="max-w-md" />
          </div>

          {/* Name */}
          <div className="space-y-2">
            <Label htmlFor="account-name">Name</Label>
            <p className="text-xs text-muted-foreground">
              Your full name, as visible to others.
            </p>
            <Input
              id="account-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                setSaveStatus("idle")
              }}
              placeholder="Enter your name"
              className="max-w-md"
              maxLength={100}
            />
            {saveStatus === "saved" && (
              <p className="text-xs text-green-600">Changes saved successfully!</p>
            )}
            {saveStatus === "error" && (
              <p className="text-xs text-destructive">Failed to save changes. Please try again.</p>
            )}
          </div>
        </div>
      </div>

      {/* Bottom toolbar - shows when there are unsaved changes */}
      {hasChanges && (
        <div className="flex items-center justify-end gap-2 pt-4 mt-4 border-t">
          <Button
            variant="outline"
            size="sm"
            onClick={handleCancel}
            disabled={isSaving}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={!isValid || isSaving}
          >
            {isSaving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : (
              "Save changes"
            )}
          </Button>
        </div>
      )}
    </div>
  )
}

// Integrations Tab
function IntegrationsTab() {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">Integrations</h3>
        <p className="text-sm text-muted-foreground">
          Connect external services to enhance your workflow.
        </p>
      </div>

      <div className="space-y-4">
        {/* GitHub */}
        <div className="p-4 bg-card rounded-lg border">
          <div className="flex items-center gap-4">
            <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center">
              <Github className="h-5 w-5" />
            </div>
            <div className="flex-1">
              <div className="font-medium">GitHub</div>
              <div className="text-sm text-muted-foreground">
                Sync your project with GitHub
              </div>
            </div>
            <Button variant="outline" size="sm">
              Connect
            </Button>
          </div>
        </div>

        {/* More integrations */}
        <div className="p-4 bg-muted/50 rounded-lg text-center">
          <p className="text-sm text-muted-foreground">
            More integrations coming soon
          </p>
        </div>
      </div>
    </div>
  )
}

/**
 * SettingsModal component
 * 
 * Modal dialog with tabbed navigation for all settings.
 */
export const SettingsModal = observer(function SettingsModal({
  open,
  onOpenChange,
  defaultTab = "workspace",
}: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<TabId>(defaultTab)
  const { currentWorkspace } = useWorkspaceData()

  // Reset to default tab when modal opens
  useEffect(() => {
    if (open) {
      setActiveTab(defaultTab)
    }
  }, [open, defaultTab])

  const tabs: { id: TabId; label: string; icon: React.ElementType; badge?: string }[] = [
    { id: "workspace", label: currentWorkspace?.name || "Workspace", icon: Building2 },
    { id: "people", label: "People", icon: Users },
    { id: "billing", label: "Plans & credits", icon: CreditCard },
    { id: "account", label: "Account", icon: User },
    { id: "integrations", label: "Integrations", icon: Link2 },
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[80%] p-0 gap-0 h-[80%] overflow-hidden">
        <DialogTitle className="sr-only">Settings</DialogTitle>

        <div className="flex h-full">
          {/* Sidebar */}
          <div className="w-56 border-r border-border p-3 space-y-1">
            <div className="px-3 py-2 text-xs font-medium text-muted-foreground/70 uppercase tracking-wider">
              Settings
            </div>
            {tabs.map((tab) => (
              <TabItem
                key={tab.id}
                id={tab.id}
                label={tab.label}
                icon={tab.icon}
                active={activeTab === tab.id}
                onClick={() => setActiveTab(tab.id)}
                badge={tab.badge}
              />
            ))}
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-6">
            {activeTab === "workspace" && <WorkspaceTab onClose={() => onOpenChange(false)} />}
            {activeTab === "people" && <PeopleTab />}
            {activeTab === "billing" && <BillingTab />}
            {activeTab === "account" && <AccountTab />}
            {activeTab === "integrations" && <IntegrationsTab />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
})

// Context for opening settings modal from anywhere
interface SettingsModalContextValue {
  openSettings: (tab?: TabId) => void
}

const SettingsModalContext = createContext<SettingsModalContextValue | null>(null)

export function useSettingsModal() {
  const context = useContext(SettingsModalContext)
  if (!context) {
    throw new Error("useSettingsModal must be used within SettingsModalProvider")
  }
  return context
}

export function SettingsModalProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const [defaultTab, setDefaultTab] = useState<TabId>("workspace")

  const openSettings = (tab: TabId = "workspace") => {
    setDefaultTab(tab)
    setOpen(true)
  }

  return (
    <SettingsModalContext.Provider value={{ openSettings }}>
      {children}
      <SettingsModal
        open={open}
        onOpenChange={setOpen}
        defaultTab={defaultTab}
      />
    </SettingsModalContext.Provider>
  )
}
