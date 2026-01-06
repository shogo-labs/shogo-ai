/**
 * SplashScreen - Loading indicator shown during auth initialization
 * Task: task-2-1-003
 *
 * Full-screen centered loading indicator displayed while the auth
 * state is being initialized. Shows the app logo/name and a spinner.
 *
 * Features:
 * - Full-screen layout (h-screen) with centered content
 * - Loading spinner (Loader2 from lucide-react)
 * - App name/branding
 * - Theme-aware colors (bg-background, text-foreground)
 * - Works in both light and dark mode
 *
 * No reactive state needed - this is a simple presentational component.
 */

import { Loader2 } from "lucide-react"

/**
 * SplashScreen component
 *
 * Renders a full-screen loading indicator with centered content.
 * Used during auth initialization phase before the app shell loads.
 */
export function SplashScreen() {
  return (
    <div className="h-screen flex items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-4">
        {/* App branding */}
        <h1 className="text-2xl font-semibold text-foreground">Shogo Studio</h1>

        {/* Loading spinner */}
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />

        {/* Loading text */}
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    </div>
  )
}
