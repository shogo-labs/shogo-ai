/**
 * AppHeader - Application header component
 * Task: task-2-1-010, task-2-2-003
 *
 * Renders the application header with:
 * - Logo/brand on left side
 * - OrgSwitcher and ProjectSelector in middle (Session 2.2)
 * - ThemeToggle and UserMenu on right side
 *
 * Implementation details (per ip-2-1-app-header, ip-2-2-002):
 * - Fixed height h-14 (~56px)
 * - border-b for visual separation
 * - bg-card background color
 * - Uses Tailwind flex layout: flex items-center
 * - OrgSwitcher and ProjectSelector use useWorkspaceNavigation/useWorkspaceData hooks
 *
 * IMPORTANT: This component MUST be wrapped with observer() because useWorkspaceData
 * accesses MST observables (memberCollection, etc). Without observer(), the component
 * won't re-render when the async data loads in DomainProvider.
 */

import { observer } from "mobx-react-lite"
import { Link } from "react-router-dom"
import { Users } from "lucide-react"
import { ThemeToggle } from "../shared/ThemeToggle"
import { UserMenu } from "../shared/UserMenu"
import { OrgSwitcher, ProjectSelector } from "../workspace"
import { useWorkspaceNavigation, useWorkspaceData } from "../workspace"
import { Button } from "@/components/ui/button"

/**
 * AppHeader component
 *
 * Renders the main application header bar with logo, org/project selectors,
 * theme toggle, and user menu.
 *
 * Wrapped with observer() to react to MST observable changes from useWorkspaceData.
 */
export const AppHeader = observer(function AppHeader() {
  // Get navigation functions from URL state
  const { setOrg, setProjectId } = useWorkspaceNavigation()

  // Get workspace data derived from URL state and domains
  const { orgs, currentOrg, projects, currentProject, isLoading } =
    useWorkspaceData()

  // Handle org change - updates URL which triggers data refresh
  const handleOrgChange = (slug: string) => {
    setOrg(slug)
  }

  // Handle project change - updates URL which triggers data refresh
  const handleProjectChange = (id: string) => {
    setProjectId(id)
  }

  return (
    <header className="h-14 border-b bg-card flex items-center px-4">
      {/* Left: Logo/Brand */}
      <div className="flex items-center gap-2">
        <span className="font-semibold">Shogo Studio</span>
      </div>

      {/* Middle: Org/Project Selectors (Session 2.2) */}
      <div className="flex items-center gap-4 flex-1 ml-6">
        <OrgSwitcher
          orgs={orgs}
          currentOrg={currentOrg ?? null}
          onOrgChange={handleOrgChange}
          isLoading={isLoading}
        />
        <ProjectSelector
          projects={projects}
          currentProject={currentProject ?? null}
          onProjectChange={handleProjectChange}
          disabled={!currentOrg}
          isLoading={isLoading}
          organizationId={currentOrg?.id}
        />
        {/* Members link - only show when org is selected */}
        {currentOrg && (
          <Link to="/app/members" title="Manage members">
            <Button variant="ghost" size="icon" className="h-9 w-9">
              <Users className="h-4 w-4" />
              <span className="sr-only">Members</span>
            </Button>
          </Link>
        )}
      </div>

      {/* Right: Controls */}
      <div className="flex items-center gap-2">
        <ThemeToggle />
        <UserMenu />
      </div>
    </header>
  )
})
