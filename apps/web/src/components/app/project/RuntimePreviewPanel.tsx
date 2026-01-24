/**
 * RuntimePreviewPanel - Sandboxed iframe for project runtime preview
 *
 * Renders the project's Vite dev server in a sandboxed iframe with:
 * - Loading state while runtime starts
 * - Error state with retry capability
 * - HMR connection status indicator
 * - Responsive sizing to fill container
 */

import { useState, useEffect, useCallback, useRef } from "react"
import { Loader2, AlertCircle, Wifi, WifiOff, RefreshCw } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * Runtime status from API response
 */
type RuntimeStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'error'

/**
 * Sandbox URL response from API
 */
interface SandboxUrlResponse {
  url: string
  directUrl: string
  sandbox: string
  status: RuntimeStatus
  error?: {
    code: string
    message: string
  }
}

export interface RuntimePreviewPanelProps {
  /** Project ID to load runtime for */
  projectId: string
  /** Additional CSS classes */
  className?: string
  /** Callback when runtime encounters an error */
  onError?: (error: Error) => void
  /** Callback when runtime successfully loads */
  onLoad?: () => void
  /** Trigger to refresh the preview (increment to refresh) */
  refreshTrigger?: number
}

export function RuntimePreviewPanel({
  projectId,
  className,
  onError,
  onLoad,
  refreshTrigger = 0,
}: RuntimePreviewPanelProps) {
  const [sandboxUrl, setSandboxUrl] = useState<string | null>(null)
  const [sandboxAttributes, setSandboxAttributes] = useState<string>('')
  const [status, setStatus] = useState<RuntimeStatus>('stopped')
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hmrConnected, setHmrConnected] = useState(false)
  const [iframeLoaded, setIframeLoaded] = useState(false)

  const iframeRef = useRef<HTMLIFrameElement>(null)
  const retryCountRef = useRef(0)
  const maxAutoRetries = 10
  const autoRetryTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  /**
   * Fetch sandbox URL from API, which starts the runtime if needed.
   * Includes auto-retry for transient errors during project setup.
   */
  const fetchSandboxUrl = useCallback(async (isAutoRetry = false) => {
    setIsLoading(true)
    if (!isAutoRetry) {
      setError(null)
    }

    try {
      const response = await fetch(`/api/projects/${projectId}/sandbox/url`)
      const data: SandboxUrlResponse = await response.json()

      if (!response.ok) {
        const errorCode = data.error?.code || ''
        const errorMessage = data.error?.message || 'Failed to get sandbox URL'
        
        // Check if this is a transient error that should be auto-retried
        const isTransientError = 
          errorCode === 'pod_unavailable' ||
          errorCode === 'project_not_found' ||
          errorMessage.includes('not found') ||
          errorMessage.includes('starting') ||
          errorMessage.includes('unavailable') ||
          response.status === 503 ||
          response.status === 502

        if (isTransientError && retryCountRef.current < maxAutoRetries) {
          retryCountRef.current += 1
          const delay = Math.min(1000 * retryCountRef.current, 5000) // Exponential backoff, max 5s
          
          // Only show loading state, don't set error for auto-retries
          if (retryCountRef.current > 3) {
            console.debug(`[RuntimePreviewPanel] Runtime not ready, auto-retrying (${retryCountRef.current}/${maxAutoRetries})...`)
          }
          
          autoRetryTimeoutRef.current = setTimeout(() => {
            fetchSandboxUrl(true)
          }, delay)
          return
        }

        setError(errorMessage)
        return
      }

      setSandboxUrl(data.url)
      setSandboxAttributes(data.sandbox)
      setStatus(data.status)
      retryCountRef.current = 0

    } catch (err: any) {
      const errorMessage = err.message || 'Failed to connect to runtime'
      
      // Auto-retry network errors during setup
      if (retryCountRef.current < maxAutoRetries) {
        retryCountRef.current += 1
        const delay = Math.min(1000 * retryCountRef.current, 5000)
        
        if (retryCountRef.current > 3) {
          console.debug(`[RuntimePreviewPanel] Network error, auto-retrying (${retryCountRef.current}/${maxAutoRetries})...`)
        }
        
        autoRetryTimeoutRef.current = setTimeout(() => {
          fetchSandboxUrl(true)
        }, delay)
        return
      }

      setError(errorMessage)
    } finally {
      setIsLoading(false)
    }
  }, [projectId]) // Intentionally omit onError to prevent re-renders from inline callbacks

  /**
   * Handle iframe load event.
   */
  const handleIframeLoad = useCallback(() => {
    setIframeLoaded(true)
    setIsLoading(false)

    // Check HMR connection status
    // Vite creates a WebSocket connection for HMR
    if (iframeRef.current?.contentWindow) {
      // HMR status will be updated via postMessage from the iframe
      // For now, assume connected if iframe loaded successfully
      setHmrConnected(true)
    }

    onLoad?.()
  }, [onLoad])

  /**
   * Handle iframe error.
   */
  const handleIframeError = useCallback(() => {
    setError('Failed to load project preview')
    setIsLoading(false)
    setHmrConnected(false)
    onError?.(new Error('Failed to load project preview'))
  }, [onError])

  /**
   * Retry loading the runtime (manual retry resets auto-retry counter).
   */
  const handleRetry = useCallback(() => {
    // Clear any pending auto-retry
    if (autoRetryTimeoutRef.current) {
      clearTimeout(autoRetryTimeoutRef.current)
    }
    retryCountRef.current = 0 // Reset counter for manual retry
    setIframeLoaded(false)
    setHmrConnected(false)
    setError(null)
    fetchSandboxUrl()
  }, [fetchSandboxUrl])

  /**
   * Refresh the iframe without restarting runtime.
   */
  const handleRefresh = useCallback(() => {
    if (iframeRef.current && sandboxUrl) {
      setIframeLoaded(false)
      setIsLoading(true)
      // Force reload by toggling src
      iframeRef.current.src = ''
      setTimeout(() => {
        if (iframeRef.current) {
          iframeRef.current.src = sandboxUrl
        }
      }, 50)
    }
  }, [sandboxUrl])

  // Fetch sandbox URL on mount and when projectId changes
  useEffect(() => {
    // Reset state
    retryCountRef.current = 0
    setError(null)
    setSandboxUrl(null)
    
    fetchSandboxUrl()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]) // Only depend on projectId, not fetchSandboxUrl

  // Track previous refreshTrigger to detect changes
  const prevRefreshTriggerRef = useRef(refreshTrigger)

  // Auto-refresh when refreshTrigger changes (triggered by agent file modifications)
  // task-preview-autorefresh-fix: Multi-stage refresh for reliability after template operations
  useEffect(() => {
    if (refreshTrigger !== prevRefreshTriggerRef.current && sandboxUrl) {
      prevRefreshTriggerRef.current = refreshTrigger
      console.log('[RuntimePreviewPanel] Auto-refreshing preview due to file changes')
      
      // Stage 1: Initial refresh after Vite detects changes (2s)
      // This handles most file modifications
      const timer1 = setTimeout(() => {
        console.log('[RuntimePreviewPanel] Stage 1 refresh')
        handleRefresh()
      }, 2000)
      
      // Stage 2: Follow-up refresh for template_copy operations (5s)
      // Template operations may cause Vite to rebuild which invalidates the first load
      // This catches "Failed to fetch dynamically imported module" errors
      const timer2 = setTimeout(() => {
        console.log('[RuntimePreviewPanel] Stage 2 refresh (template fallback)')
        handleRefresh()
      }, 5000)
      
      return () => {
        clearTimeout(timer1)
        clearTimeout(timer2)
      }
    }
  }, [refreshTrigger, sandboxUrl, handleRefresh])

  // Listen for HMR status messages from iframe
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // Validate origin matches our sandbox URL
      if (sandboxUrl && event.origin !== new URL(sandboxUrl).origin) {
        return
      }

      // Handle HMR status messages (custom protocol)
      if (event.data?.type === 'shogo:hmr-status') {
        setHmrConnected(event.data.connected)
      }
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [sandboxUrl])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      // Clear any pending auto-retry timeouts
      if (autoRetryTimeoutRef.current) {
        clearTimeout(autoRetryTimeoutRef.current)
      }
      // Fire-and-forget stop request on unmount
      fetch(`/api/projects/${projectId}/runtime/stop`, { method: 'POST' })
        .catch(() => {}) // Ignore errors on unmount
    }
  }, [projectId])

  // Error state
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
              Runtime Error
            </h3>
            <p className="text-sm text-muted-foreground mt-1">
              {error}
            </p>
          </div>
          <button
            onClick={handleRetry}
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
  if (isLoading && !sandboxUrl) {
    return (
      <div className={cn(
        "flex flex-col items-center justify-center h-full w-full bg-muted/30",
        className
      )}>
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-8 w-8 text-primary animate-spin" />
          <div className="text-sm text-muted-foreground">
            Starting project runtime...
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={cn("relative h-full w-full", className)}>
      {/* HMR Status Indicator */}
      <div className="absolute top-2 right-2 z-10 flex items-center gap-2">
        <div
          className={cn(
            "flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium transition-colors",
            hmrConnected
              ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
              : "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
          )}
          title={hmrConnected ? "HMR Connected" : "HMR Disconnected"}
        >
          {hmrConnected ? (
            <Wifi className="h-3 w-3" />
          ) : (
            <WifiOff className="h-3 w-3" />
          )}
          {hmrConnected ? "Live" : "Disconnected"}
        </div>
        <button
          onClick={handleRefresh}
          className="p-1.5 rounded-full bg-muted/80 hover:bg-muted transition-colors"
          title="Refresh preview"
        >
          <RefreshCw className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      </div>

      {/* Loading overlay while iframe loads */}
      {(isLoading || !iframeLoaded) && sandboxUrl && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/80 z-5">
          <div className="flex flex-col items-center gap-2">
            <Loader2 className="h-6 w-6 text-primary animate-spin" />
            <span className="text-xs text-muted-foreground">Loading preview...</span>
          </div>
        </div>
      )}

      {/* Sandbox iframe */}
      {sandboxUrl && (
        <iframe
          ref={iframeRef}
          src={sandboxUrl}
          sandbox={sandboxAttributes}
          className="h-full w-full border-0"
          onLoad={handleIframeLoad}
          onError={handleIframeError}
          title={`Project Preview - ${projectId}`}
          allow="clipboard-read; clipboard-write"
        />
      )}
    </div>
  )
}

export default RuntimePreviewPanel
