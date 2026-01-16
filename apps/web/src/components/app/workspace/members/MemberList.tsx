/**
 * MemberList Component
 * Task: task-member-list-ui
 * Feature: member-management-invitation
 *
 * Displays a list of workspace members with role management capabilities.
 * Admins and owners can update roles and remove members.
 *
 * Uses MCP domain (studioCore) for all data operations.
 */

import { useState, useEffect, useCallback } from "react"
import { Loader2, Trash2, UserCircle } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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
import { cn } from "@/lib/utils"
import { useDomains } from "@/contexts/DomainProvider"

/**
 * Member data from MCP domain
 */
interface Member {
  id: string
  userId: string
  role: "owner" | "admin" | "member" | "viewer"
  createdAt: number
  updatedAt?: number
}

/**
 * Props for MemberList component
 */
export interface MemberListProps {
  /** Workspace ID to fetch members for */
  orgId: string
  /** Current user's ID */
  currentUserId: string
  /** Current user's role in this workspace */
  currentUserRole: "owner" | "admin" | "member" | "viewer"
  /** Callback when member list changes (e.g., role updated or member removed) */
  onMembersChange?: () => void
}

/**
 * Role level mapping for permission checks
 */
const RoleLevels: Record<string, number> = {
  owner: 40,
  admin: 30,
  member: 20,
  viewer: 10,
}

/**
 * Role badge variant mapping
 */
const roleBadgeVariant: Record<string, "default" | "secondary" | "outline"> = {
  owner: "default",
  admin: "secondary",
  member: "outline",
  viewer: "outline",
}

/**
 * MemberList Component
 *
 * Renders a table of workspace members with role management.
 * Uses MCP domain for data operations.
 */
export function MemberList({ orgId, currentUserId, currentUserRole, onMembersChange }: MemberListProps) {
  // Get studioCore domain
  const { studioCore } = useDomains()

  // Data state
  const [members, setMembers] = useState<Member[]>([])

  // UI state
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [updatingMemberId, setUpdatingMemberId] = useState<string | null>(null)
  const [memberToRemove, setMemberToRemove] = useState<Member | null>(null)
  const [isRemoving, setIsRemoving] = useState(false)

  // Current user's role level for permission checks
  const currentUserLevel = RoleLevels[currentUserRole] ?? 0
  const canManageMembers = currentUserLevel >= RoleLevels.admin

  /**
   * Load members from MCP domain
   */
  const loadMembers = useCallback(async () => {
    if (!studioCore?.memberCollection) {
      setIsLoading(false)
      return
    }

    setIsLoading(true)
    setError(null)

    try {
      // Load members from backend
      await studioCore.memberCollection.query().toArray()

      // Get members for this organization
      const orgMembers = studioCore.memberCollection.findForResource("organization", orgId)

      setMembers(orgMembers.map((m: any) => ({
        id: m.id,
        userId: m.userId,
        role: m.role,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
      })))
    } catch (err) {
      console.error("[MemberList] Failed to load members:", err)
      setError(err instanceof Error ? err.message : "Failed to load members")
    } finally {
      setIsLoading(false)
    }
  }, [orgId, studioCore])

  // Load members on mount and orgId change
  useEffect(() => {
    loadMembers()
  }, [loadMembers])

  /**
   * Handle role change for a member
   */
  const handleRoleChange = async (memberId: string, newRole: string) => {
    if (!studioCore) return

    setUpdatingMemberId(memberId)
    setError(null)

    try {
      await studioCore.updateMemberRole(memberId, newRole, currentUserId)

      // Reload members to get updated data
      await loadMembers()
      onMembersChange?.()
    } catch (err) {
      console.error("[MemberList] Failed to update role:", err)
      setError(err instanceof Error ? err.message : "Failed to update role")
    } finally {
      setUpdatingMemberId(null)
    }
  }

  /**
   * Handle member removal
   */
  const handleRemoveMember = async () => {
    if (!memberToRemove || !studioCore) return

    setIsRemoving(true)
    setError(null)

    try {
      await studioCore.removeMember(memberToRemove.id, currentUserId)

      // Update local state
      setMembers((prev) => prev.filter((m) => m.id !== memberToRemove.id))
      setMemberToRemove(null)
      onMembersChange?.()
    } catch (err) {
      console.error("[MemberList] Failed to remove member:", err)
      setError(err instanceof Error ? err.message : "Failed to remove member")
    } finally {
      setIsRemoving(false)
    }
  }

  /**
   * Check if current user can manage a specific member
   */
  const canManageMember = (member: Member): boolean => {
    // Cannot manage yourself
    if (member.userId === currentUserId) return false
    // Must have higher level than target
    const memberLevel = RoleLevels[member.role] ?? 0
    return currentUserLevel > memberLevel
  }

  /**
   * Get available roles for role select (only roles lower than current user)
   */
  const getAvailableRoles = (member: Member): string[] => {
    // Owners can only be changed by other owners
    if (member.role === "owner" && currentUserRole !== "owner") return []

    // Filter roles to only those the current user can assign
    return Object.keys(RoleLevels).filter((role) => {
      // Cannot assign owner unless you are owner
      if (role === "owner" && currentUserRole !== "owner") return false
      // Can assign roles at or below your level
      return RoleLevels[role] <= currentUserLevel
    })
  }

  // Loading state
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        <span className="ml-2 text-muted-foreground">Loading members...</span>
      </div>
    )
  }

  // Error state
  if (error) {
    return (
      <div className="p-4 bg-destructive/10 border border-destructive/30 rounded-md text-destructive text-sm">
        {error}
      </div>
    )
  }

  // Empty state
  if (members.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        No members found
      </div>
    )
  }

  return (
    <>
      <div className="rounded-md border">
        <table className="w-full">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                Member
              </th>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                Role
              </th>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                Joined
              </th>
              {canManageMembers && (
                <th className="px-4 py-3 text-right text-sm font-medium text-muted-foreground">
                  Actions
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {members.map((member) => {
              const isCurrentUser = member.userId === currentUserId
              const canManage = canManageMembers && canManageMember(member)
              const availableRoles = getAvailableRoles(member)

              return (
                <tr
                  key={member.id}
                  className={cn(
                    "border-b last:border-b-0",
                    isCurrentUser && "bg-primary/5"
                  )}
                >
                  {/* Member Info */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <UserCircle className="h-8 w-8 text-muted-foreground" />
                      <div>
                        <div className="font-medium">
                          {member.userId.slice(0, 16)}...
                          {isCurrentUser && (
                            <span className="ml-2 text-xs text-muted-foreground">(you)</span>
                          )}
                        </div>
                        <div className="text-sm text-muted-foreground">
                          Member ID: {member.id.slice(0, 8)}
                        </div>
                      </div>
                    </div>
                  </td>

                  {/* Role */}
                  <td className="px-4 py-3">
                    {canManage && availableRoles.length > 1 ? (
                      <Select
                        value={member.role}
                        onValueChange={(value) => handleRoleChange(member.id, value)}
                        disabled={updatingMemberId === member.id}
                      >
                        <SelectTrigger className="w-32">
                          {updatingMemberId === member.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <SelectValue />
                          )}
                        </SelectTrigger>
                        <SelectContent>
                          {availableRoles.map((role) => (
                            <SelectItem key={role} value={role}>
                              {role.charAt(0).toUpperCase() + role.slice(1)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Badge variant={roleBadgeVariant[member.role] || "outline"}>
                        {member.role.charAt(0).toUpperCase() + member.role.slice(1)}
                      </Badge>
                    )}
                  </td>

                  {/* Joined Date */}
                  <td className="px-4 py-3 text-sm text-muted-foreground">
                    {new Date(member.createdAt).toLocaleDateString()}
                  </td>

                  {/* Actions */}
                  {canManageMembers && (
                    <td className="px-4 py-3 text-right">
                      {canManage && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setMemberToRemove(member)}
                          className="text-destructive hover:text-destructive hover:bg-destructive/10"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

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
    </>
  )
}
