/**
 * SettingsPage - Full-page settings with Lovable-style sidebar navigation
 *
 * Organized into sections:
 * - Project: Project settings, Domains, Knowledge
 * - Workspace: Workspace name, People, Plans & credits, Cloud & AI balance, Privacy & security
 * - Account: User profile, Labs
 * - Connectors: Connectors, GitHub
 */

import { useState, useEffect, useCallback } from "react"
import { observer } from "mobx-react-lite"
import { useNavigate, useSearchParams, useParams } from "react-router-dom"
import { format } from "date-fns"
import {
  ArrowLeft,
  Settings,
  Globe,
  BookOpen,
  Building2,
  Users,
  CreditCard,
  BarChart3,
  Shield,
  User,
  FlaskConical,
  Plug,
  Github,
  ExternalLink,
  Search,
  UserPlus,
  Download,
  MoreHorizontal,
  Loader2,
  Trash2,
  ChevronDown,
  Check,
  Eye,
  EyeOff,
  Copy,
  Calendar,
  MessageSquare,
  Sparkles,
  MapPin,
  Link as LinkIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
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
import { UsageTable, type UsageSummaryData, type UsageLogData } from "@/components/admin/analytics/UsageTable"
import { useWorkspaceData } from "@/components/app/workspace"
import { useDomains, useSDKDomain } from "@/contexts/DomainProvider"
import type { IDomainStore } from "@/generated/domain"
import { useDomainActions } from "@/generated/domain-actions"
import { useSession } from "@/contexts/SessionProvider"
import { InviteMemberModal, PendingInvitationsView, MyInvitationsView } from "@/components/app/workspace/members"
import { PlanSelector } from "@/components/app/billing/PlanSelector"
import { useBillingData } from "@/hooks/useBillingData"

// =============================================================================
// Workspace-scoped usage hooks (reuse the same UsageTable component as admin)
// =============================================================================

interface ApiResponse<T> { ok: boolean; data: T }

function useWorkspaceUsageSummary(basePath: string, period: string) {
  const [data, setData] = useState<UsageSummaryData | null>(null)
  const [loading, setLoading] = useState(true)
  const url = basePath ? `${basePath}/analytics/usage-summary?period=${period}` : ''

  useEffect(() => {
    if (!url) { setLoading(false); return }
    setLoading(true)
    fetch(url, { credentials: 'include' })
      .then((r) => r.json())
      .then((res: ApiResponse<UsageSummaryData>) => { setData(res.data); setLoading(false) })
      .catch(() => setLoading(false))
  }, [url])

  return { data, loading }
}

function useWorkspaceUsageLog(basePath: string, period: string, page: number) {
  const [data, setData] = useState<UsageLogData | null>(null)
  const [loading, setLoading] = useState(true)
  const url = basePath ? `${basePath}/analytics/usage-log?period=${period}&page=${page}&limit=50` : ''

  useEffect(() => {
    if (!url) { setLoading(false); return }
    setLoading(true)
    fetch(url, { credentials: 'include' })
      .then((r) => r.json())
      .then((res: ApiResponse<UsageLogData>) => { setData(res.data); setLoading(false) })
      .catch(() => setLoading(false))
  }, [url])

  return { data, loading }
}

// Tab types
type TabId =
  | "project"
  | "domains"
  | "knowledge"
  | "workspace"
  | "people"
  | "billing"
  | "usage"
  | "privacy"
  | "account"
  | "labs"
  | "connectors"
  | "github"

interface NavSection {
  title: string
  items: {
    id: TabId
    label: string
    icon: React.ElementType
    badge?: string
  }[]
}

// Sidebar nav item component
function NavItem({
  id,
  label,
  icon: Icon,
  active,
  onClick,
  badge,
}: {
  id: TabId
  label: string
  icon: React.ElementType
  active: boolean
  onClick: () => void
  badge?: string
}) {
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

// ============================================================================
// PROJECT SETTINGS TAB
// ============================================================================
function ProjectSettingsTab() {
  const { currentProject, currentWorkspace } = useWorkspaceData()
  const actions = useDomainActions()
  const { data: session } = useSession()

  const [name, setName] = useState(currentProject?.name || "")
  const [isSaving, setIsSaving] = useState(false)
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)

  useEffect(() => {
    setName(currentProject?.name || "")
  }, [currentProject?.name])

  const handleSave = async () => {
    if (!currentProject?.id) return
    setIsSaving(true)
    try {
      await actions.updateProject(currentProject.id, {
        name: name.trim(),
      })
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">Project settings</h3>
        <p className="text-sm text-muted-foreground">
          Manage your project details, visibility, and preferences.
        </p>
      </div>

      {/* Overview card */}
      <div className="p-4 bg-card rounded-lg border border-border space-y-4">
        <h4 className="text-sm font-medium text-muted-foreground">Overview</h4>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <div className="text-muted-foreground">Display name</div>
            <div className="font-medium flex items-center gap-2">
              {currentProject?.name || "Untitled Project"}
              <Button variant="ghost" size="icon" className="h-6 w-6">
                <Copy className="h-3 w-3" />
              </Button>
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">URL subdomain</div>
            <div className="font-medium">No URL subdomain</div>
          </div>
          <div>
            <div className="text-muted-foreground">Owner</div>
            <div className="font-medium text-primary">{session?.user?.name || "Unknown"}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Created at</div>
            <div className="font-medium">
              {currentProject?.createdAt
                ? format(new Date(currentProject.createdAt), "yyyy-MM-dd HH:mm:ss")
                : "Unknown"
              }
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Messages count</div>
            <div className="font-medium">"0"</div>
          </div>
          <div>
            <div className="text-muted-foreground">AI edits count</div>
            <div className="font-medium">"0"</div>
          </div>
          <div>
            <div className="text-muted-foreground">Credits used</div>
            <div className="font-medium">"0.00"</div>
          </div>
        </div>
      </div>

      {/* Settings section */}
      <div className="space-y-4">
        {/* Project visibility */}
        <div className="flex items-start justify-between p-4 bg-card rounded-lg border border-border">
          <div>
            <div className="font-medium">Project visibility</div>
            <div className="text-sm text-muted-foreground">
              Keep your project hidden and prevent others from remixing it.
            </div>
          </div>
          <Select defaultValue="workspace">
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="public">Public</SelectItem>
              <SelectItem value="workspace">Workspace</SelectItem>
              <SelectItem value="private">Private</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Project category */}
        <div className="flex items-start justify-between p-4 bg-card rounded-lg border border-border">
          <div>
            <div className="font-medium">Project category</div>
            <div className="text-sm text-muted-foreground">
              Categorize your project to help others find it.
            </div>
          </div>
          <Select>
            <SelectTrigger className="w-36">
              <SelectValue placeholder="Select category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="app">Application</SelectItem>
              <SelectItem value="website">Website</SelectItem>
              <SelectItem value="tool">Tool</SelectItem>
              <SelectItem value="game">Game</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Rename project */}
        <div className="flex items-start justify-between p-4 bg-card rounded-lg border border-border">
          <div>
            <div className="font-medium">Rename project</div>
            <div className="text-sm text-muted-foreground">
              Update your project's title.
            </div>
          </div>
          <Button variant="outline" size="sm">Rename</Button>
        </div>

        {/* Remix project */}
        <div className="flex items-start justify-between p-4 bg-card rounded-lg border border-border">
          <div>
            <div className="font-medium">Remix project</div>
            <div className="text-sm text-muted-foreground">
              Duplicate this app in a new project.
            </div>
          </div>
          <Button variant="outline" size="sm">Remix</Button>
        </div>

        {/* Transfer */}
        <div className="flex items-start justify-between p-4 bg-card rounded-lg border border-border">
          <div>
            <div className="font-medium">Transfer</div>
            <div className="text-sm text-muted-foreground">
              Move this project to a different workspace.
            </div>
          </div>
          <Button variant="outline" size="sm" disabled>Transfer</Button>
        </div>
      </div>

      {/* Danger zone */}
      <div className="space-y-4">
        <div className="flex items-start justify-between p-4 rounded-lg border border-destructive/20 bg-destructive/5">
          <div>
            <div className="font-medium text-destructive">Delete project</div>
            <div className="text-sm text-muted-foreground">
              Permanently delete this project.
            </div>
          </div>
          <Button variant="destructive" size="sm" onClick={() => setIsDeleteDialogOpen(true)}>
            Delete
          </Button>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// DOMAINS TAB
// ============================================================================
function DomainsTab() {
  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-lg font-semibold">Domains</h3>
          <p className="text-sm text-muted-foreground">
            Publish your project to custom domains.
          </p>
        </div>
        <Button variant="outline" size="sm" asChild>
          <a href="#" className="flex items-center gap-2">
            How domains work
            <ExternalLink className="h-3 w-3" />
          </a>
        </Button>
      </div>

      {/* Overview */}
      <div className="p-4 bg-card rounded-lg border border-border">
        <h4 className="text-sm font-medium mb-3">Overview</h4>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Globe className="h-5 w-5 text-muted-foreground" />
            <span>No URL subdomain</span>
            <Badge variant="secondary">Unpublished</Badge>
          </div>
          <Button variant="ghost" size="icon">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Domain options */}
      <div className="grid grid-cols-2 gap-4">
        <div className="p-4 bg-card rounded-lg border border-border">
          <div className="flex items-start gap-4">
            <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-orange-400 to-pink-500 flex items-center justify-center">
              <LinkIcon className="h-5 w-5 text-white" />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium">Add existing domain</span>
                <Badge className="bg-purple-500/10 text-purple-500 border-purple-500/20">Pro</Badge>
              </div>
              <p className="text-sm text-muted-foreground">Upgrade your plan</p>
            </div>
            <Button variant="outline" size="sm">Connect domain</Button>
          </div>
        </div>

        <div className="p-4 bg-card rounded-lg border border-border">
          <div className="flex items-start gap-4">
            <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-yellow-400 to-orange-500 flex items-center justify-center">
              <Globe className="h-5 w-5 text-white" />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium">Purchase new domain</span>
                <Badge className="bg-purple-500/10 text-purple-500 border-purple-500/20">Pro</Badge>
              </div>
              <p className="text-sm text-muted-foreground">Upgrade your plan</p>
            </div>
            <Button variant="outline" size="sm">Buy new domain</Button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// KNOWLEDGE TAB
// ============================================================================
function KnowledgeTab() {
  const [instructions, setInstructions] = useState("")

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-lg font-semibold">Knowledge</h3>
          <p className="text-sm text-muted-foreground">
            Add custom knowledge to your project.
          </p>
        </div>
        <Button variant="outline" size="sm" asChild>
          <a 
            href="https://docs-staging.shogo.ai" 
            target="_blank" 
            rel="noopener noreferrer"
            className="flex items-center gap-2"
          >
            <BookOpen className="h-3 w-3" />
            Docs
          </a>
        </Button>
      </div>

      <div className="p-4 bg-card rounded-lg border border-border space-y-4">
        <div>
          <h4 className="font-medium">Instructions & guidelines</h4>
          <p className="text-sm text-muted-foreground">
            Provide guidelines and context to improve your project's edits. Use this space to:
          </p>
          <ul className="list-disc list-inside text-sm text-muted-foreground mt-2 space-y-1">
            <li>Set project-specific rules or best practices.</li>
            <li>Set coding style preferences (e.g. indentation, naming conventions).</li>
            <li>Include external documentation or style guides.</li>
          </ul>
        </div>

        <Textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="Enter your instructions here..."
          className="min-h-[200px]"
        />

        <div className="flex justify-end">
          <Button variant="outline" size="sm" asChild>
            <a href="#" className="flex items-center gap-2">
              Get inspiration
              <ExternalLink className="h-3 w-3" />
            </a>
          </Button>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// WORKSPACE SETTINGS TAB
// ============================================================================
function WorkspaceSettingsTab({ onClose }: { onClose?: () => void }) {
  const navigate = useNavigate()
  const { currentWorkspace, workspaces } = useWorkspaceData()
  const store = useSDKDomain() as IDomainStore
  const actions = useDomainActions()
  const { data: session } = useSession()
  const [name, setName] = useState(currentWorkspace?.name || "")
  const [isSaving, setIsSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">("idle")

  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [deleteConfirmText, setDeleteConfirmText] = useState("")

  const originalName = currentWorkspace?.name || ""
  const hasChanges = name !== originalName
  const isValid = name.trim().length > 0 && name.length <= 50

  const currentUserId = session?.user?.id
  const members = currentWorkspace?.id
    ? store?.memberCollection?.all.filter((m: any) => m.workspaceId === currentWorkspace.id && !m.projectId) || []
    : []
  const currentUserMember = members.find((m: any) => m.userId === currentUserId)
  const isOwner = currentUserMember?.role === "owner"

  const isPersonalWorkspace =
    currentWorkspace?.slug?.includes("personal") ||
    currentWorkspace?.name?.toLowerCase().includes("personal")

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
      await actions.updateWorkspace(currentWorkspace.id, {
        name: name.trim(),
      })

      setSaveStatus("saved")
      setTimeout(() => setSaveStatus("idle"), 2000)
    } catch (error) {
      console.error("Failed to save workspace name:", error)
      setSaveStatus("error")
    } finally {
      setIsSaving(false)
    }
  }

  const handleDeleteWorkspace = async () => {
    if (!currentWorkspace?.id || !isDeleteConfirmed) return

    setIsDeleting(true)

    try {
      await actions.deleteWorkspaceWithMembers(currentWorkspace.id)

      setIsDeleteDialogOpen(false)
      onClose?.()

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
        <div className="flex items-start justify-between p-4 bg-card rounded-lg border border-border">
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
        <div className="p-4 bg-card rounded-lg border border-border space-y-3">
          <div>
            <Label htmlFor="workspace-name">Workspace name</Label>
            <p className="text-xs text-muted-foreground">
              Your full workspace name, as visible to others.
            </p>
          </div>
          <div className="flex gap-2 items-start">
            <div className="flex-1 space-y-1">
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
      </div>

      <Separator />

      {/* Danger zone */}
      <div className="space-y-4">
        <div>
          <h4 className="text-sm font-medium text-destructive">Danger zone</h4>
          <p className="text-xs text-muted-foreground">
            Irreversible and destructive actions.
          </p>
        </div>

        <div className="flex items-start justify-between p-4 rounded-lg border border-destructive/20 bg-destructive/5">
          <div>
            <Label>Leave workspace</Label>
            <p className="text-xs text-muted-foreground">
              Remove yourself from this workspace.
            </p>
          </div>
          <Button variant="outline" size="sm" disabled className="border-destructive/50 text-destructive">
            Leave
          </Button>
        </div>

        {isOwner && (
          <div className="flex items-start justify-between p-4 rounded-lg border border-destructive/20 bg-destructive/5">
            <div>
              <Label className="text-destructive">Delete workspace</Label>
              <p className="text-xs text-muted-foreground">
                {canDelete
                  ? "Permanently delete this workspace and all its data."
                  : isPersonalWorkspace
                  ? "Your personal workspace cannot be deleted."
                  : "You cannot delete your only workspace."}
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

      {/* Delete Workspace Confirmation */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-destructive">Delete workspace</AlertDialogTitle>
            <AlertDialogDescription className="space-y-3">
              <p>
                This action <strong>cannot be undone</strong>. This will permanently delete the
                workspace <strong>{currentWorkspace?.name}</strong>.
              </p>
              <p className="pt-2">
                Please type <strong>{deleteConfirmRequired}</strong> to confirm.
              </p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            value={deleteConfirmText}
            onChange={(e) => setDeleteConfirmText(e.target.value)}
            placeholder={`Type "${deleteConfirmRequired}" to confirm`}
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
                "Delete workspace"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ============================================================================
// PEOPLE TAB
// ============================================================================
const RoleLevels: Record<string, number> = {
  owner: 40,
  admin: 30,
  member: 20,
  viewer: 10,
}

interface Member {
  id: string
  userId: string
  role: "owner" | "admin" | "member" | "viewer"
  createdAt: number
  updatedAt?: number
}

function PeopleTab() {
  const { currentWorkspace } = useWorkspaceData()
  const store = useSDKDomain() as IDomainStore
  const actions = useDomainActions()
  const { data: session } = useSession()
  const currentUserId = session?.user?.id || ""
  const currentUserName = session?.user?.name || "User"
  const currentUserEmail = session?.user?.email || ""

  const [members, setMembers] = useState<Member[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState("")
  const [roleFilter, setRoleFilter] = useState<string>("all")
  const [activeSubTab, setActiveSubTab] = useState("all")
  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false)
  const [memberToRemove, setMemberToRemove] = useState<Member | null>(null)
  const [isRemoving, setIsRemoving] = useState(false)
  const [updatingMemberId, setUpdatingMemberId] = useState<string | null>(null)

  const currentUserMember = members.find(m => m.userId === currentUserId)
  const currentUserRole = currentUserMember?.role || "viewer"
  const currentUserLevel = RoleLevels[currentUserRole] ?? 0
  const canManageMembers = currentUserLevel >= RoleLevels.admin

  const loadMembers = useCallback(async () => {
    if (!store?.memberCollection || !currentWorkspace?.id) {
      setIsLoading(false)
      return
    }

    setIsLoading(true)
    try {
      await store.memberCollection.loadAll({ workspaceId: currentWorkspace.id })
      const workspaceMembers = store.memberCollection.all.filter(
        (m: any) => m.workspaceId === currentWorkspace.id && !m.projectId
      )
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

  const filteredMembers = members.filter(member => {
    if (roleFilter !== "all" && member.role !== roleFilter) return false
    if (searchQuery) {
      const query = searchQuery.toLowerCase()
      return member.userId.toLowerCase().includes(query)
    }
    return true
  })

  const canManageMember = (member: Member): boolean => {
    if (member.userId === currentUserId) return false
    const memberLevel = RoleLevels[member.role] ?? 0
    return currentUserLevel > memberLevel
  }

  const getAvailableRoles = (member: Member): string[] => {
    if (member.role === "owner" && currentUserRole !== "owner") return []
    return Object.keys(RoleLevels).filter((role) => {
      if (role === "owner" && currentUserRole !== "owner") return false
      return RoleLevels[role] <= currentUserLevel
    })
  }

  const handleRoleChange = async (memberId: string, newRole: string) => {
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

  const handleRemoveMember = async () => {
    if (!memberToRemove) return
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

  const handleExport = () => {
    const headers = ["Name", "Email", "Role", "Joined date", "Jan usage", "Total usage", "Credit limit"]
    const rows = filteredMembers.map(member => {
      const isCurrentUser = member.userId === currentUserId
      const name = isCurrentUser ? `${currentUserName} (you)` : `User ${member.userId.slice(0, 8)}`
      const email = isCurrentUser ? currentUserEmail : `${member.userId.slice(0, 16)}...`
      const role = member.role.charAt(0).toUpperCase() + member.role.slice(1)
      const joinedDate = format(new Date(member.createdAt), "MMM d, yyyy")
      
      return [name, email, role, joinedDate, "0 credits", "0 credits", "-"]
    })

    const csvContent = [
      headers.join(","),
      ...rows.map(row => row.map(cell => `"${cell}"`).join(","))
    ].join("\n")

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = `workspace-members-${format(new Date(), "yyyy-MM-dd")}.csv`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-lg font-semibold">People</h3>
          <p className="text-sm text-muted-foreground">
            Inviting people to <strong>{currentWorkspace?.name}</strong> gives access to workspace shared projects and credits.
            You have {members.length} {members.length === 1 ? "builder" : "builders"} in this workspace.
          </p>
        </div>
        <Button variant="outline" size="sm" asChild>
          <a 
            href="https://docs-staging.shogo.ai" 
            target="_blank" 
            rel="noopener noreferrer"
            className="flex items-center gap-2"
          >
            <BookOpen className="h-3 w-3" />
            Docs
          </a>
        </Button>
      </div>

      <Tabs value={activeSubTab} onValueChange={setActiveSubTab}>
        <div className="flex items-center justify-between gap-4">
          <TabsList className="h-8">
            <TabsTrigger value="all" className="text-xs px-3 h-7">All</TabsTrigger>
            <TabsTrigger value="invitations" className="text-xs px-3 h-7">Invitations</TabsTrigger>
            <TabsTrigger value="collaborators" className="text-xs px-3 h-7">Collaborators</TabsTrigger>
          </TabsList>

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

            <Button variant="outline" size="sm" className="h-8 gap-1" onClick={handleExport}>
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
            <div className="rounded-md border border-border overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/50">
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">Name</th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">Role</th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">Joined date</th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">Jan usage</th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">Total usage</th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">Credit limit</th>
                    <th className="px-3 py-2 w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredMembers.map((member) => {
                    const isCurrentUser = member.userId === currentUserId
                    const canManage = canManageMembers && canManageMember(member)
                    const availableRoles = getAvailableRoles(member)

                    return (
                      <tr key={member.id} className={cn("border-b border-border last:border-b-0", isCurrentUser && "bg-primary/5")}>
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
                        <td className="px-3 py-2 text-muted-foreground">0 credits</td>
                        <td className="px-3 py-2 text-muted-foreground">0 credits</td>
                        <td className="px-3 py-2 text-muted-foreground">-</td>
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
          {currentWorkspace?.id ? (
            <PendingInvitationsView
              orgId={currentWorkspace.id}
              onInvitationsChange={loadMembers}
            />
          ) : (
            <div className="text-center py-8 text-sm text-muted-foreground">
              <UserPlus className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p>No workspace selected</p>
            </div>
          )}
        </TabsContent>

        <TabsContent value="collaborators" className="mt-3">
          <div className="text-center py-8 text-sm text-muted-foreground">
            <Users className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p>No collaborators</p>
          </div>
        </TabsContent>
      </Tabs>

      <InviteMemberModal
        open={isInviteModalOpen}
        onOpenChange={setIsInviteModalOpen}
        workspaceId={currentWorkspace?.id || ""}
        onSuccess={loadMembers}
      />

      <AlertDialog open={!!memberToRemove} onOpenChange={(open) => !open && setMemberToRemove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Member</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove this member from the workspace?
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

// ============================================================================
// BILLING TAB
// ============================================================================
function BillingTab() {
  const { currentWorkspace } = useWorkspaceData()
  
  // Use billing data hook to get subscription and credit ledger
  const {
    subscription,
    effectiveBalance,
    hasActiveSubscription,
    isLoading: isBillingLoading,
  } = useBillingData(currentWorkspace?.id)

  const currentPlanId = subscription?.planId || undefined

  const planType = subscription
    ? subscription.planId.charAt(0).toUpperCase() + subscription.planId.slice(1)
    : "Free"

  const creditsRemaining = effectiveBalance?.total ?? (hasActiveSubscription ? 105 : 5)
  const creditsTotal = hasActiveSubscription ? 105 : 5

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-lg font-semibold">Plans & credits</h3>
          <p className="text-sm text-muted-foreground">
            Manage your subscription plan and credit balance.
          </p>
        </div>
        <Button variant="outline" size="sm" asChild>
          <a 
            href="https://docs-staging.shogo.ai" 
            target="_blank" 
            rel="noopener noreferrer"
            className="flex items-center gap-2"
          >
            <BookOpen className="h-3 w-3" />
            Docs
          </a>
        </Button>
      </div>

      {/* Current plan and credits */}
      <div className="grid grid-cols-2 gap-4">
        <div className="p-4 bg-card rounded-lg border border-border">
          <div className="flex items-center gap-4">
            <div className="h-12 w-12 rounded-lg bg-gradient-to-br from-pink-500 to-orange-400 flex items-center justify-center">
              <Sparkles className="h-6 w-6 text-white" />
            </div>
            <div>
              <div className="font-medium">You're on {planType} Plan</div>
              <div className="text-sm text-muted-foreground">
                {subscription ? "Manage your subscription" : "Upgrade anytime"}
              </div>
            </div>
          </div>
        </div>

        <div className="p-4 bg-card rounded-lg border border-border space-y-3">
          <div className="flex justify-between">
            <span className="text-sm text-muted-foreground">Credits remaining</span>
            <span className="text-sm font-medium">{creditsRemaining.toFixed(1)} of {creditsTotal}</span>
          </div>
          <Progress value={(creditsRemaining / creditsTotal) * 100} className="h-2" />
          {effectiveBalance && (
            <div className="text-xs text-muted-foreground">
              Daily: {effectiveBalance.dailyCredits.toFixed(1)} • Monthly: {effectiveBalance.monthlyCredits.toFixed(1)}
            </div>
          )}
          <div className="space-y-1 text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              {subscription ? (
                <>
                  <Check className="h-3 w-3" />
                  Credits rollover to next month
                </>
              ) : (
                <>
                  <span>×</span>
                  No credits will rollover
                </>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Check className="h-3 w-3" />
              Daily credits reset at midnight UTC
            </div>
          </div>
        </div>
      </div>

      {/* Plan Selector */}
      {currentWorkspace && (
        <PlanSelector
          workspaceId={currentWorkspace.id}
          currentPlanId={currentPlanId}
        />
      )}
    </div>
  )
}

// ============================================================================
// USAGE TAB (Cloud & AI Balance + Team Usage Table)
// ============================================================================
function UsageTab() {
  const { currentWorkspace } = useWorkspaceData()
  const workspaceId = currentWorkspace?.id
  const [period, setPeriod] = useState<"7d" | "30d" | "90d" | "1y">("30d")
  const [logPage, setLogPage] = useState(1)

  // Workspace-scoped usage data
  const basePath = workspaceId ? `/api/workspaces/${workspaceId}` : ''
  const summaryResult = useWorkspaceUsageSummary(basePath, period)
  const logResult = useWorkspaceUsageLog(basePath, period, logPage)

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-lg font-semibold">Cloud & AI balance</h3>
          <p className="text-sm text-muted-foreground">
            All plans include free monthly usage. For increased Cloud and AI usage, you can top up on paid plans.
          </p>
        </div>
        <Button variant="outline" size="sm" asChild>
          <a 
            href="https://docs-staging.shogo.ai" 
            target="_blank" 
            rel="noopener noreferrer"
            className="flex items-center gap-2"
          >
            <BookOpen className="h-3 w-3" />
            Docs
          </a>
        </Button>
      </div>

      {/* Balance overview */}
      <div className="grid grid-cols-2 gap-4">
        <div className="p-4 bg-card rounded-lg border border-border">
          <div className="flex items-center gap-4">
            <div className="h-12 w-12 rounded-lg bg-gradient-to-br from-pink-500 to-orange-400 flex items-center justify-center">
              <Sparkles className="h-6 w-6 text-white" />
            </div>
            <div>
              <div className="font-medium">Cloud + AI</div>
              <div className="text-sm text-muted-foreground">Monthly included usage resets 1 Feb 2026</div>
            </div>
          </div>
          <div className="mt-4 flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Upgrade to top up your balance ($0).</span>
            <Button variant="link" size="sm" className="h-auto p-0">Upgrade plan</Button>
          </div>
        </div>

        <div className="p-4 bg-card rounded-lg border border-border space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="font-medium">Cloud</span>
              <Badge variant="outline" className="text-xs">?</Badge>
            </div>
            <div className="text-right">
              <div className="font-medium">$0 / $25</div>
              <div className="text-xs text-muted-foreground">Free balance used</div>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="font-medium">AI</span>
              <Badge variant="outline" className="text-xs">?</Badge>
            </div>
            <div className="text-right">
              <div className="font-medium">$0 / $1</div>
              <div className="text-xs text-muted-foreground">Free balance used</div>
            </div>
          </div>
        </div>
      </div>

      {/* Team AI Usage Table */}
      {workspaceId && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="font-medium">Team AI Usage</h4>
            <div className="flex items-center rounded-lg border border-border overflow-hidden text-xs">
              {(["7d", "30d", "90d", "1y"] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => { setPeriod(p); setLogPage(1) }}
                  className={`px-3 py-1.5 transition-colors ${
                    period === p
                      ? 'bg-primary text-primary-foreground'
                      : 'hover:bg-muted/50 text-muted-foreground'
                  }`}
                >
                  {p === '7d' ? '7 days' : p === '30d' ? '30 days' : p === '90d' ? '90 days' : '1 year'}
                </button>
              ))}
            </div>
          </div>
          <UsageTable
            summaryData={summaryResult.data}
            logData={logResult.data}
            summaryLoading={summaryResult.loading}
            logLoading={logResult.loading}
            onPageChange={setLogPage}
            currentPage={logPage}
            hideTokens
          />
        </div>
      )}

      {/* Project breakdown */}
      <div className="p-4 bg-card rounded-lg border border-border">
        <Button variant="ghost" className="w-full justify-between">
          <span>Project breakdown</span>
          <ChevronDown className="h-4 w-4" />
        </Button>
      </div>

      <p className="text-sm text-muted-foreground">
        This is a temporary offering until the beginning of 2026 as we refine our pricing model.{" "}
        <a href="#" className="text-primary hover:underline">Read more</a>
      </p>
    </div>
  )
}

// ============================================================================
// PRIVACY & SECURITY TAB
// ============================================================================
function PrivacyTab() {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">Privacy & security</h3>
        <p className="text-sm text-muted-foreground">
          Manage privacy and security settings for your workspace.
        </p>
      </div>

      <div className="space-y-4">
        {/* Default project visibility */}
        <div className="flex items-start justify-between p-4 bg-card rounded-lg border border-border">
          <div>
            <div className="font-medium">Default project visibility</div>
            <div className="text-sm text-muted-foreground">
              Choose whether new projects start as public, private (workspace-only), or drafts.
            </div>
          </div>
          <Select defaultValue="workspace">
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="public">Public</SelectItem>
              <SelectItem value="workspace">Workspace</SelectItem>
              <SelectItem value="private">Private</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Default website access */}
        <div className="flex items-start justify-between p-4 bg-card rounded-lg border border-border">
          <div className="flex items-center gap-2">
            <div>
              <div className="font-medium flex items-center gap-2">
                Default website access
                <Badge className="bg-purple-500/10 text-purple-500 border-purple-500/20">Business</Badge>
              </div>
              <div className="text-sm text-muted-foreground">
                Choose if new published websites are public or only accessible to logged in workspace members.
              </div>
            </div>
          </div>
          <Select defaultValue="anyone">
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="anyone">Anyone</SelectItem>
              <SelectItem value="members">Members only</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* MCP servers access */}
        <div className="flex items-start justify-between p-4 bg-card rounded-lg border border-border">
          <div>
            <div className="font-medium flex items-center gap-2">
              MCP servers access
              <Badge className="bg-purple-500/10 text-purple-500 border-purple-500/20">Business</Badge>
            </div>
            <div className="text-sm text-muted-foreground">
              Enable or disable MCP servers for all workspace members.
            </div>
          </div>
          <Switch />
        </div>

        {/* Data collection opt out */}
        <div className="flex items-start justify-between p-4 bg-card rounded-lg border border-border">
          <div>
            <div className="font-medium flex items-center gap-2">
              Data collection opt out
              <Badge className="bg-purple-500/10 text-purple-500 border-purple-500/20">Business</Badge>
            </div>
            <div className="text-sm text-muted-foreground">
              Opt out of data collection for this workspace.
            </div>
          </div>
          <Switch />
        </div>

        {/* Restrict workspace invitations */}
        <div className="flex items-start justify-between p-4 bg-card rounded-lg border border-border">
          <div>
            <div className="font-medium flex items-center gap-2">
              Restrict workspace invitations
              <Badge className="bg-amber-500/10 text-amber-500 border-amber-500/20">Enterprise</Badge>
            </div>
            <div className="text-sm text-muted-foreground">
              When enabled, only admins and owners can invite members to this workspace.
            </div>
          </div>
          <Switch />
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// ACCOUNT TAB
// ============================================================================
function AccountTab() {
  const { data: session } = useSession()
  const { auth } = useDomains()
  const user = session?.user

  const [name, setName] = useState(user?.name || "")
  const [description, setDescription] = useState("")
  const [location, setLocation] = useState("")
  const [link, setLink] = useState("")
  const [isSaving, setIsSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">("idle")
  const [chatSuggestions, setChatSuggestions] = useState(true)
  const [generationSound, setGenerationSound] = useState("first")

  const originalName = user?.name || ""
  const hasChanges = name !== originalName

  useEffect(() => {
    setName(user?.name || "")
    setSaveStatus("idle")
  }, [user?.name])

  const handleSave = async () => {
    if (!hasChanges || isSaving || !user?.id) return

    setIsSaving(true)
    setSaveStatus("idle")

    try {
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
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">Account settings</h3>
        <p className="text-sm text-muted-foreground">
          Personalize how others see and interact with you on Shogo.
        </p>
      </div>

      {/* Activity heatmap placeholder */}
      <div className="p-4 bg-card rounded-lg border border-border">
        <div className="flex items-center gap-2 text-sm mb-3">
          <span>0 edits on</span>
          <Sparkles className="h-4 w-4 text-primary" />
          <strong>Shogo</strong>
          <span>in the last year</span>
        </div>
        <div className="h-20 bg-muted/50 rounded flex items-center justify-center text-xs text-muted-foreground">
          Activity heatmap coming soon
        </div>
        <div className="grid grid-cols-3 gap-4 mt-3 text-sm">
          <div>
            <div className="text-muted-foreground">Daily average</div>
            <div className="font-medium">0.0 edits</div>
          </div>
          <div>
            <div className="text-muted-foreground">Days edited</div>
            <div className="font-medium">0 (0%)</div>
          </div>
          <div>
            <div className="text-muted-foreground">Current streak</div>
            <div className="font-medium">0 days</div>
          </div>
        </div>
      </div>

      {/* Profile settings */}
      <div className="space-y-4">
        {/* Avatar */}
        <div className="flex items-start justify-between p-4 bg-card rounded-lg border border-border">
          <div>
            <div className="font-medium">Your avatar</div>
            <div className="text-sm text-muted-foreground">
              Your avatar is either fetched from your linked identity provider or automatically generated.
            </div>
          </div>
          <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center text-lg font-medium">
            {user?.name?.[0]?.toUpperCase() || "U"}
          </div>
        </div>

        {/* Username */}
        <div className="p-4 bg-card rounded-lg border border-border space-y-2">
          <div>
            <div className="font-medium">Username</div>
            <div className="text-sm text-muted-foreground">
              Your public identifier and profile URL.
            </div>
          </div>
          <div className="flex gap-2">
            <Input value={user?.id?.slice(0, 20) || ""} disabled className="flex-1" />
            <Button variant="outline" size="sm">Update</Button>
          </div>
          <a href="#" className="text-sm text-primary hover:underline flex items-center gap-1">
            shogo.dev/@{user?.id?.slice(0, 12)}
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>

        {/* Email */}
        <div className="p-4 bg-card rounded-lg border border-border space-y-2">
          <div>
            <div className="font-medium">Email</div>
            <div className="text-sm text-muted-foreground">
              Your email address associated with your account.
            </div>
          </div>
          <Input value={user?.email || ""} disabled />
        </div>

        {/* Name */}
        <div className="p-4 bg-card rounded-lg border border-border space-y-2">
          <div>
            <div className="font-medium">Name</div>
            <div className="text-sm text-muted-foreground">
              Your full name, as visible to others.
            </div>
          </div>
          <Input
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setSaveStatus("idle")
            }}
            placeholder="Enter your name"
          />
        </div>

        {/* Description */}
        <div className="p-4 bg-card rounded-lg border border-border space-y-2">
          <div>
            <div className="font-medium">Description</div>
            <div className="text-sm text-muted-foreground">
              A short description of yourself or your work.
            </div>
          </div>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Tell us about yourself..."
          />
        </div>

        {/* Location */}
        <div className="p-4 bg-card rounded-lg border border-border space-y-2">
          <div>
            <div className="font-medium">Location</div>
            <div className="text-sm text-muted-foreground">
              Where you're based.
            </div>
          </div>
          <Input
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="San Francisco, CA"
          />
        </div>

        {/* Link */}
        <div className="p-4 bg-card rounded-lg border border-border space-y-2">
          <div>
            <div className="font-medium">Link</div>
            <div className="text-sm text-muted-foreground">
              Add a link to your personal website or portfolio.
            </div>
          </div>
          <Input
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="https://your-website.com"
          />
        </div>
      </div>

      {/* Preferences */}
      <div className="space-y-4">
        {/* Chat suggestions */}
        <div className="flex items-start justify-between p-4 bg-card rounded-lg border border-border">
          <div>
            <div className="font-medium">Chat suggestions</div>
            <div className="text-sm text-muted-foreground">
              Show helpful suggestions in the chat interface to enhance your experience.
            </div>
          </div>
          <Switch checked={chatSuggestions} onCheckedChange={setChatSuggestions} />
        </div>

        {/* Generation complete sound */}
        <div className="p-4 bg-card rounded-lg border border-border space-y-3">
          <div>
            <div className="font-medium">Generation complete sound</div>
            <div className="text-sm text-muted-foreground">
              Plays a satisfying sound notification when a generation is finished.
            </div>
          </div>
          <div className="flex gap-4">
            {["first", "always", "never"].map((option) => (
              <label key={option} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="generationSound"
                  value={option}
                  checked={generationSound === option}
                  onChange={(e) => setGenerationSound(e.target.value)}
                  className="h-4 w-4"
                />
                <span className="text-sm capitalize">
                  {option === "first" ? "First generation" : option}
                </span>
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* Linked accounts */}
      <div className="space-y-4">
        <div className="p-4 bg-card rounded-lg border border-border">
          <div className="mb-3">
            <div className="font-medium">Linked accounts</div>
            <div className="text-sm text-muted-foreground">
              Manage accounts linked for sign-in.
            </div>
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
              <div className="flex items-center gap-3">
                <div className="h-8 w-8 rounded bg-muted flex items-center justify-center">
                  <User className="h-4 w-4" />
                </div>
                <div>
                  <div className="font-medium flex items-center gap-2">
                    Password
                    <Badge variant="secondary" className="text-xs">Primary</Badge>
                  </div>
                  <div className="text-sm text-muted-foreground">{user?.email}</div>
                </div>
              </div>
            </div>
            <div className="flex items-center justify-between p-3 border border-dashed border-border rounded-lg">
              <div className="flex items-center gap-3">
                <div className="h-8 w-8 rounded bg-muted flex items-center justify-center">
                  <Building2 className="h-4 w-4" />
                </div>
                <div>
                  <div className="font-medium">Link company account</div>
                  <div className="text-sm text-muted-foreground">Use your organization's single sign-on</div>
                </div>
              </div>
              <Button variant="outline" size="sm">Link</Button>
            </div>
          </div>
        </div>

        {/* Two-factor authentication */}
        <div className="p-4 bg-card rounded-lg border border-border">
          <div className="mb-3">
            <div className="font-medium">Two-factor authentication</div>
            <div className="text-sm text-muted-foreground">
              Secure your account with a one-time code via an authenticator app or SMS.
            </div>
          </div>
          <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
            <div className="flex items-center gap-3">
              <Shield className="h-5 w-5 text-muted-foreground" />
              <div>
                <div className="font-medium">Re-authentication required</div>
                <div className="text-sm text-muted-foreground">
                  For security, please re-authenticate to manage two-factor settings.
                </div>
              </div>
            </div>
            <Button variant="outline" size="sm">Reauthenticate</Button>
          </div>
        </div>
      </div>

      {/* My Invitations */}
      <div className="space-y-4">
        <div className="p-4 bg-card rounded-lg border border-border">
          <div className="mb-4">
            <div className="font-medium">My Invitations</div>
            <div className="text-sm text-muted-foreground">
              Pending invitations to workspaces and projects.
            </div>
          </div>
          <MyInvitationsView />
        </div>
      </div>

      {/* Danger zone */}
      <div className="space-y-4">
        <div className="flex items-start justify-between p-4 rounded-lg border border-destructive/20 bg-destructive/5">
          <div>
            <div className="font-medium text-destructive">Delete account</div>
            <div className="text-sm text-muted-foreground">
              Permanently delete your Shogo account. This cannot be undone.
            </div>
          </div>
          <Button variant="destructive" size="sm">
            Delete account
          </Button>
        </div>
      </div>

      {/* Save changes bar */}
      {hasChanges && (
        <div className="flex items-center justify-end gap-2 pt-4 border-t border-border">
          <Button variant="outline" onClick={() => setName(originalName)} disabled={isSaving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSaving}>
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

// ============================================================================
// LABS TAB
// ============================================================================
function LabsTab() {
  const [githubBranchSwitching, setGithubBranchSwitching] = useState(false)

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-lg font-semibold">Labs</h3>
          <p className="text-sm text-muted-foreground">
            These are experimental features, that might be modified or removed.
          </p>
        </div>
        <Button variant="outline" size="sm" asChild>
          <a 
            href="https://docs-staging.shogo.ai" 
            target="_blank" 
            rel="noopener noreferrer"
            className="flex items-center gap-2"
          >
            <BookOpen className="h-3 w-3" />
            Docs
          </a>
        </Button>
      </div>

      <div className="space-y-4">
        <div className="flex items-start justify-between p-4 bg-card rounded-lg border border-border">
          <div>
            <div className="font-medium">GitHub branch switching</div>
            <div className="text-sm text-muted-foreground">
              Select the branch to make edits to in your GitHub repository.
            </div>
          </div>
          <Switch checked={githubBranchSwitching} onCheckedChange={setGithubBranchSwitching} />
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// CONNECTORS TAB
// ============================================================================
function ConnectorsTab() {
  const sharedConnectors = [
    { name: "Shogo Cloud", description: "Built-in backend, ready to use", enabled: true, icon: Sparkles },
    { name: "Shogo AI", description: "Unlock powerful AI features", enabled: true, icon: Sparkles },
  ]

  const personalConnectors = [
    { name: "Notion", description: "Access your Notion pages and databases.", icon: BookOpen },
    { name: "Linear", description: "Access your Linear issues and project data.", icon: Settings },
    { name: "Miro", description: "Access your Miro boards and diagrams.", icon: Settings },
  ]

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">Connectors</h3>
      </div>

      {/* Shared connectors */}
      <div className="space-y-3">
        <div>
          <h4 className="font-medium">Shared connectors</h4>
          <p className="text-sm text-muted-foreground">
            Add functionality to your apps. Configured once by admins, available to everyone in your workspace.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {sharedConnectors.map((connector) => (
            <button
              key={connector.name}
              className="flex items-center gap-4 p-4 bg-card rounded-lg border border-border text-left hover:bg-accent/50 transition-colors"
            >
              <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-pink-500 to-orange-400 flex items-center justify-center">
                <connector.icon className="h-5 w-5 text-white" />
              </div>
              <div className="flex-1">
                <div className="font-medium flex items-center gap-2">
                  {connector.name}
                  <Badge variant="secondary" className="text-xs">Enabled</Badge>
                </div>
                <div className="text-sm text-muted-foreground">{connector.description}</div>
              </div>
              <ChevronDown className="h-4 w-4 -rotate-90 text-muted-foreground" />
            </button>
          ))}
          <button className="flex items-center gap-4 p-4 bg-card rounded-lg border border-border text-left hover:bg-accent/50 transition-colors">
            <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center">
              <Plug className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className="flex-1">
              <div className="font-medium">Browse connectors</div>
            </div>
            <ChevronDown className="h-4 w-4 -rotate-90 text-muted-foreground" />
          </button>
        </div>
      </div>

      {/* Personal connectors */}
      <div className="space-y-3">
        <div>
          <h4 className="font-medium">Personal connectors</h4>
          <p className="text-sm text-muted-foreground">
            Connect your personal tools to provide context while building. Only you can access your connections.{" "}
            <a href="#" className="text-primary hover:underline">Read more</a>
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {personalConnectors.map((connector) => (
            <div
              key={connector.name}
              className="flex items-center gap-4 p-4 bg-card rounded-lg border border-border"
            >
              <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center">
                <connector.icon className="h-5 w-5 text-muted-foreground" />
              </div>
              <div className="flex-1">
                <div className="font-medium">{connector.name}</div>
                <div className="text-sm text-muted-foreground">{connector.description}</div>
              </div>
              <Button variant="outline" size="sm">Set up</Button>
            </div>
          ))}
        </div>
      </div>

      {/* Missing integration */}
      <div className="p-4 bg-card rounded-lg border border-border">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="font-medium">Missing an integration?</h4>
            <p className="text-sm text-muted-foreground">
              Request new integrations or support the ones you care about.
            </p>
          </div>
          <Button variant="outline" size="sm">Request</Button>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// GITHUB TAB
// ============================================================================
function GitHubTab() {
  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-lg font-semibold">GitHub</h3>
          <p className="text-sm text-muted-foreground">
            Sync your project 2-way with GitHub to collaborate at source.
          </p>
        </div>
        <Button variant="outline" size="sm" asChild>
          <a 
            href="https://docs-staging.shogo.ai" 
            target="_blank" 
            rel="noopener noreferrer"
            className="flex items-center gap-2"
          >
            <BookOpen className="h-3 w-3" />
            Docs
          </a>
        </Button>
      </div>

      <div className="p-4 bg-card rounded-lg border border-border">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-medium flex items-center gap-2">
              Connected account
              <Badge variant="secondary" className="text-xs">admin</Badge>
            </div>
            <div className="text-sm text-muted-foreground">
              Add your GitHub account to manage connected organizations.
            </div>
          </div>
          <Button variant="outline" className="gap-2">
            <Github className="h-4 w-4" />
            Connect GitHub
          </Button>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// MAIN SETTINGS PAGE
// ============================================================================
export const SettingsPage = observer(function SettingsPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { projectId } = useParams<{ projectId?: string }>()
  const { currentWorkspace, currentProject } = useWorkspaceData()

  // Determine if we're in project context (has projectId in URL)
  const hasProjectContext = !!projectId

  // Default to "workspace" when no project context, otherwise "project"
  const defaultTab = hasProjectContext ? "project" : "workspace"
  const tabParam = searchParams.get("tab") as TabId | null
  const [activeTab, setActiveTab] = useState<TabId>(tabParam || defaultTab)

  // Update URL when tab changes
  const handleTabChange = (tab: TabId) => {
    setActiveTab(tab)
    setSearchParams({ tab })
  }

  // Sync from URL on mount and when URL changes
  useEffect(() => {
    if (tabParam && tabParam !== activeTab) {
      setActiveTab(tabParam)
    }
  }, [tabParam])

  // Build nav sections - only include Project section when in project context
  const navSections: NavSection[] = [
    // Only show Project section when navigating from /projects/:projectId/settings
    ...(hasProjectContext ? [{
      title: "Project",
      items: [
        { id: "project" as TabId, label: "Project settings", icon: Settings },
        { id: "domains" as TabId, label: "Domains", icon: Globe },
        { id: "knowledge" as TabId, label: "Knowledge", icon: BookOpen },
      ],
    }] : []),
    {
      title: "Workspace",
      items: [
        { id: "workspace", label: currentWorkspace?.name || "Workspace", icon: Building2 },
        { id: "people", label: "People", icon: Users },
        { id: "billing", label: "Plans & credits", icon: CreditCard },
        { id: "usage", label: "Cloud & AI balance", icon: BarChart3 },
        { id: "privacy", label: "Privacy & security", icon: Shield },
      ],
    },
    {
      title: "Account",
      items: [
        { id: "account", label: "Account", icon: User },
        { id: "labs", label: "Labs", icon: FlaskConical },
      ],
    },
    {
      title: "Connectors",
      items: [
        // { id: "connectors", label: "Connectors", icon: Plug }, // not functional yet
        { id: "github", label: "GitHub", icon: Github },
      ],
    },
  ]

  return (
    <div className="flex h-full bg-background">
      {/* Sidebar */}
      <div className="w-56 border-r border-border p-3 space-y-4 overflow-y-auto">
        {/* Go back button - navigate to project or home, not browser history */}
        <button
          onClick={() => navigate(projectId ? `/projects/${projectId}` : "/")}
          className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Go back
        </button>

        {/* Navigation sections */}
        {navSections.map((section) => (
          <div key={section.title} className="space-y-1">
            <div className="px-3 py-1 text-xs font-medium text-muted-foreground/70 uppercase tracking-wider">
              {section.title}
            </div>
            {section.items.map((item) => (
              <NavItem
                key={item.id}
                id={item.id}
                label={item.label}
                icon={item.icon}
                active={activeTab === item.id}
                onClick={() => handleTabChange(item.id)}
                badge={item.badge}
              />
            ))}
          </div>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto p-8">
          {activeTab === "project" && <ProjectSettingsTab />}
          {activeTab === "domains" && <DomainsTab />}
          {activeTab === "knowledge" && <KnowledgeTab />}
          {activeTab === "workspace" && <WorkspaceSettingsTab />}
          {activeTab === "people" && <PeopleTab />}
          {activeTab === "billing" && <BillingTab />}
          {activeTab === "usage" && <UsageTab />}
          {activeTab === "privacy" && <PrivacyTab />}
          {activeTab === "account" && <AccountTab />}
          {activeTab === "labs" && <LabsTab />}
          {/* {activeTab === "connectors" && <ConnectorsTab />} */} {/* not functional yet */}
          {activeTab === "github" && <GitHubTab />}
        </div>
      </div>
    </div>
  )
})
