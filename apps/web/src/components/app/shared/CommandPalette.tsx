/**
 * CommandPalette - Global search command palette
 * 
 * Opens with ⌘+K (Mac) or Ctrl+K (Windows/Linux).
 * Provides quick navigation to features, projects, pages, and actions.
 * 
 * Inspired by Lovable.dev's search interface.
 */

import { useState, useEffect, useCallback, useMemo } from "react"
import { useNavigate } from "react-router-dom"
import {
  Search,
  Home,
  LayoutGrid,
  Star,
  Users,
  Compass,
  FileCode2,
  CreditCard,
  User,
  Settings,
  ArrowRight,
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { useWorkspaceData } from "../workspace"

interface CommandItem {
  id: string
  label: string
  description?: string
  icon: React.ElementType
  action: () => void
  category: "navigation" | "projects" | "features" | "settings"
  keywords?: string[]
}

interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const navigate = useNavigate()
  const [query, setQuery] = useState("")
  const [selectedIndex, setSelectedIndex] = useState(0)
  
  const { features, projects, currentWorkspace } = useWorkspaceData()

  // Build command items list
  const commands = useMemo<CommandItem[]>(() => {
    const items: CommandItem[] = [
      // Navigation
      {
        id: "nav-home",
        label: "Home",
        description: "Go to home page",
        icon: Home,
        action: () => navigate("/"),
        category: "navigation",
        keywords: ["home", "dashboard"],
      },
      {
        id: "nav-projects",
        label: "All Projects",
        description: "View all projects",
        icon: LayoutGrid,
        action: () => navigate("/projects"),
        category: "navigation",
        keywords: ["projects", "all"],
      },
      {
        id: "nav-starred",
        label: "Starred",
        description: "View starred projects",
        icon: Star,
        action: () => navigate("/starred"),
        category: "navigation",
        keywords: ["starred", "favorites"],
      },
      {
        id: "nav-shared",
        label: "Shared with me",
        description: "View shared projects",
        icon: Users,
        action: () => navigate("/shared"),
        category: "navigation",
        keywords: ["shared", "team"],
      },
      {
        id: "nav-discover",
        label: "Discover",
        description: "Explore community apps",
        icon: Compass,
        action: () => navigate("/discover"),
        category: "navigation",
        keywords: ["discover", "explore", "community"],
      },
      {
        id: "nav-templates",
        label: "Templates",
        description: "Browse templates",
        icon: FileCode2,
        action: () => navigate("/templates"),
        category: "navigation",
        keywords: ["templates", "starter"],
      },
      // Settings
      {
        id: "settings-billing",
        label: "Plans & Billing",
        description: "Manage subscription and credits",
        icon: CreditCard,
        action: () => navigate("/billing"),
        category: "settings",
        keywords: ["billing", "plans", "subscription", "credits", "upgrade"],
      },
      {
        id: "settings-profile",
        label: "Profile",
        description: "View your profile",
        icon: User,
        action: () => navigate("/profile"),
        category: "settings",
        keywords: ["profile", "account"],
      },
      {
        id: "settings-members",
        label: "Members",
        description: "Manage workspace members",
        icon: Users,
        action: () => navigate("/members"),
        category: "settings",
        keywords: ["members", "team", "invite"],
      },
    ]

    // Add projects as searchable items
    if (projects && projects.length > 0) {
      projects.forEach((project: any) => {
        items.push({
          id: `project-${project.id}`,
          label: project.name,
          description: "Project",
          icon: LayoutGrid,
          action: () => navigate(`/app?project=${project.id}`),
          category: "projects",
          keywords: [project.name.toLowerCase()],
        })
      })
    }

    // Add features as searchable items
    if (features && features.length > 0) {
      features.forEach((feature: any) => {
        items.push({
          id: `feature-${feature.id}`,
          label: feature.name,
          description: feature.intent || "Feature",
          icon: FileCode2,
          action: () => navigate(`/app?feature=${feature.id}`),
          category: "features",
          keywords: [feature.name.toLowerCase(), feature.intent?.toLowerCase() || ""],
        })
      })
    }

    return items
  }, [navigate, projects, features])

  // Filter commands based on query
  const filteredCommands = useMemo(() => {
    if (!query.trim()) {
      return commands
    }
    const lowerQuery = query.toLowerCase()
    return commands.filter((cmd) => {
      const labelMatch = cmd.label.toLowerCase().includes(lowerQuery)
      const descMatch = cmd.description?.toLowerCase().includes(lowerQuery)
      const keywordMatch = cmd.keywords?.some((k) => k.includes(lowerQuery))
      return labelMatch || descMatch || keywordMatch
    })
  }, [commands, query])

  // Group filtered commands by category
  const groupedCommands = useMemo(() => {
    const groups: Record<string, CommandItem[]> = {
      navigation: [],
      projects: [],
      features: [],
      settings: [],
    }
    filteredCommands.forEach((cmd) => {
      groups[cmd.category].push(cmd)
    })
    return groups
  }, [filteredCommands])

  // Reset selection when filter changes
  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  // Reset query when dialog closes
  useEffect(() => {
    if (!open) {
      setQuery("")
      setSelectedIndex(0)
    }
  }, [open])

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const totalItems = filteredCommands.length

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault()
          setSelectedIndex((prev) => (prev + 1) % totalItems)
          break
        case "ArrowUp":
          e.preventDefault()
          setSelectedIndex((prev) => (prev - 1 + totalItems) % totalItems)
          break
        case "Enter":
          e.preventDefault()
          if (filteredCommands[selectedIndex]) {
            filteredCommands[selectedIndex].action()
            onOpenChange(false)
          }
          break
        case "Escape":
          onOpenChange(false)
          break
      }
    },
    [filteredCommands, selectedIndex, onOpenChange]
  )

  // Execute selected command
  const executeCommand = (cmd: CommandItem) => {
    cmd.action()
    onOpenChange(false)
  }

  // Get flat index for an item
  const getFlatIndex = (category: string, indexInCategory: number): number => {
    let flatIndex = 0
    const categoryOrder = ["navigation", "projects", "features", "settings"]
    for (const cat of categoryOrder) {
      if (cat === category) {
        return flatIndex + indexInCategory
      }
      flatIndex += groupedCommands[cat].length
    }
    return flatIndex
  }

  const categoryLabels: Record<string, string> = {
    navigation: "Navigation",
    projects: "Projects",
    features: "Features",
    settings: "Settings",
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="p-0 gap-0 max-w-xl overflow-hidden">
        <DialogTitle className="sr-only">Search</DialogTitle>
        
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
          <Search className="h-5 w-5 text-muted-foreground shrink-0" />
          <Input
            placeholder="Search for pages, projects, features..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className="border-0 bg-transparent p-0 h-auto text-base focus-visible:ring-0 placeholder:text-muted-foreground/60"
            autoFocus
          />
          <kbd className="hidden sm:inline-flex h-5 items-center gap-1 rounded border border-border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div className="max-h-[400px] overflow-y-auto py-2">
          {filteredCommands.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No results found for "{query}"
            </div>
          ) : (
            <>
              {(["navigation", "projects", "features", "settings"] as const).map(
                (category) => {
                  const items = groupedCommands[category]
                  if (items.length === 0) return null

                  return (
                    <div key={category}>
                      <div className="px-4 py-1.5 text-xs font-medium text-muted-foreground/70 uppercase tracking-wider">
                        {categoryLabels[category]}
                      </div>
                      {items.map((cmd, idx) => {
                        const flatIndex = getFlatIndex(category, idx)
                        const isSelected = flatIndex === selectedIndex
                        const Icon = cmd.icon

                        return (
                          <button
                            key={cmd.id}
                            onClick={() => executeCommand(cmd)}
                            onMouseEnter={() => setSelectedIndex(flatIndex)}
                            className={cn(
                              "flex items-center gap-3 w-full px-4 py-2.5 text-left transition-colors",
                              isSelected
                                ? "bg-accent text-accent-foreground"
                                : "hover:bg-accent/50"
                            )}
                          >
                            <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium truncate">
                                {cmd.label}
                              </div>
                              {cmd.description && (
                                <div className="text-xs text-muted-foreground truncate">
                                  {cmd.description}
                                </div>
                              )}
                            </div>
                            {isSelected && (
                              <ArrowRight className="h-4 w-4 text-muted-foreground" />
                            )}
                          </button>
                        )
                      })}
                    </div>
                  )
                }
              )}
            </>
          )}
        </div>

        {/* Footer hint */}
        <div className="flex items-center gap-4 px-4 py-2 border-t border-border text-xs text-muted-foreground">
          <div className="flex items-center gap-1">
            <kbd className="h-4 min-w-4 inline-flex items-center justify-center rounded border border-border bg-muted px-1 font-mono text-[10px]">
              ↑
            </kbd>
            <kbd className="h-4 min-w-4 inline-flex items-center justify-center rounded border border-border bg-muted px-1 font-mono text-[10px]">
              ↓
            </kbd>
            <span>Navigate</span>
          </div>
          <div className="flex items-center gap-1">
            <kbd className="h-4 min-w-4 inline-flex items-center justify-center rounded border border-border bg-muted px-1 font-mono text-[10px]">
              ↵
            </kbd>
            <span>Select</span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Hook to manage command palette state and keyboard shortcut
 */
export function useCommandPalette() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // ⌘+K on Mac, Ctrl+K on Windows/Linux
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setOpen((prev) => !prev)
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [])

  return { open, setOpen }
}
