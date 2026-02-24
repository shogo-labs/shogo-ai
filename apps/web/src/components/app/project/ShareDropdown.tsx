/**
 * ShareDropdown - Lovable-style project sharing panel
 *
 * Features:
 * - Add people by email (project-level invitation)
 * - List project collaborators with role management
 * - Show workspace-level access
 * - Remove collaborators
 */

import { useState, useEffect, useCallback } from "react"
import {
  Users,
  ChevronDown,
  X,
  Loader2,
  UserPlus,
  Check,
  Link2,
  Copy,
  CheckCheck,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useSession } from "@/contexts/SessionProvider"

interface ProjectMember {
  id: string
  userId: string
  role: string
  userName?: string
  userEmail?: string
  isWorkspaceLevel?: boolean
}

export interface ShareDropdownProps {
  projectId: string
  workspaceId?: string
  workspaceName?: string
  userInitial?: string
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

export function ShareDropdown({
  projectId,
  workspaceId,
  workspaceName = "Workspace",
  userInitial = "U",
}: ShareDropdownProps) {
  const { data: session } = useSession()
  const currentUserId = session?.user?.id
  const currentUserEmail = session?.user?.email

  const [open, setOpen] = useState(false)
  const [members, setMembers] = useState<ProjectMember[]>([])
  const [isLoading, setIsLoading] = useState(false)

  // Invite state
  const [inviteEmail, setInviteEmail] = useState("")
  const [inviteRole, setInviteRole] = useState("member")
  const [isInviting, setIsInviting] = useState(false)
  const [inviteSuccess, setInviteSuccess] = useState(false)
  const [inviteError, setInviteError] = useState<string | null>(null)

  // Invite link state
  const [inviteLink, setInviteLink] = useState<{ id: string; token: string; enabled: boolean } | null>(null)
  const [linkCopied, setLinkCopied] = useState(false)

  const loadMembers = useCallback(async () => {
    if (!open) return
    setIsLoading(true)
    try {
      // Load workspace members (they all have access to the project)
      const wsRes = await fetch(`/api/members?workspaceId=${workspaceId}`, { credentials: 'include' })
      const wsData = await wsRes.json()
      const wsMembers = (wsData.items || []).filter((m: any) => !m.projectId).map((m: any) => ({
        id: m.id,
        userId: m.userId,
        role: m.role,
        userName: m.user?.name,
        userEmail: m.user?.email,
        isWorkspaceLevel: true,
      }))

      // Load project-specific members
      const projRes = await fetch(`/api/members?projectId=${projectId}`, { credentials: 'include' })
      const projData = await projRes.json()
      const projMembers = (projData.items || []).map((m: any) => ({
        id: m.id,
        userId: m.userId,
        role: m.role,
        userName: m.user?.name,
        userEmail: m.user?.email,
        isWorkspaceLevel: false,
      }))

      // Deduplicate: project members override workspace members
      const projUserIds = new Set(projMembers.map((m: any) => m.userId))
      const combined = [
        ...projMembers,
        ...wsMembers.filter((m: any) => !projUserIds.has(m.userId)),
      ]
      setMembers(combined)

      // Load invite link
      const linkRes = await fetch(`/api/invite-links?projectId=${projectId}`, { credentials: 'include' })
      const linkData = await linkRes.json()
      const activeLink = (linkData.items || []).find((l: any) => l.enabled)
      setInviteLink(activeLink || null)
    } catch {
      // ignore
    } finally {
      setIsLoading(false)
    }
  }, [open, projectId, workspaceId])

  useEffect(() => {
    if (open) loadMembers()
  }, [open, loadMembers])

  const handleInvite = async () => {
    if (!isValidEmail(inviteEmail) || isInviting) return
    if (inviteEmail.toLowerCase() === currentUserEmail?.toLowerCase()) {
      setInviteError("You can't invite yourself")
      return
    }

    setIsInviting(true)
    setInviteError(null)
    setInviteSuccess(false)

    try {
      // Create a project-level invitation
      const res = await fetch('/api/invitations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          email: inviteEmail,
          role: inviteRole,
          projectId,
          status: 'pending',
          expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) {
        throw new Error(data.error?.message || 'Failed to send invitation')
      }
      setInviteSuccess(true)
      setInviteEmail("")
      setTimeout(() => setInviteSuccess(false), 2000)
    } catch (err: any) {
      setInviteError(err.message || 'Failed to send invitation')
    } finally {
      setIsInviting(false)
    }
  }

  const handleChangeRole = async (memberId: string, newRole: string) => {
    try {
      await fetch(`/api/members/${memberId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ role: newRole }),
      })
      setMembers(prev => prev.map(m => m.id === memberId ? { ...m, role: newRole } : m))
    } catch {
      // ignore
    }
  }

  const handleRemove = async (memberId: string) => {
    try {
      await fetch(`/api/members/${memberId}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      setMembers(prev => prev.filter(m => m.id !== memberId))
    } catch {
      // ignore
    }
  }

  const currentUserIsAdmin = members.some(
    m => m.userId === currentUserId && (m.role === 'owner' || m.role === 'admin')
  )

  const handleCreateLink = async () => {
    try {
      const res = await fetch('/api/invite-links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ projectId, role: 'member' }),
      })
      const data = await res.json()
      if (data.ok) {
        setInviteLink(data.data)
      } else {
        setInviteError(data.error || 'Failed to create invite link')
      }
    } catch (err: any) {
      setInviteError(err.message || 'Failed to create invite link')
    }
  }

  const handleCopyLink = () => {
    if (!inviteLink) return
    const url = `${window.location.origin}/invite/${inviteLink.token}`
    navigator.clipboard.writeText(url)
    setLinkCopied(true)
    setTimeout(() => setLinkCopied(false), 2000)
  }

  const handleToggleLink = async () => {
    if (!inviteLink) return
    try {
      const res = await fetch(`/api/invite-links/${inviteLink.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ enabled: !inviteLink.enabled }),
      })
      const data = await res.json()
      if (data.ok) setInviteLink(data.data)
    } catch { /* ignore */ }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 gap-1.5 px-2 hover:bg-accent/50">
          <div className="h-5 w-5 rounded-full bg-primary/80 flex items-center justify-center">
            <span className="text-[10px] font-medium text-primary-foreground">{userInitial}</span>
          </div>
          <span className="text-sm">Share</span>
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-80 p-0">
        <div className="p-4 space-y-4">
          <h2 className="font-semibold text-sm">Share project</h2>

          {/* Add people */}
          <div className="flex gap-2">
            <Input
              placeholder="Add people by email"
              value={inviteEmail}
              onChange={(e) => { setInviteEmail(e.target.value); setInviteError(null) }}
              onKeyDown={(e) => e.key === 'Enter' && handleInvite()}
              className="h-8 text-sm flex-1"
            />
            <Select value={inviteRole} onValueChange={setInviteRole}>
              <SelectTrigger className="h-8 w-24 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="viewer">Viewer</SelectItem>
                <SelectItem value="member">Editor</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {inviteEmail && isValidEmail(inviteEmail) && (
            <Button
              size="sm"
              className="w-full h-8 text-xs"
              onClick={handleInvite}
              disabled={isInviting}
            >
              {isInviting ? (
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
              ) : inviteSuccess ? (
                <Check className="h-3 w-3 mr-1" />
              ) : (
                <UserPlus className="h-3 w-3 mr-1" />
              )}
              {inviteSuccess ? "Invitation sent" : `Invite as ${inviteRole}`}
            </Button>
          )}

          {inviteError && (
            <p className="text-xs text-destructive">{inviteError}</p>
          )}

          {/* Project access */}
          <div className="space-y-2">
            <h3 className="text-xs font-medium text-muted-foreground">Project access</h3>

            {/* Workspace row */}
            <div className="flex items-center justify-between py-1">
              <div className="flex items-center gap-2">
                <div className="h-6 w-6 rounded bg-primary/10 flex items-center justify-center">
                  <span className="text-[10px] font-medium">{workspaceName?.charAt(0)}</span>
                </div>
                <div>
                  <span className="text-sm">{workspaceName}</span>
                  <p className="text-xs text-muted-foreground">All members</p>
                </div>
              </div>
              <span className="text-xs text-muted-foreground">Can edit</span>
            </div>

            {/* Member list */}
            {isLoading ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {members.map((member) => {
                  const isCurrentUser = member.userId === currentUserId
                  const displayName = isCurrentUser
                    ? `${member.userName || member.userEmail || 'You'} (you)`
                    : (member.userName || member.userEmail || `User ${member.userId.slice(0, 8)}`)
                  const canManage = currentUserIsAdmin && !isCurrentUser && !member.isWorkspaceLevel

                  return (
                    <div key={member.id} className="flex items-center justify-between py-1 group">
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <div className="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                          <span className="text-[10px] font-medium">
                            {(member.userName || member.userEmail || 'U').charAt(0).toUpperCase()}
                          </span>
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm truncate">{displayName}</p>
                          {member.userEmail && member.userName && !isCurrentUser && (
                            <p className="text-xs text-muted-foreground truncate">{member.userEmail}</p>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        {canManage ? (
                          <>
                            <Select value={member.role} onValueChange={(v) => handleChangeRole(member.id, v)}>
                              <SelectTrigger className="h-6 text-xs w-20 border-0 bg-transparent">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="viewer">Viewer</SelectItem>
                                <SelectItem value="member">Editor</SelectItem>
                                <SelectItem value="admin">Admin</SelectItem>
                              </SelectContent>
                            </Select>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-5 w-5 opacity-0 group-hover:opacity-100"
                              onClick={() => handleRemove(member.id)}
                            >
                              <X className="h-3 w-3" />
                            </Button>
                          </>
                        ) : (
                          <span className="text-xs text-muted-foreground capitalize px-1">
                            {member.role === 'member' ? 'Editor' : member.role}
                          </span>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Invite Link */}
          {currentUserIsAdmin && (
            <div className="space-y-2 pt-2 border-t">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Link2 className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm">Invite link</span>
                </div>
                {inviteLink && (
                  <Button variant="ghost" size="sm" className="h-6 text-xs px-2" onClick={handleToggleLink}>
                    {inviteLink.enabled ? "Enabled" : "Disabled"}
                  </Button>
                )}
              </div>
              {inviteLink && inviteLink.enabled ? (
                <Button variant="outline" className="w-full h-8 text-xs" onClick={handleCopyLink}>
                  {linkCopied ? <CheckCheck className="h-3 w-3 mr-1" /> : <Copy className="h-3 w-3 mr-1" />}
                  {linkCopied ? "Copied!" : "Copy invite link"}
                </Button>
              ) : (
                <Button variant="outline" className="w-full h-8 text-xs" onClick={handleCreateLink}>
                  Create invite link
                </Button>
              )}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
