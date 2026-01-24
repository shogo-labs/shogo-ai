/**
 * InviteMemberModal Component
 * Task: task-invite-member-modal
 * Feature: member-management-invitation
 *
 * Modal dialog for inviting new members to a workspace.
 * Uses MCP domain (studioCore) for invitation creation.
 */

import { useState } from "react"
import { Loader2, Mail } from "lucide-react"

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useDomains } from "@/contexts/DomainProvider"
import { useSession } from "@/contexts/SessionProvider"

/**
 * Props for InviteMemberModal component
 */
export interface InviteMemberModalProps {
  /** Whether the modal is open */
  open: boolean
  /** Callback when modal open state changes */
  onOpenChange: (open: boolean) => void
  /** Workspace ID to invite member to */
  workspaceId: string
  /** Callback after successful invitation */
  onSuccess?: () => void
}

/**
 * Available roles for invitation (excludes owner)
 */
const AVAILABLE_ROLES = [
  { value: "admin", label: "Admin" },
  { value: "member", label: "Member" },
  { value: "viewer", label: "Viewer" },
]

/**
 * Simple email validation regex
 */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * InviteMemberModal Component
 *
 * Renders a dialog for inviting new members to a workspace.
 * Uses MCP domain for invitation creation.
 */
export function InviteMemberModal({
  open,
  onOpenChange,
  workspaceId,
  onSuccess,
}: InviteMemberModalProps) {
  // Get studioCore domain
  const { studioCore } = useDomains()

  // Get current user for invitedBy field
  const { data: session } = useSession()
  const currentUserId = session?.user?.id

  // Form state
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<string>("member")

  // UI state
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [emailError, setEmailError] = useState<string | null>(null)

  // Form validation
  const isValidEmail = EMAIL_REGEX.test(email)
  const isValid = isValidEmail && role

  /**
   * Validate email on blur
   */
  const handleEmailBlur = () => {
    if (email && !isValidEmail) {
      setEmailError("Please enter a valid email address")
    } else {
      setEmailError(null)
    }
  }

  /**
   * Handle form submission
   */
  const handleSubmit = async () => {
    if (!isValid || isSubmitting || !studioCore || !currentUserId) return

    // Validate email format
    if (!isValidEmail) {
      setEmailError("Please enter a valid email address")
      return
    }

    setIsSubmitting(true)
    setError(null)

    try {
      // Check for existing pending invitation
      await studioCore.invitationCollection.query().toArray()
      await studioCore.workspaceCollection.query().toArray()

      const existingInvitations = studioCore.invitationCollection.findByEmail(email)
      const pendingForWorkspace = existingInvitations.find(
        (i: any) => i.status === "pending" && i.workspace?.id === workspaceId
      )

      if (pendingForWorkspace) {
        throw new Error("Invitation already pending for this email")
      }

      // Create invitation with 7-day expiry
      const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000

      await studioCore.invitationCollection.insertOne({
        id: crypto.randomUUID(),
        email,
        role,
        workspace: workspaceId,  // Reference field, not workspaceId
        status: "pending",
        invitedBy: currentUserId,
        expiresAt,
        createdAt: Date.now(),
      })

      // Reset form
      setEmail("")
      setRole("member")

      // Close modal and notify success
      onOpenChange(false)
      onSuccess?.()
    } catch (err) {
      console.error("[InviteMemberModal] Failed to send invitation:", err)
      setError(err instanceof Error ? err.message : "Failed to send invitation")
    } finally {
      setIsSubmitting(false)
    }
  }

  /**
   * Handle modal close - reset form state
   */
  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      // Reset form when closing
      setEmail("")
      setRole("member")
      setError(null)
      setEmailError(null)
    }
    onOpenChange(newOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Invite Member</DialogTitle>
          <DialogDescription>
            Send an invitation to a new team member. They will receive an email
            to join your workspace.
          </DialogDescription>
        </DialogHeader>

        {/* Error Message */}
        {error && (
          <div className="p-3 bg-destructive/10 border border-destructive/30 rounded-md text-destructive text-sm">
            {error}
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault()
            handleSubmit()
          }}
        >
          <div className="grid gap-4 py-4">
            {/* Email Field */}
            <div className="grid gap-2">
              <Label htmlFor="invite-email">
                Email <span className="text-destructive">*</span>
              </Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="invite-email"
                  type="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value)
                    setEmailError(null)
                  }}
                  onBlur={handleEmailBlur}
                  placeholder="colleague@example.com"
                  disabled={isSubmitting}
                  className="pl-10"
                  autoFocus
                />
              </div>
              {emailError && (
                <p className="text-xs text-destructive">{emailError}</p>
              )}
            </div>

            {/* Role Field */}
            <div className="grid gap-2">
              <Label htmlFor="invite-role">
                Role <span className="text-destructive">*</span>
              </Label>
              <Select
                value={role}
                onValueChange={setRole}
                disabled={isSubmitting}
              >
                <SelectTrigger id="invite-role">
                  <SelectValue placeholder="Select a role" />
                </SelectTrigger>
                <SelectContent>
                  {AVAILABLE_ROLES.map((r) => (
                    <SelectItem key={r.value} value={r.value}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {role === "admin" && "Admins can manage members and settings"}
                {role === "member" && "Members can create and edit content"}
                {role === "viewer" && "Viewers have read-only access"}
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!isValid || isSubmitting}>
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Sending...
                </>
              ) : (
                "Send Invitation"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
