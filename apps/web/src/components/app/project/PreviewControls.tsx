/**
 * PreviewControls - Lovable.dev-style preview toolbar
 *
 * Exact styling matches:
 * - Preview button with icon + text
 * - Grouped viewport icons in a subtle container
 * - Code/Plus button
 * - Separator
 * - Minimal URL bar with screen icon
 * - Navigation arrows and refresh
 */

import { useState } from "react"
import {
  Smartphone,
  Tablet,
  Monitor,
  MonitorPlay,
  Eye,
  RefreshCw,
  ArrowUpRight,
  ArrowLeft,
  ArrowRight,
  Code,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

export type ViewportSize = "mobile" | "tablet" | "desktop" | "wide"

export const VIEWPORT_SIZES: Record<ViewportSize, { width: number; icon: React.ElementType; label: string }> = {
  mobile: { width: 375, icon: Smartphone, label: "Mobile" },
  tablet: { width: 768, icon: Tablet, label: "Tablet" },
  desktop: { width: 1024, icon: Monitor, label: "Desktop" },
  wide: { width: 1440, icon: MonitorPlay, label: "Wide" },
}

export interface PreviewControlsProps {
  currentViewport?: ViewportSize
  onViewportChange?: (viewport: ViewportSize) => void
  currentRoute?: string
  onRouteChange?: (route: string) => void
  onRefresh?: () => void
  onOpenCode?: () => void
  onOpenExternal?: () => void
  className?: string
}

export function PreviewControls({
  currentViewport = "desktop",
  onViewportChange,
  currentRoute = "/",
  onRouteChange,
  onRefresh,
  onOpenCode,
  onOpenExternal,
  className,
}: PreviewControlsProps) {
  const [routeInput, setRouteInput] = useState(currentRoute)

  const handleRouteSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onRouteChange?.(routeInput)
  }

  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      {/* Preview Mode Button */}
      <Button
        variant="secondary"
        size="sm"
        className="h-7 gap-1.5 px-2.5 text-xs bg-muted/80 hover:bg-muted"
      >
        <Eye className="h-3.5 w-3.5" />
        Preview
      </Button>

      {/* Viewport Size Buttons - grouped in subtle container */}
      <div className="flex items-center rounded-md bg-muted/40 p-0.5">
        {(Object.entries(VIEWPORT_SIZES) as [ViewportSize, typeof VIEWPORT_SIZES[ViewportSize]][]).map(
          ([size, { icon: Icon, label }]) => (
            <Button
              key={size}
              variant="ghost"
              size="icon"
              title={label}
              className={cn(
                "h-6 w-6 rounded-sm text-muted-foreground hover:text-foreground",
                currentViewport === size && "bg-background text-foreground shadow-sm"
              )}
              onClick={() => onViewportChange?.(size)}
            >
              <Icon className="h-3.5 w-3.5" />
            </Button>
          )
        )}
      </div>

      {/* Code/Add button */}
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-muted-foreground hover:text-foreground"
        onClick={onOpenCode}
        title="View code"
      >
        <Code className="h-3.5 w-3.5" />
      </Button>

      {/* Separator */}
      <div className="h-5 w-px bg-border mx-0.5" />

      {/* URL bar section */}
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-muted-foreground hover:text-foreground"
        title="Toggle URL bar"
      >
        <Monitor className="h-3.5 w-3.5" />
      </Button>

      {/* URL Input */}
      <form onSubmit={handleRouteSubmit} className="flex items-center">
        <div className="flex items-center h-7 rounded-md border border-border/40 bg-muted/30 px-2">
          <Input
            value={routeInput}
            onChange={(e) => setRouteInput(e.target.value)}
            className="h-5 w-24 border-0 bg-transparent px-0 text-xs focus-visible:ring-0 placeholder:text-muted-foreground/60"
            placeholder="/"
          />
        </div>
      </form>

      {/* Navigation arrows */}
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-muted-foreground hover:text-foreground"
        title="Open in new tab"
        onClick={onOpenExternal}
      >
        <ArrowUpRight className="h-3.5 w-3.5" />
      </Button>

      {/* Refresh Button */}
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-muted-foreground hover:text-foreground"
        onClick={onRefresh}
        title="Refresh preview"
      >
        <RefreshCw className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}
