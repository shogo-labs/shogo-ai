/**
 * ThemeSwatch - Color swatch preview for themes
 * 
 * Displays 4 color circles representing a theme's color palette.
 * Used in the theme selector dropdown to preview themes at a glance.
 */

import { cn } from "@/lib/utils"
import type { HSLColor } from "@/lib/themes"

interface ThemeSwatchProps {
  /** Primary color (HSL string) */
  primary: HSLColor
  /** Secondary color (HSL string) */
  secondary: HSLColor
  /** Accent color (HSL string) */
  accent: HSLColor
  /** Background color (HSL string) */
  background: HSLColor
  /** Size variant */
  size?: "sm" | "md" | "lg"
  /** Additional class names */
  className?: string
}

/**
 * Converts HSL string to CSS hsl() value
 */
function hslToStyle(hsl: HSLColor): string {
  return `hsl(${hsl})`
}

/**
 * ThemeSwatch component
 * 
 * Renders 4 color circles in a row to preview a theme's color palette.
 */
export function ThemeSwatch({
  primary,
  secondary,
  accent,
  background,
  size = "md",
  className,
}: ThemeSwatchProps) {
  const sizeClasses = {
    sm: "h-3 w-3",
    md: "h-4 w-4",
    lg: "h-5 w-5",
  }

  const gapClasses = {
    sm: "gap-0.5",
    md: "gap-1",
    lg: "gap-1.5",
  }

  const colors = [
    { color: primary, label: "Primary" },
    { color: secondary, label: "Secondary" },
    { color: accent, label: "Accent" },
    { color: background, label: "Background" },
  ]

  return (
    <div 
      className={cn("flex items-center", gapClasses[size], className)}
      role="img"
      aria-label="Theme color preview"
    >
      {colors.map(({ color, label }, index) => (
        <div
          key={index}
          className={cn(
            "rounded-full border border-border/50 shadow-sm",
            sizeClasses[size]
          )}
          style={{ backgroundColor: hslToStyle(color) }}
          title={label}
        />
      ))}
    </div>
  )
}

export default ThemeSwatch
