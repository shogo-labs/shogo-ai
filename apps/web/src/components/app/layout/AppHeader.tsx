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
 */

import { ThemeToggle } from "../shared/ThemeToggle"
import { UserMenu } from "../shared/UserMenu"
import { OrgSwitcher, ProjectSelector } from "../workspace"
import { useWorkspaceNavigation, useWorkspaceData } from "../workspace"

/**
 * AppHeader component
 *
 * Renders the main application header bar with logo, org/project selectors,
 * theme toggle, and user menu.
 */
export function AppHeader() {
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
        />
      </div>

      {/* Right: Controls */}
      <div className="flex items-center gap-2">
        <ThemeToggle />
        <UserMenu />
      </div>
    </header>
  )
}
