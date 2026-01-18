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
 * - Subdomain availability checking with debounce
 */

import { useState, useEffect, useCallback, useRef } from "react"
import {
  Globe,
  Lock,
  Users,
  ChevronRight,
  Info,
  ChevronDown,
  CheckCircle,
  XCircle,
  Loader2,
  ExternalLink,
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
  currentSubdomain?: string
  defaultSubdomain?: string
  accessLevel?: AccessLevel
  isPublished?: boolean
  publishedAt?: Date
  siteTitle?: string
  siteDescription?: string
  onAddCustomDomain?: () => void
  onReviewSecurity?: () => void
  onPublish?: (data: {
    subdomain: string
    accessLevel: AccessLevel
    siteTitle?: string
    siteDescription?: string
  }) => Promise<{ url: string; publishedAt: number }>
  onUnpublish?: () => Promise<void>
  onUpdateSettings?: (data: {
    accessLevel?: AccessLevel
    siteTitle?: string
    siteDescription?: string
  }) => Promise<void>
  onViewPublished?: (url: string) => void
}

// Debounce hook
function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value)

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedValue(value)
    }, delay)

    return () => {
      clearTimeout(timer)
    }
  }, [value, delay])

  return debouncedValue
}

export function PublishDropdown({
  projectId,
  currentSubdomain,
  defaultSubdomain = "",
  accessLevel: initialAccessLevel = "anyone",
  isPublished: initialIsPublished = false,
  publishedAt: initialPublishedAt,
  siteTitle: initialSiteTitle = "",
  siteDescription: initialSiteDescription = "",
  onAddCustomDomain,
  onReviewSecurity,
  onPublish,
  onUnpublish,
  onUpdateSettings,
  onViewPublished,
}: PublishDropdownProps) {
  const [subdomain, setSubdomain] = useState(currentSubdomain || defaultSubdomain)
  const [accessLevel, setAccessLevel] = useState<AccessLevel>(initialAccessLevel)
  const [siteTitle, setSiteTitle] = useState(initialSiteTitle)
  const [siteDescription, setSiteDescription] = useState(initialSiteDescription)
  const [isWebsiteInfoOpen, setIsWebsiteInfoOpen] = useState(false)
  const [isPublishing, setIsPublishing] = useState(false)
  const [isUnpublishing, setIsUnpublishing] = useState(false)
  const [isAccessOpen, setIsAccessOpen] = useState(false)
  const [isPublished, setIsPublished] = useState(initialIsPublished)
  const [publishedAt, setPublishedAt] = useState(initialPublishedAt)

  // Subdomain availability state
  const [subdomainStatus, setSubdomainStatus] = useState<{
    checking: boolean
    available: boolean | null
    reason?: string
  }>({ checking: false, available: null })

  // Track if subdomain has been modified from the published one
  const isSubdomainModified = subdomain !== currentSubdomain

  // Debounce subdomain input for availability check
  const debouncedSubdomain = useDebounce(subdomain, 500)

  // Check subdomain availability
  const checkSubdomainAvailability = useCallback(
    async (subdomainToCheck: string) => {
      // Skip if empty or same as current (already published)
      if (!subdomainToCheck || subdomainToCheck.length < 3) {
        setSubdomainStatus({ checking: false, available: null })
        return
      }

      // Skip if same as currently published subdomain
      if (subdomainToCheck === currentSubdomain) {
        setSubdomainStatus({ checking: false, available: true })
        return
      }

      setSubdomainStatus({ checking: true, available: null })

      try {
        const response = await fetch(
          `/api/subdomains/${encodeURIComponent(subdomainToCheck)}/check`
        )
        const data = await response.json()
        setSubdomainStatus({
          checking: false,
          available: data.available,
          reason: data.reason,
        })
      } catch (error) {
        setSubdomainStatus({
          checking: false,
          available: null,
          reason: "Failed to check availability",
        })
      }
    },
    [currentSubdomain]
  )

  // Check availability when debounced subdomain changes
  useEffect(() => {
    checkSubdomainAvailability(debouncedSubdomain)
  }, [debouncedSubdomain, checkSubdomainAvailability])

  // Sync props to state when they change
  useEffect(() => {
    setIsPublished(initialIsPublished)
    setPublishedAt(initialPublishedAt)
  }, [initialIsPublished, initialPublishedAt])

  useEffect(() => {
    setAccessLevel(initialAccessLevel)
  }, [initialAccessLevel])

  useEffect(() => {
    if (currentSubdomain) {
      setSubdomain(currentSubdomain)
    }
  }, [currentSubdomain])

  const handlePublish = async () => {
    if (!onPublish || !subdomain) return
    setIsPublishing(true)
    try {
      const result = await onPublish({
        subdomain,
        accessLevel,
        siteTitle: siteTitle || undefined,
        siteDescription: siteDescription || undefined,
      })
      setIsPublished(true)
      setPublishedAt(new Date(result.publishedAt))
    } catch (error: any) {
      console.error("[PublishDropdown] Publish failed:", error)
    } finally {
      setIsPublishing(false)
    }
  }

  const handleUnpublish = async () => {
    if (!onUnpublish) return
    setIsUnpublishing(true)
    try {
      await onUnpublish()
      setIsPublished(false)
      setPublishedAt(undefined)
    } catch (error: any) {
      console.error("[PublishDropdown] Unpublish failed:", error)
    } finally {
      setIsUnpublishing(false)
    }
  }

  const handleAccessChange = async (newAccessLevel: AccessLevel) => {
    setAccessLevel(newAccessLevel)
    setIsAccessOpen(false)

    // If already published, update settings immediately
    if (isPublished && onUpdateSettings) {
      try {
        await onUpdateSettings({ accessLevel: newAccessLevel })
      } catch (error) {
        console.error("[PublishDropdown] Update settings failed:", error)
      }
    }
  }

  const handleViewPublished = () => {
    if (subdomain && onViewPublished) {
      onViewPublished(`https://${subdomain}.shogo.ai`)
    }
  }

  const AccessIcon = ACCESS_OPTIONS[accessLevel].icon

  // Determine if publish button should be disabled
  const canPublish =
    subdomain.length >= 3 &&
    !subdomainStatus.checking &&
    (subdomainStatus.available === true || subdomain === currentSubdomain) &&
    !isPublishing

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
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-sm">
              {isPublished ? "Your app is live" : "Publish your app"}
            </h3>
            {isPublished && currentSubdomain && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={handleViewPublished}
              >
                <ExternalLink className="h-3 w-3 mr-1" />
                View
              </Button>
            )}
          </div>

          {/* Published URL - show live URL if published */}
          {isPublished && currentSubdomain && (
            <div className="flex items-center gap-2 p-2 bg-emerald-50 dark:bg-emerald-950/30 rounded-md border border-emerald-200 dark:border-emerald-800">
              <CheckCircle className="h-4 w-4 text-emerald-600 shrink-0" />
              <span className="text-sm text-emerald-700 dark:text-emerald-400 truncate">
                {currentSubdomain}.shogo.ai
              </span>
            </div>
          )}

          {/* Subdomain Input */}
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Label className="text-xs font-medium">
                {isPublished ? "Change URL" : "Published URL"}
              </Label>
              <Info className="h-3 w-3 text-muted-foreground cursor-help" />
            </div>
            <p className="text-[11px] text-muted-foreground leading-tight">
              Enter your URL, or leave empty to auto-generate.
            </p>
            <div className="relative">
              <Input
                value={subdomain}
                onChange={(e) => {
                  // Only allow lowercase alphanumeric and hyphens
                  const value = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "")
                  setSubdomain(value)
                }}
                placeholder="my-project"
                className={cn(
                  "h-8 text-sm pr-8",
                  subdomainStatus.available === false && "border-red-500 focus-visible:ring-red-500",
                  subdomainStatus.available === true && subdomain !== currentSubdomain && "border-emerald-500 focus-visible:ring-emerald-500"
                )}
              />
              {/* Status indicator */}
              <div className="absolute right-2 top-1/2 -translate-y-1/2">
                {subdomainStatus.checking && (
                  <Loader2 className="h-4 w-4 text-muted-foreground animate-spin" />
                )}
                {!subdomainStatus.checking && subdomainStatus.available === true && subdomain !== currentSubdomain && (
                  <CheckCircle className="h-4 w-4 text-emerald-500" />
                )}
                {!subdomainStatus.checking && subdomainStatus.available === false && (
                  <XCircle className="h-4 w-4 text-red-500" />
                )}
              </div>
            </div>
            <div className="flex items-center justify-between">
              <p className="text-[11px] text-muted-foreground">
                {subdomain || "your-subdomain"}.shogo.ai
              </p>
              {subdomainStatus.available === false && subdomainStatus.reason && (
                <p className="text-[11px] text-red-500">{subdomainStatus.reason}</p>
              )}
            </div>
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
                      onClick={() => handleAccessChange(key)}
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
                    value={siteTitle}
                    onChange={(e) => setSiteTitle(e.target.value)}
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
                    value={siteDescription}
                    onChange={(e) => setSiteDescription(e.target.value)}
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
          {isPublished ? (
            <>
              <Button
                variant="outline"
                size="sm"
                className="flex-1 h-8 text-xs text-red-600 hover:text-red-700 hover:bg-red-50"
                onClick={handleUnpublish}
                disabled={isUnpublishing}
              >
                {isUnpublishing ? "Unpublishing..." : "Unpublish"}
              </Button>
              {isSubdomainModified && (
                <Button
                  size="sm"
                  className="flex-1 h-8 text-xs bg-primary hover:bg-primary/90"
                  onClick={handlePublish}
                  disabled={!canPublish}
                >
                  {isPublishing ? "Updating..." : "Update URL"}
                </Button>
              )}
            </>
          ) : (
            <>
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
                disabled={!canPublish}
              >
                {isPublishing ? "Publishing..." : "Publish"}
              </Button>
            </>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
