/**
 * PublishDropdown - Lovable.dev-style publish panel
 *
 * Exact styling matches:
 * - "Publish" button with solid background (no icon in button)
 * - Published URL input with full domain suffix
 * - "Add custom domain" link
 * - Access level dropdown
 * - Collapsible "Website info" section
 * - Review security + Publish buttons at bottom
 */

import { useState } from "react"
import {
  Globe,
  Lock,
  Users,
  Shield,
  ChevronRight,
  Info,
  ChevronDown,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

export type AccessLevel = "anyone" | "authenticated" | "private"

const ACCESS_OPTIONS = {
  anyone: { label: "Anyone", icon: Globe },
  authenticated: { label: "Authenticated users", icon: Users },
  private: { label: "Private", icon: Lock },
}

export interface PublishDropdownProps {
  projectId: string
  currentUrl?: string
  defaultSubdomain?: string
  accessLevel?: AccessLevel
  isPublished?: boolean
  publishedAt?: Date
  onUrlChange?: (url: string) => void
  onAccessChange?: (access: AccessLevel) => void
  onAddCustomDomain?: () => void
  onReviewSecurity?: () => void
  onPublish?: () => void
  onViewPublished?: () => void
}

export function PublishDropdown({
  projectId,
  currentUrl,
  defaultSubdomain = "published-url",
  accessLevel = "anyone",
  isPublished = false,
  publishedAt,
  onUrlChange,
  onAccessChange,
  onAddCustomDomain,
  onReviewSecurity,
  onPublish,
  onViewPublished,
}: PublishDropdownProps) {
  const [subdomain, setSubdomain] = useState(currentUrl || defaultSubdomain)
  const [isWebsiteInfoOpen, setIsWebsiteInfoOpen] = useState(false)
  const [isPublishing, setIsPublishing] = useState(false)
  const [isAccessOpen, setIsAccessOpen] = useState(false)

  const handlePublish = async () => {
    if (!onPublish) return
    setIsPublishing(true)
    try {
      await onPublish()
    } finally {
      setIsPublishing(false)
    }
  }

  const AccessIcon = ACCESS_OPTIONS[accessLevel].icon

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          className={cn(
            "h-8 px-3 text-sm font-medium",
            isPublished
              ? "bg-emerald-600 hover:bg-emerald-700 text-white"
              : "bg-foreground text-background hover:bg-foreground/90"
          )}
        >
          {isPublished ? "Published" : "Publish"}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-80 p-0">
        <div className="p-4 space-y-4">
          {/* Header */}
          <h3 className="font-semibold text-sm">Publish your app</h3>

          {/* Published URL */}
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Label className="text-xs font-medium">Published URL</Label>
              <Info className="h-3 w-3 text-muted-foreground cursor-help" />
            </div>
            <p className="text-[11px] text-muted-foreground leading-tight">
              Enter your URL, or leave empty to auto-generate.
            </p>
            <Input
              value={subdomain}
              onChange={(e) => {
                setSubdomain(e.target.value)
                onUrlChange?.(e.target.value)
              }}
              placeholder="my-project"
              className="h-8 text-sm"
            />
            <p className="text-[11px] text-muted-foreground">
              {subdomain}.shogo.app
            </p>
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs text-primary"
              onClick={onAddCustomDomain}
            >
              Add custom domain
            </Button>
          </div>

          {/* Access Level */}
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Label className="text-xs font-medium">Who can visit the URL?</Label>
              <Info className="h-3 w-3 text-muted-foreground cursor-help" />
            </div>
            <DropdownMenu open={isAccessOpen} onOpenChange={setIsAccessOpen}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  className="w-full h-8 justify-between text-sm"
                >
                  <div className="flex items-center gap-2">
                    <AccessIcon className="h-3.5 w-3.5" />
                    {ACCESS_OPTIONS[accessLevel].label}
                  </div>
                  <ChevronDown className="h-3.5 w-3.5 opacity-50" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-[--radix-dropdown-menu-trigger-width]">
                {(Object.entries(ACCESS_OPTIONS) as [AccessLevel, typeof ACCESS_OPTIONS[AccessLevel]][]).map(
                  ([key, { label, icon: Icon }]) => (
                    <Button
                      key={key}
                      variant="ghost"
                      className={cn(
                        "w-full justify-start h-8 gap-2 text-sm",
                        accessLevel === key && "bg-accent"
                      )}
                      onClick={() => {
                        onAccessChange?.(key)
                        setIsAccessOpen(false)
                      }}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      {label}
                    </Button>
                  )
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Website Info (Collapsible) */}
          <div>
            <button
              onClick={() => setIsWebsiteInfoOpen(!isWebsiteInfoOpen)}
              className="flex items-center justify-between w-full py-1 text-left"
            >
              <span className="text-sm font-medium">Website info</span>
              <ChevronRight
                className={cn(
                  "h-4 w-4 text-muted-foreground transition-transform",
                  isWebsiteInfoOpen && "rotate-90"
                )}
              />
            </button>
            {isWebsiteInfoOpen && (
              <div className="space-y-3 pt-3">
                <div className="space-y-1.5">
                  <Label htmlFor="site-title" className="text-xs">
                    Site Title
                  </Label>
                  <Input
                    id="site-title"
                    placeholder="My Awesome App"
                    className="h-8 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="site-description" className="text-xs">
                    Description
                  </Label>
                  <Input
                    id="site-description"
                    placeholder="A brief description of your app"
                    className="h-8 text-sm"
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Bottom Actions */}
        <div className="p-3 pt-0 flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="flex-1 h-8 text-xs"
            onClick={onReviewSecurity}
          >
            Review security
          </Button>
          <Button
            size="sm"
            className="flex-1 h-8 text-xs bg-primary hover:bg-primary/90"
            onClick={handlePublish}
            disabled={isPublishing}
          >
            {isPublishing ? "Publishing..." : "Publish"}
          </Button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
