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

/**
 * Known permanent error codes that should NOT be retried.
 */
const PERMANENT_ERROR_CODES = new Set([
  'not_supported',
])

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
  const retryCountRef = useRef(0)
  const maxAutoRetries = 10
  const autoRetryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Track if we've already determined there's no Prisma schema
  // This prevents repeated API calls for projects without Prisma
  const noPrismaSchemaRef = useRef(false)

  /**
   * Fetch Prisma Studio URL from API, which starts it if needed.
   * Includes auto-retry for transient errors during project setup.
   * 
   * NOTE: This callback intentionally omits onError from deps to prevent
   * unnecessary re-renders when parent passes inline callbacks.
   */
  const fetchStudioUrl = useCallback(async (isAutoRetry = false) => {
    // Skip if we already know there's no Prisma schema
    if (noPrismaSchemaRef.current) {
      return
    }

    setIsLoading(true)
    if (!isAutoRetry) {
      setError(null)
    }

    try {
      const response = await fetch(`/api/projects/${projectId}/database/url`)
      const data: DatabaseStatus = await response.json()

      // Extract error info from response body (works for both ok and non-ok responses)
      const errorCode = data.error?.code || ''
      const errorMessage = data.error?.message || ''

      // Check for errors: either HTTP error OR body contains error field OR URL is null
      const hasError = !response.ok || data.error || !data.url

      if (hasError) {
        const displayMessage = errorMessage || 'Failed to start Prisma Studio'

        // "No Prisma schema" is a permanent state - don't retry
        if (displayMessage.includes('No Prisma schema') || errorCode === 'no_prisma_schema') {
          noPrismaSchemaRef.current = true
          setError(displayMessage)
          setStatus('error')
          setIsLoading(false)
          return
        }

        // Permanent errors that should NOT be retried
        if (PERMANENT_ERROR_CODES.has(errorCode)) {
          setError(displayMessage)
          setStatus('error')
          setIsLoading(false)
          return
        }

        // Check if this is a transient error that should be auto-retried
        const isTransientError = 
          errorCode === 'project_not_found' ||
          errorCode === 'pod_unavailable' ||
          errorCode === 'pod_starting' ||
          errorCode === 'pod_timeout' ||
          displayMessage.includes('not found') ||
          displayMessage.includes('starting') ||
          displayMessage.includes('unavailable') ||
          response.status === 504 ||  // Gateway Timeout - pod starting
          response.status === 503 ||
          response.status === 502

        if (isTransientError && retryCountRef.current < maxAutoRetries) {
          retryCountRef.current += 1
          const delay = Math.min(1000 * retryCountRef.current, 5000) // Exponential backoff, max 5s
          
          // Only show loading state, don't set error for auto-retries
          if (retryCountRef.current > 3) {
            // Only log after several attempts to reduce noise
            console.debug(`[DatabasePanel] Project not ready, retrying (${retryCountRef.current}/${maxAutoRetries})...`)
          }
          
          setIsLoading(true)
          autoRetryTimeoutRef.current = setTimeout(() => {
            fetchStudioUrl(true)
          }, delay)
          return
        }

        // After max retries or non-transient error, show error state
        setError(displayMessage)
        setStatus('error')
        setIsLoading(false)
        return
      }

      // Success - reset retry count and set the studio URL
      retryCountRef.current = 0
      setStudioUrl(data.url)
      setStatus(data.status)
      setIsLoading(false)

    } catch (err: any) {
      const errorMessage = err.message || 'Failed to connect to database service'
      
      // Network errors can also be transient
      if (retryCountRef.current < maxAutoRetries) {
        retryCountRef.current += 1
        const delay = Math.min(1000 * retryCountRef.current, 5000)
        
        autoRetryTimeoutRef.current = setTimeout(() => {
          fetchStudioUrl(true)
        }, delay)
        return
      }

      setError(errorMessage)
      setStatus('error')
      setIsLoading(false)
    }
  }, [projectId]) // Intentionally omit onError to prevent re-renders

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

  // Fetch studio URL on mount and when projectId changes
  useEffect(() => {
    // Reset state when projectId changes
    retryCountRef.current = 0
    noPrismaSchemaRef.current = false
    setError(null)
    setStudioUrl(null)
    setIframeLoaded(false)
    
    fetchStudioUrl()

    // Cleanup: stop Prisma Studio and clear any pending retries when component unmounts
    return () => {
      if (autoRetryTimeoutRef.current) {
        clearTimeout(autoRetryTimeoutRef.current)
      }
      // Only call stop if we actually started something (had a URL)
      // Don't call if there's no Prisma schema - nothing to stop
      if (!noPrismaSchemaRef.current) {
        fetch(`/api/projects/${projectId}/database/stop`, { method: 'POST' })
          .catch(() => {}) // Ignore errors on unmount
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]) // Only depend on projectId, not fetchStudioUrl

  // Iframe load timeout - if iframe doesn't load within 20s, show error
  useEffect(() => {
    if (!studioUrl || iframeLoaded) return

    const timeout = setTimeout(() => {
      if (!iframeLoaded) {
        setError('Prisma Studio took too long to load. The database service may be unavailable.')
        setIsLoading(false)
      }
    }, 20000)

    return () => clearTimeout(timeout)
  }, [studioUrl, iframeLoaded])

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
            onClick={() => {
              retryCountRef.current = 0
              noPrismaSchemaRef.current = false
              setError(null)
              setStudioUrl(null)
              setIframeLoaded(false)
              fetchStudioUrl()
            }}
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

  // Fallback state - not loading, no error, but no studio URL either
  // This prevents the blank page that was previously shown
  if (!studioUrl) {
    return (
      <div className={cn(
        "flex flex-col items-center justify-center h-full w-full bg-muted/30",
        className
      )}>
        <div className="flex flex-col items-center gap-4 p-8 max-w-md text-center">
          <Database className="h-12 w-12 text-muted-foreground" />
          <div>
            <h3 className="text-lg font-semibold text-foreground">
              Database Unavailable
            </h3>
            <p className="text-sm text-muted-foreground mt-1">
              Could not connect to the database service. The project may still be starting up.
            </p>
          </div>
          <button
            onClick={() => {
              retryCountRef.current = 0
              noPrismaSchemaRef.current = false
              setError(null)
              setStudioUrl(null)
              setIframeLoaded(false)
              fetchStudioUrl()
            }}
            className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
          >
            <RefreshCw className="h-4 w-4" />
            Retry
          </button>
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
