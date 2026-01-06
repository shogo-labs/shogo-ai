/**
 * ThemeToggle - Theme switching component
 * Task: task-2-1-004
 *
 * Provides a button to toggle between light and dark themes.
 * Uses the standard shadcn classList.toggle('dark') pattern.
 *
 * Implementation details (per dd-2-1-theme-implementation-pattern):
 * - Uses document.documentElement.classList.toggle('dark')
 * - Persists to localStorage key 'theme'
 * - Shows Sun icon in dark mode, Moon icon in light mode
 * - Uses shadcn Button with variant='ghost'
 * - Does NOT use data-attribute approach
 */

import { useState, useCallback } from "react"
import { Moon, Sun } from "lucide-react"
import { Button } from "@/components/ui/button"

/**
 * ThemeToggle component
 *
 * Renders a ghost button with Sun/Moon icon that toggles the theme
 * between light and dark mode. Persists preference to localStorage.
 */
export function ThemeToggle() {
  // Initialize state based on current document class
  const [isDark, setIsDark] = useState(() =>
    document.documentElement.classList.contains("dark")
  )

  const toggleTheme = useCallback(() => {
    // Toggle the dark class on document.documentElement
    document.documentElement.classList.toggle("dark")

    // Determine the new theme after toggle
    const newTheme = document.documentElement.classList.contains("dark")
      ? "dark"
      : "light"

    // Persist to localStorage (use window.localStorage for test compatibility)
    window.localStorage.setItem("theme", newTheme)

    // Update component state
    setIsDark(newTheme === "dark")
  }, [])

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggleTheme}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
    >
      {isDark ? (
        <Sun className="h-5 w-5" data-testid="sun-icon" />
      ) : (
        <Moon className="h-5 w-5" data-testid="moon-icon" />
      )}
    </Button>
  )
}
