/**
 * AppHeader - Application header component
 * Task: task-2-1-010, task-2-2-003
 *
 * Renders the application header with:
 * - Breadcrumb navigation on left (workspace > project)
 * - ProjectSelector in middle
 * - ThemeToggle and UserMenu on right side
 *
 * Implementation details (per ip-2-1-app-header, ip-2-2-002):
 * - Fixed height h-14 (~56px)
 * - border-b for visual separation
 * - bg-card background color
 * - Uses Tailwind flex layout: flex items-center
 * - ProjectSelector uses useWorkspaceNavigation/useWorkspaceData hooks
 * - Workspace switcher moved to AppSidebar
 *
 * IMPORTANT: This component MUST be wrapped with observer() because useWorkspaceData
 * accesses MST observables (memberCollection, etc). Without observer(), the component
 * won't re-render when the async data loads in DomainProvider.
 */

import { observer } from "mobx-react-lite"
import { ThemeToggle, AdvancedModeToggle, useSettingsModal } from "../shared"
import { Users, ChevronRight } from "lucide-react"
import { ProjectSelector } from "../workspace"
import { useWorkspaceNavigation, useWorkspaceData } from "../workspace"
import { Button } from "@/components/ui/button"

/**
 * AppHeader component
 *
 * Renders the main application header bar with breadcrumb, project selector,
 * theme toggle, and user menu.
 *
 * Wrapped with observer() to react to MST observable changes from useWorkspaceData.
 */
export const AppHeader = observer(function AppHeader() {
  // Get navigation functions from URL state
  const { setProjectId } = useWorkspaceNavigation()

  // Get workspace data derived from URL state and domains
  const { currentWorkspace, projects, currentProject, isLoading } =
    useWorkspaceData()

  // Get settings modal
  const { openSettings } = useSettingsModal()

  // Handle project change - updates URL which triggers data refresh
  const handleProjectChange = (id: string) => {
    setProjectId(id)
  }

  return (
    <header className="h-14 border-b bg-card flex items-center px-4">
      {/* Left: Breadcrumb navigation */}
      <div className="flex items-center gap-1 text-sm">
        {currentWorkspace && (
          <>
            <span className="text-muted-foreground">{currentWorkspace.name}</span>
            <ChevronRight className="h-4 w-4 text-muted-foreground/50" />
          </>
        )}
        <ProjectSelector
          projects={projects}
          currentProject={currentProject ?? null}
          onProjectChange={handleProjectChange}
          disabled={!currentWorkspace}
          isLoading={isLoading}
          workspaceId={currentWorkspace?.id}
        />
      </div>

      {/* Middle spacer */}
      <div className="flex-1" />

      {/* Right: Controls */}
      <div className="flex items-center gap-2">
        {/* Members button - opens settings modal on People tab */}
        {currentWorkspace && (
          <Button
            variant="ghost"
            size="sm"
            className="h-9 gap-2"
            onClick={() => openSettings("people")}
            title="Manage members"
          >
            <Users className="h-4 w-4" />
            <span className="hidden sm:inline">Members</span>
          </Button>
        )}
        <AdvancedModeToggle />
        <ThemeToggle />
      </div>
    </header>
  )
})
