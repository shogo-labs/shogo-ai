/**
 * AdvancedModeToggle - Mode switching component for standard/advanced chat
 * Task: task-testbed-mode-toggle
 *
 * Provides a button to toggle between standard (/app) and advanced (/app/advanced-chat) modes.
 * Follows the ThemeToggle pattern.
 *
 * Implementation details (per dd-testbed-mode-toggle-behavior):
 * - Uses LayoutGrid icon for standard mode, Sparkles icon for advanced mode
 * - Preserves org, project URL params during navigation
 * - Persists preference to localStorage key 'advanced-chat-preferred'
 * - Uses useNavigate() from react-router-dom for navigation
 * - Uses useLocation() to determine current route
 * - Uses shadcn Button with variant='ghost' size='icon'
 */

import { useCallback } from "react"
import { useNavigate, useLocation } from "react-router-dom"
import { LayoutGrid, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"

/**
 * AdvancedModeToggle component
 *
 * Renders a ghost button with LayoutGrid/Sparkles icon that toggles between
 * standard and advanced chat modes. Persists preference to localStorage.
 */
export function AdvancedModeToggle() {
  const navigate = useNavigate()
  const location = useLocation()

  // Determine if we're currently in advanced mode based on the route
  const isAdvanced = location.pathname.includes("/advanced-chat")

  const toggleMode = useCallback(() => {
    // Get current search params to preserve
    const searchParams = location.search

    if (isAdvanced) {
      // Navigate to standard mode
      navigate(`/app${searchParams}`)
      window.localStorage.setItem("advanced-chat-preferred", "false")
    } else {
      // Navigate to advanced mode
      navigate(`/app/advanced-chat${searchParams}`)
      window.localStorage.setItem("advanced-chat-preferred", "true")
    }
  }, [isAdvanced, location.search, navigate])

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggleMode}
      aria-label={isAdvanced ? "Switch to standard mode" : "Switch to advanced mode"}
    >
      {isAdvanced ? (
        <Sparkles className="h-5 w-5" data-testid="sparkles-icon" />
      ) : (
        <LayoutGrid className="h-5 w-5" data-testid="layout-grid-icon" />
      )}
    </Button>
  )
}
