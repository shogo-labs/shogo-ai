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

import { useState, useEffect, createContext, useContext } from "react"
import { observer } from "mobx-react-lite"
import { useNavigate } from "react-router-dom"
import {
  Building2,
  Users,
  CreditCard,
  User,
  Link2,
  Github,
  Settings,
  ExternalLink,
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
import { cn } from "@/lib/utils"
import { useWorkspaceData } from "../workspace"

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
function WorkspaceTab() {
  const { currentWorkspace } = useWorkspaceData()
  const [name, setName] = useState(currentWorkspace?.name || "")
  const [isSaving, setIsSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">("idle")

  const originalName = currentWorkspace?.name || ""
  const hasChanges = name !== originalName
  const isValid = name.trim().length > 0 && name.length <= 50

  useEffect(() => {
    setName(currentWorkspace?.name || "")
    setSaveStatus("idle")
  }, [currentWorkspace?.name])

  const handleSave = async () => {
    if (!hasChanges || !isValid) return
    
    setIsSaving(true)
    setSaveStatus("idle")
    
    try {
      // TODO: Call API to update workspace name
      // await updateWorkspace(currentWorkspace.slug, { name })
      
      // Simulate API call for now
      await new Promise(resolve => setTimeout(resolve, 500))
      
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

        {/* Leave workspace */}
        <div className="pt-4">
          <div className="flex items-start justify-between">
            <div>
              <Label className="text-destructive">Leave workspace</Label>
              <p className="text-xs text-muted-foreground">
                You cannot leave your last workspace.
              </p>
            </div>
            <Button variant="destructive" size="sm" disabled>
              Leave workspace
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

// People Tab
function PeopleTab() {
  const navigate = useNavigate()

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">People</h3>
        <p className="text-sm text-muted-foreground">
          Manage workspace members and invitations.
        </p>
      </div>

      <div className="p-4 bg-muted/50 rounded-lg text-center space-y-3">
        <Users className="h-8 w-8 mx-auto text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          Manage your team members and send invitations.
        </p>
        <Button onClick={() => navigate("/members")}>
          Go to Members Page
        </Button>
      </div>
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
  return (
    <div className="space-y-6">
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
            U
          </div>
        </div>

        {/* Email */}
        <div className="space-y-2">
          <Label>Email</Label>
          <p className="text-xs text-muted-foreground">
            Your email address associated with your account.
          </p>
          <Input value="user@example.com" disabled className="max-w-md" />
        </div>

        {/* Name */}
        <div className="space-y-2">
          <Label>Name</Label>
          <p className="text-xs text-muted-foreground">
            Your full name, as visible to others.
          </p>
          <Input placeholder="Enter your name" className="max-w-md" />
        </div>
      </div>
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
      <DialogContent className="max-w-3xl p-0 gap-0 h-[600px] overflow-hidden">
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
            {activeTab === "workspace" && <WorkspaceTab />}
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
