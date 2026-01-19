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
}

export function RuntimePreviewPanel({
  projectId,
  className,
  onError,
  onLoad,
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

  /**
   * Fetch sandbox URL from API, which starts the runtime if needed.
   */
  const fetchSandboxUrl = useCallback(async () => {
    setIsLoading(true)
    setError(null)

    try {
      const response = await fetch(`/api/projects/${projectId}/sandbox/url`)
      const data: SandboxUrlResponse = await response.json()

      if (!response.ok) {
        const errorMessage = data.error?.message || 'Failed to get sandbox URL'
        setError(errorMessage)
        onError?.(new Error(errorMessage))
        return
      }

      setSandboxUrl(data.url)
      setSandboxAttributes(data.sandbox)
      setStatus(data.status)
      retryCountRef.current = 0

    } catch (err: any) {
      const errorMessage = err.message || 'Failed to connect to runtime'
      setError(errorMessage)
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
   * Retry loading the runtime.
   */
  const handleRetry = useCallback(() => {
    retryCountRef.current += 1
    setIframeLoaded(false)
    setHmrConnected(false)
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

  // Fetch sandbox URL on mount
  useEffect(() => {
    fetchSandboxUrl()
  }, [fetchSandboxUrl])

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

  // Stop runtime on unmount
  useEffect(() => {
    return () => {
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
