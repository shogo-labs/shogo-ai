/**
 * DatabasePanel - Embedded Prisma Studio for database management
 *
 * Renders Prisma Studio in an iframe with:
 * - Loading state while Prisma Studio starts
 * - Error state if no Prisma schema exists
 * - Refresh capability
 * - Theme matching via CSS filters (Prisma Studio uses system theme,
 *   so we apply filters to match our app's dark/light mode)
 */

import { useState, useEffect, useCallback, useRef } from "react"
import { Loader2, AlertCircle, Database, RefreshCw, ExternalLink } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * Hook to detect dark mode from document.documentElement.classList
 * Uses MutationObserver to react to theme changes
 */
function useIsDarkMode(): boolean {
  const [isDark, setIsDark] = useState(() =>
    document.documentElement.classList.contains("dark")
  )

  useEffect(() => {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.attributeName === "class") {
          setIsDark(document.documentElement.classList.contains("dark"))
        }
      }
    })

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    })

    return () => observer.disconnect()
  }, [])

  return isDark
}

/**
 * Database status from API response
 */
interface DatabaseStatus {
  status: 'starting' | 'running' | 'stopped' | 'error'
  url: string | null
  hasPrisma?: boolean
  error?: {
    code: string
    message: string
  }
}

export interface DatabasePanelProps {
  /** Project ID to load database for */
  projectId: string
  /** Additional CSS classes */
  className?: string
  /** Callback when database encounters an error */
  onError?: (error: Error) => void
  /** Callback when database successfully loads */
  onLoad?: () => void
}

export function DatabasePanel({
  projectId,
  className,
  onError,
  onLoad,
}: DatabasePanelProps) {
  const [studioUrl, setStudioUrl] = useState<string | null>(null)
  const [status, setStatus] = useState<'starting' | 'running' | 'stopped' | 'error'>('stopped')
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [iframeLoaded, setIframeLoaded] = useState(false)

  const iframeRef = useRef<HTMLIFrameElement>(null)
  const isDarkMode = useIsDarkMode()

  /**
   * Fetch Prisma Studio URL from API, which starts it if needed.
   */
  const fetchStudioUrl = useCallback(async () => {
    setIsLoading(true)
    setError(null)

    try {
      const response = await fetch(`/api/projects/${projectId}/database/url`)
      const data: DatabaseStatus = await response.json()

      if (!response.ok) {
        const errorMessage = data.error?.message || 'Failed to start Prisma Studio'
        setError(errorMessage)
        setStatus('error')
        onError?.(new Error(errorMessage))
        return
      }

      setStudioUrl(data.url)
      setStatus(data.status)

    } catch (err: any) {
      const errorMessage = err.message || 'Failed to connect to database service'
      setError(errorMessage)
      setStatus('error')
      onError?.(new Error(errorMessage))
    } finally {
      setIsLoading(false)
    }
  }, [projectId, onError])

  /**
   * Handle iframe load event.
   */
  const handleIframeLoad = useCallback(() => {
    setIframeLoaded(true)
    setIsLoading(false)
    onLoad?.()
  }, [onLoad])

  /**
   * Handle iframe error.
   */
  const handleIframeError = useCallback(() => {
    setError('Failed to load Prisma Studio')
    setIsLoading(false)
    onError?.(new Error('Failed to load Prisma Studio'))
  }, [onError])

  /**
   * Refresh Prisma Studio.
   */
  const handleRefresh = useCallback(() => {
    if (iframeRef.current && studioUrl) {
      setIframeLoaded(false)
      setIsLoading(true)
      // Force reload by toggling src
      iframeRef.current.src = ''
      setTimeout(() => {
        if (iframeRef.current) {
          iframeRef.current.src = studioUrl
        }
      }, 50)
    }
  }, [studioUrl])

  /**
   * Open Prisma Studio in new tab
   */
  const handleOpenExternal = useCallback(() => {
    if (studioUrl) {
      window.open(studioUrl, '_blank')
    }
  }, [studioUrl])

  // Fetch studio URL on mount
  useEffect(() => {
    fetchStudioUrl()

    // Cleanup: stop Prisma Studio when component unmounts
    return () => {
      fetch(`/api/projects/${projectId}/database/stop`, { method: 'POST' })
        .catch(() => {}) // Ignore errors on unmount
    }
  }, [fetchStudioUrl, projectId])

  // Error state - no Prisma schema
  if (error && error.includes('No Prisma schema')) {
    return (
      <div className={cn(
        "flex flex-col items-center justify-center h-full w-full bg-muted/30",
        className
      )}>
        <div className="flex flex-col items-center gap-4 p-8 max-w-md text-center">
          <Database className="h-12 w-12 text-muted-foreground" />
          <div>
            <h3 className="text-lg font-semibold text-foreground">
              No Database Schema
            </h3>
            <p className="text-sm text-muted-foreground mt-1">
              This project doesn't have a Prisma schema yet. Use a template or create a{' '}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">prisma/schema.prisma</code>{' '}
              file to get started.
            </p>
          </div>
        </div>
      </div>
    )
  }

  // Error state - other errors
  if (error) {
    return (
      <div className={cn(
        "flex flex-col items-center justify-center h-full w-full bg-muted/30",
        className
      )}>
        <div className="flex flex-col items-center gap-4 p-8 max-w-md text-center">
          <AlertCircle className="h-12 w-12 text-destructive" />
          <div>
            <h3 className="text-lg font-semibold text-foreground">
              Database Error
            </h3>
            <p className="text-sm text-muted-foreground mt-1">
              {error}
            </p>
          </div>
          <button
            onClick={fetchStudioUrl}
            className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
          >
            <RefreshCw className="h-4 w-4" />
            Retry
          </button>
        </div>
      </div>
    )
  }

  // Loading state
  if (isLoading && !studioUrl) {
    return (
      <div className={cn(
        "flex flex-col items-center justify-center h-full w-full bg-muted/30",
        className
      )}>
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-8 w-8 text-primary animate-spin" />
          <div className="text-sm text-muted-foreground">
            Starting Prisma Studio...
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={cn("relative h-full w-full", className)}>
      {/* Toolbar */}
      <div className="absolute top-2 right-2 z-10 flex items-center gap-2">
        <button
          onClick={handleOpenExternal}
          className="p-1.5 rounded-full bg-muted/80 hover:bg-muted transition-colors"
          title="Open in new tab"
        >
          <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
        <button
          onClick={handleRefresh}
          className="p-1.5 rounded-full bg-muted/80 hover:bg-muted transition-colors"
          title="Refresh"
        >
          <RefreshCw className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      </div>

      {/* Loading overlay while iframe loads */}
      {(isLoading || !iframeLoaded) && studioUrl && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/80 z-5">
          <div className="flex flex-col items-center gap-2">
            <Loader2 className="h-6 w-6 text-primary animate-spin" />
            <span className="text-xs text-muted-foreground">Loading Prisma Studio...</span>
          </div>
        </div>
      )}

      {/* Prisma Studio iframe */}
      {/* Apply CSS filter in dark mode to match app theme since Prisma Studio
          uses system theme and can't be controlled via postMessage */}
      {studioUrl && (
        <iframe
          ref={iframeRef}
          src={studioUrl}
          className={cn(
            "h-full w-full border-0 transition-[filter] duration-200",
            isDarkMode && "invert hue-rotate-180 [&_img]:invert [&_img]:hue-rotate-180"
          )}
          style={isDarkMode ? {
            filter: "invert(0.92) hue-rotate(180deg)",
          } : undefined}
          onLoad={handleIframeLoad}
          onError={handleIframeError}
          title={`Database - ${projectId}`}
        />
      )}
    </div>
  )
}

export default DatabasePanel
