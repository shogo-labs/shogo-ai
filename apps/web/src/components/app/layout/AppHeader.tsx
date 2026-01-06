/**
 * AppHeader - Application header component
 * Task: task-2-1-010
 *
 * Renders the application header with:
 * - Logo/brand on left side
 * - Spacer (flex-1) in middle for future org/project selectors (Session 2.2)
 * - ThemeToggle and UserMenu on right side
 *
 * Implementation details (per ip-2-1-app-header):
 * - Fixed height h-14 (~56px)
 * - border-b for visual separation
 * - bg-card background color
 * - Uses Tailwind flex layout: flex items-center
 */

import { ThemeToggle } from "../shared/ThemeToggle"
import { UserMenu } from "../shared/UserMenu"

/**
 * AppHeader component
 *
 * Renders the main application header bar with logo, theme toggle, and user menu.
 * The middle spacer area is reserved for future OrgSwitcher and ProjectSelector
 * components in Session 2.2.
 */
export function AppHeader() {
  return (
    <header className="h-14 border-b bg-card flex items-center px-4">
      {/* Left: Logo/Brand */}
      <div className="flex items-center gap-2">
        <span className="font-semibold">Shogo Studio</span>
      </div>

      {/* Middle: Spacer for future org/project selectors (Session 2.2) */}
      <div className="flex-1" />

      {/* Right: Controls */}
      <div className="flex items-center gap-2">
        <ThemeToggle />
        <UserMenu />
      </div>
    </header>
  )
}
