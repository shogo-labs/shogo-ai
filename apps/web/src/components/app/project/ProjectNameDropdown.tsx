/**
 * ProjectNameDropdown - Lovable.dev-style project menu
 *
 * Exact styling matches:
 * - Coral/orange project icon
 * - Project name with chevron + subtitle below
 * - Clean menu with workspace credits section
 * - Appearance and Help submenus
 */

import { useState, useCallback } from "react"
import { useNavigate } from "react-router-dom"
import {
  ChevronDown,
  ChevronLeft,
  Settings,
  Copy,
  Pencil,
  Star,
  StarOff,
  FolderInput,
  Sun,
  Moon,
  Monitor,
  HelpCircle,
  BookOpen,
  Keyboard,
  Bug,
  Gift,
  Sparkles,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"

export interface ProjectNameDropdownProps {
  projectName: string
  projectId: string
  projectIcon?: string
  projectSubtitle?: string
  isStarred?: boolean
  workspaceName?: string
  credits?: number
  maxCredits?: number
  onRename?: (newName: string) => Promise<void>
  onToggleStar?: () => void
  onDuplicate?: () => void
  onOpenSettings?: () => void
}

// Simple theme state helper
function getTheme(): "light" | "dark" | "system" {
  if (typeof window === "undefined") return "system"
  const stored = localStorage.getItem("theme")
  if (stored === "dark" || stored === "light") return stored
  return "system"
}

function setTheme(theme: "light" | "dark" | "system") {
  if (theme === "system") {
    localStorage.removeItem("theme")
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches
    document.documentElement.classList.toggle("dark", prefersDark)
  } else {
    localStorage.setItem("theme", theme)
    document.documentElement.classList.toggle("dark", theme === "dark")
  }
}

export function ProjectNameDropdown({
  projectName,
  projectId,
  projectIcon,
  projectSubtitle = "Previewing last saved version",
  isStarred = false,
  workspaceName = "My Workspace",
  credits = 5,
  maxCredits = 10,
  onRename,
  onToggleStar,
  onDuplicate,
  onOpenSettings,
}: ProjectNameDropdownProps) {
  const navigate = useNavigate()

  // Theme state
  const [currentTheme, setCurrentTheme] = useState<"light" | "dark" | "system">(getTheme)

  // Rename dialog state
  const [isRenameOpen, setIsRenameOpen] = useState(false)
  const [newName, setNewName] = useState(projectName)
  const [isRenaming, setIsRenaming] = useState(false)

  const handleGoToDashboard = useCallback(() => {
    navigate("/projects")
  }, [navigate])

  const handleThemeChange = useCallback((value: string) => {
    const theme = value as "light" | "dark" | "system"
    setTheme(theme)
    setCurrentTheme(theme)
  }, [])

  const handleRenameSubmit = useCallback(async () => {
    if (!onRename || !newName.trim() || newName === projectName) {
      setIsRenameOpen(false)
      return
    }

    setIsRenaming(true)
    try {
      await onRename(newName.trim())
      setIsRenameOpen(false)
    } catch (error) {
      console.error("Failed to rename project:", error)
    } finally {
      setIsRenaming(false)
    }
  }, [onRename, newName, projectName])

  const handleOpenDocs = useCallback(() => {
    window.open("https://docs.example.com", "_blank")
  }, [])

  // Get current theme icon
  const ThemeIcon = currentTheme === "dark" ? Moon : currentTheme === "light" ? Sun : Monitor

  // Calculate credits percentage
  const creditsPercentage = (credits / maxCredits) * 100

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="h-auto py-1 px-2 gap-2 hover:bg-accent/50 rounded-lg"
          >
            {/* Coral/orange project icon */}
            {projectIcon ? (
              <span className="text-sm">{projectIcon}</span>
            ) : (
              <div className="h-5 w-5 rounded bg-orange-500/90 flex items-center justify-center">
                <Sparkles className="h-3 w-3 text-white" />
              </div>
            )}
            
            {/* Project name and subtitle stacked */}
            <div className="flex flex-col items-start text-left">
              <div className="flex items-center gap-1">
                <span className="text-sm font-medium leading-tight">{projectName}</span>
                <ChevronDown className="h-3 w-3 opacity-50" />
              </div>
              <span className="text-[10px] text-muted-foreground leading-tight">
                {projectSubtitle}
              </span>
            </div>
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="start" className="w-72">
          {/* Go to Dashboard */}
          <DropdownMenuItem onClick={handleGoToDashboard} className="gap-2">
            <ChevronLeft className="h-4 w-4" />
            Go to Dashboard
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          {/* Workspace & Credits section */}
          <div className="px-2 py-2.5">
            <p className="text-xs font-medium text-muted-foreground mb-2">
              {workspaceName}
            </p>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-sm">
                <span>Credits</span>
                <div className="flex items-center gap-1.5">
                  <span className="text-emerald-500 font-medium">{credits} left</span>
                  <ChevronDown className="h-3 w-3 opacity-50" />
                </div>
              </div>
              <Progress value={creditsPercentage} className="h-1.5 bg-muted" />
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <div className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                Daily credits reset at midnight UTC
              </div>
            </div>
          </div>

          <DropdownMenuSeparator />

          {/* Get free credits */}
          <DropdownMenuItem className="gap-2">
            <Gift className="h-4 w-4" />
            Get free credits
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          {/* Settings */}
          <DropdownMenuItem onClick={onOpenSettings} className="gap-2">
            <Settings className="h-4 w-4" />
            <span className="flex-1">Settings</span>
            <kbd className="ml-auto h-5 px-1.5 inline-flex items-center rounded bg-muted text-[10px] text-muted-foreground font-mono">
              ⌘.
            </kbd>
          </DropdownMenuItem>

          {/* Remix/Duplicate */}
          {onDuplicate && (
            <DropdownMenuItem onClick={onDuplicate} className="gap-2">
              <Copy className="h-4 w-4" />
              Remix this project
            </DropdownMenuItem>
          )}

          {/* Rename */}
          <DropdownMenuItem
            onClick={() => {
              setNewName(projectName)
              setIsRenameOpen(true)
            }}
            className="gap-2"
          >
            <Pencil className="h-4 w-4" />
            Rename project
          </DropdownMenuItem>

          {/* Star/Unstar */}
          {onToggleStar && (
            <DropdownMenuItem onClick={onToggleStar} className="gap-2">
              {isStarred ? (
                <>
                  <StarOff className="h-4 w-4" />
                  Unstar project
                </>
              ) : (
                <>
                  <Star className="h-4 w-4" />
                  Star project
                </>
              )}
            </DropdownMenuItem>
          )}

          {/* Move to folder */}
          <DropdownMenuItem className="gap-2">
            <FolderInput className="h-4 w-4" />
            Move to folder
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          {/* Appearance submenu */}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="gap-2">
              <ThemeIcon className="h-4 w-4" />
              <span className="flex-1">Appearance</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup value={currentTheme} onValueChange={handleThemeChange}>
                <DropdownMenuRadioItem value="light" className="gap-2">
                  <Sun className="h-4 w-4" />
                  Light
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="dark" className="gap-2">
                  <Moon className="h-4 w-4" />
                  Dark
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="system" className="gap-2">
                  <Monitor className="h-4 w-4" />
                  System
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          {/* Help submenu */}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="gap-2">
              <HelpCircle className="h-4 w-4" />
              <span className="flex-1">Help</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onClick={handleOpenDocs} className="gap-2">
                <BookOpen className="h-4 w-4" />
                Documentation
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onOpenSettings} className="gap-2">
                <Keyboard className="h-4 w-4" />
                Keyboard shortcuts
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="gap-2">
                <Bug className="h-4 w-4" />
                Report an issue
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Rename Dialog */}
      <Dialog open={isRenameOpen} onOpenChange={setIsRenameOpen}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>Rename project</DialogTitle>
            <DialogDescription>
              Enter a new name for your project.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <div className="space-y-2">
              <Label htmlFor="project-name">Project name</Label>
              <Input
                id="project-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    handleRenameSubmit()
                  }
                }}
                placeholder="My awesome project"
                autoFocus
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsRenameOpen(false)}
              disabled={isRenaming}
            >
              Cancel
            </Button>
            <Button
              onClick={handleRenameSubmit}
              disabled={isRenaming || !newName.trim() || newName === projectName}
            >
              {isRenaming ? "Renaming..." : "Rename"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
