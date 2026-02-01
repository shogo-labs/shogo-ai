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
import { Loader2, AlertCircle, RefreshCw } from "lucide-react"
import { cn } from "@/lib/utils"
import { VIEWPORT_SIZES, type ViewportSize } from "./PreviewControls"

/**
 * Runtime status from API response
 */
type RuntimeStatus = 'not_found' | 'creating' | 'starting' | 'running' | 'stopping' | 'stopped' | 'error'

/**
 * Runtime status response from /runtime/status endpoint
 */
interface RuntimeStatusResponse {
  projectId: string
  status: RuntimeStatus
  message?: string
  ready: boolean
  replicas?: number
  url?: string
}

/**
 * Sandbox URL response from API
 */
interface SandboxUrlResponse {
  url: string
  directUrl?: string
  sandbox: string
  status: RuntimeStatus
  ready: boolean
  message?: string
  error?: {
    code: string
    message: string
    retryable?: boolean
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
  /** Viewport size for responsive preview */
  viewport?: ViewportSize
}

export function RuntimePreviewPanel({
  projectId,
  className,
  onError,
  onLoad,
  refreshTrigger = 0,
  viewport = "desktop",
}: RuntimePreviewPanelProps) {
  const [sandboxUrl, setSandboxUrl] = useState<string | null>(null)
  const [sandboxAttributes, setSandboxAttributes] = useState<string>('')
  const [status, setStatus] = useState<RuntimeStatus>('stopped')
  const [statusMessage, setStatusMessage] = useState<string>('Initializing...')
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [iframeLoaded, setIframeLoaded] = useState(false)
  const [pollCount, setPollCount] = useState(0) // Track polls for progress bar
  const [isRebuilding, setIsRebuilding] = useState(false) // Track rebuild state for smooth overlay

  const iframeRef = useRef<HTMLIFrameElement>(null)
  const retryCountRef = useRef(0)
  const maxAutoRetries = 60 // Allow up to 60 polls (3 minutes at 3s intervals)
  const autoRetryTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const statusPollIntervalRef = useRef<NodeJS.Timeout | null>(null)

  /**
   * Poll runtime status to check if pod is ready.
   * This is lightweight and doesn't create/wait for pods.
   */
  const pollRuntimeStatus = useCallback(async (): Promise<RuntimeStatusResponse | null> => {
    try {
      const response = await fetch(`/api/projects/${projectId}/runtime/status`)
      if (!response.ok) {
        return null
      }
      return await response.json()
    } catch {
      return null
    }
  }, [projectId])

  /**
   * Start the runtime initialization flow:
   * 1. Check current status with lightweight /runtime/status
   * 2. If not ready, trigger creation with /sandbox/url?wait=false and poll status
   * 3. Once ready, get the full sandbox URL
   */
  const initializeRuntime = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    retryCountRef.current = 0
    setPollCount(0) // Reset poll count for progress bar

    // Clear any existing poll interval
    if (statusPollIntervalRef.current) {
      clearInterval(statusPollIntervalRef.current)
      statusPollIntervalRef.current = null
    }

    try {
      // Step 1: Check current status
      const initialStatus = await pollRuntimeStatus()
      
      if (initialStatus?.ready) {
        // Pod is already running - get sandbox URL immediately
        setStatus('running')
        setStatusMessage('Runtime ready')
        await fetchSandboxUrlOnce()
        return
      }

      // Step 2: Pod not ready - trigger creation (non-blocking)
      setStatus(initialStatus?.status || 'creating')
      setStatusMessage(initialStatus?.message || 'Creating project runtime...')
      
      // Trigger pod creation in background
      fetch(`/api/projects/${projectId}/sandbox/url?wait=false`).catch(() => {})

      // Step 3: Poll status until ready
      let currentPollCount = 0
      const maxPolls = maxAutoRetries
      const pollInterval = 3000 // 3 seconds

      const doPoll = async () => {
        currentPollCount++
        setPollCount(currentPollCount) // Update state for progress bar
        const status = await pollRuntimeStatus()

        if (status?.ready) {
          // Pod is ready - get sandbox URL
          if (statusPollIntervalRef.current) {
            clearInterval(statusPollIntervalRef.current)
            statusPollIntervalRef.current = null
          }
          setStatus('running')
          setStatusMessage('Runtime ready')
          await fetchSandboxUrlOnce()
          return
        }

        // Update status message
        if (status) {
          setStatus(status.status)
          const progressMsg = getProgressMessage(status.status, currentPollCount)
          setStatusMessage(status.message || progressMsg)
        }

        // Check if we've exceeded max polls
        if (currentPollCount >= maxPolls) {
          if (statusPollIntervalRef.current) {
            clearInterval(statusPollIntervalRef.current)
            statusPollIntervalRef.current = null
          }
          setError('Runtime startup timed out. Please try again.')
          setIsLoading(false)
        }
      }

      // Initial poll
      await doPoll()

      // Continue polling if not ready
      if (!sandboxUrl) {
        statusPollIntervalRef.current = setInterval(doPoll, pollInterval)
      }

    } catch (err: any) {
      setError(err.message || 'Failed to initialize runtime')
      setIsLoading(false)
    }
  }, [projectId, pollRuntimeStatus])

  /**
   * Get a user-friendly progress message based on status
   */
  const getProgressMessage = (status: RuntimeStatus, pollCount: number): string => {
    const elapsed = pollCount * 3 // Approximate seconds
    switch (status) {
      case 'not_found':
        return 'Creating project environment...'
      case 'creating':
        if (elapsed < 15) return 'Creating project pod...'
        if (elapsed < 30) return 'Setting up environment...'
        if (elapsed < 60) return 'Installing dependencies...'
        return 'Almost ready...'
      case 'starting':
        if (elapsed < 30) return 'Starting runtime server...'
        if (elapsed < 60) return 'Building project...'
        return 'Finalizing startup...'
      default:
        return 'Preparing runtime...'
    }
  }

  /**
   * Fetch sandbox URL once (after runtime is ready).
   * Uses the blocking version since we know the pod is ready.
   */
  const fetchSandboxUrlOnce = useCallback(async () => {
    try {
      const response = await fetch(`/api/projects/${projectId}/sandbox/url`)
      const data: SandboxUrlResponse = await response.json()

      if (!response.ok || !data.ready) {
        // Shouldn't happen if we polled correctly, but handle gracefully
        const errorMessage = data.error?.message || 'Failed to get sandbox URL'
        if (data.error?.retryable) {
          // Restart the polling loop
          retryCountRef.current++
          if (retryCountRef.current < 3) {
            autoRetryTimeoutRef.current = setTimeout(() => {
              initializeRuntime()
            }, 2000)
            return
          }
        }
        setError(errorMessage)
        return
      }

      setSandboxUrl(data.url)
      setSandboxAttributes(data.sandbox)
      setStatus('running')
      retryCountRef.current = 0

    } catch (err: any) {
      setError(err.message || 'Failed to connect to runtime')
    } finally {
      setIsLoading(false)
    }
  }, [projectId, initializeRuntime])

  // Legacy function for backwards compatibility with retry button
  const fetchSandboxUrl = initializeRuntime

  /**
   * Handle iframe load event.
   */
  const handleIframeLoad = useCallback(() => {
    setIframeLoaded(true)
    setIsLoading(false)
    setIsRebuilding(false) // Clear rebuild state when new content loads
    onLoad?.()
  }, [onLoad])

  /**
   * Handle iframe error.
   */
  const handleIframeError = useCallback(() => {
    setError('Failed to load project preview')
    setIsLoading(false)
    setIsRebuilding(false)
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
    setIsRebuilding(false)
    setError(null)
    fetchSandboxUrl()
  }, [fetchSandboxUrl])

  /**
   * Refresh the iframe without restarting runtime.
   * Uses cache-busting timestamp to force browser to reload.
   * Shows smooth loading state without flickering.
   */
  const handleRefresh = useCallback(() => {
    if (iframeRef.current && sandboxUrl) {
      setIframeLoaded(false)
      setIsRebuilding(true) // Use rebuild state for smooth overlay
      // Add cache-busting timestamp to force reload
      const cacheBuster = Date.now()
      const separator = sandboxUrl.includes('?') ? '&' : '?'
      iframeRef.current.src = `${sandboxUrl}${separator}_t=${cacheBuster}`
    }
  }, [sandboxUrl])

  // Initialize runtime on mount and when projectId changes
  useEffect(() => {
    // Reset state
    retryCountRef.current = 0
    setError(null)
    setSandboxUrl(null)
    setStatus('stopped')
    setStatusMessage('Initializing...')
    setIframeLoaded(false)
    
    // Clear any existing intervals
    if (statusPollIntervalRef.current) {
      clearInterval(statusPollIntervalRef.current)
      statusPollIntervalRef.current = null
    }
    if (autoRetryTimeoutRef.current) {
      clearTimeout(autoRetryTimeoutRef.current)
      autoRetryTimeoutRef.current = null
    }
    
    initializeRuntime()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]) // Only depend on projectId, not initializeRuntime

  // Track previous refreshTrigger to detect changes
  const prevRefreshTriggerRef = useRef(refreshTrigger)
  const isRebuildingRef = useRef(false)
  // Track if a refresh was requested while sandboxUrl wasn't ready
  // This handles the case where template.copy completes before runtime is ready
  const pendingRefreshRef = useRef(false)

  /**
   * Trigger a rebuild of the project and refresh the preview smoothly.
   * Shows a loading overlay while keeping previous content visible (no flickering).
   */
  const triggerRebuild = useCallback(async () => {
    if (isRebuildingRef.current) {
      console.log('[RuntimePreviewPanel] Rebuild already in progress, skipping')
      return
    }

    isRebuildingRef.current = true
    setIsRebuilding(true)
    setStatusMessage('Updating preview...')

    try {
      console.log('[RuntimePreviewPanel] Triggering project rebuild...')
      // Force rebuild since code was modified by the agent
      const response = await fetch(`/api/projects/${projectId}/runtime/restart?force=true`, {
        method: 'POST',
      })

      if (response.ok) {
        const result = await response.json()
        console.log('[RuntimePreviewPanel] Rebuild complete:', result)
        
        // Wait for server to be ready
        await new Promise(resolve => setTimeout(resolve, 2000))
      } else {
        console.warn('[RuntimePreviewPanel] Rebuild failed, but will still try to refresh')
      }
    } catch (err) {
      console.error('[RuntimePreviewPanel] Rebuild error:', err)
    }
    
    // Refresh with cache-buster after rebuild
    // Note: isRebuilding state will be cleared by handleIframeLoad
    if (iframeRef.current && sandboxUrl) {
      setIframeLoaded(false)
      const cacheBuster = Date.now()
      const separator = sandboxUrl.includes('?') ? '&' : '?'
      console.log('[RuntimePreviewPanel] Refreshing preview with cache-buster:', cacheBuster)
      iframeRef.current.src = `${sandboxUrl}${separator}_t=${cacheBuster}`
    } else {
      // No iframe to refresh, clear states
      setIsRebuilding(false)
      setStatusMessage('')
    }
    
    isRebuildingRef.current = false
  }, [projectId, sandboxUrl])

  // Auto-refresh when refreshTrigger changes (triggered by agent file modifications)
  // This triggers a full rebuild since the preview serves static files
  useEffect(() => {
    if (refreshTrigger !== prevRefreshTriggerRef.current && sandboxUrl) {
      prevRefreshTriggerRef.current = refreshTrigger
      console.log('[RuntimePreviewPanel] Files changed, triggering rebuild...')
      
      // Debounce: wait a moment for multiple file changes to settle
      const timer = setTimeout(() => {
        triggerRebuild()
      }, 1500)
      
      return () => {
        clearTimeout(timer)
      }
    }
  }, [refreshTrigger, sandboxUrl, triggerRebuild])

  // Auto-clear rebuild state if it takes too long (timeout safety)
  useEffect(() => {
    if (isRebuilding) {
      const timeout = setTimeout(() => {
        console.warn('[RuntimePreviewPanel] Rebuild timeout, clearing state')
        setIsRebuilding(false)
        setStatusMessage('')
      }, 30000) // 30 second timeout

      return () => clearTimeout(timeout)
    }
  }, [isRebuilding])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      // Clear any pending auto-retry timeouts
      if (autoRetryTimeoutRef.current) {
        clearTimeout(autoRetryTimeoutRef.current)
      }
      // Clear status poll interval
      if (statusPollIntervalRef.current) {
        clearInterval(statusPollIntervalRef.current)
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

  // Loading state - show detailed progress during cold start
  if (isLoading && !sandboxUrl) {
    // Calculate estimated progress based on poll count (each poll is ~3 seconds)
    // Progress: 10% base, +5% per poll, max 95%
    const estimatedProgress = Math.min(95, pollCount * 5 + 10)
    
    return (
      <div className={cn(
        "flex flex-col items-center justify-center h-full w-full bg-gradient-to-b from-background to-muted/30",
        className
      )}>
        <div className="flex flex-col items-center gap-6 max-w-md text-center px-6">
          {/* Animated rocket icon */}
          <div className="relative">
            <div className="absolute inset-0 bg-primary/20 rounded-full blur-xl animate-pulse" />
            <div className="relative bg-gradient-to-br from-primary/10 to-primary/5 p-6 rounded-full border border-primary/20">
              <svg 
                className="h-12 w-12 text-primary animate-bounce" 
                viewBox="0 0 24 24" 
                fill="none" 
                stroke="currentColor" 
                strokeWidth="1.5"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.59 14.37a6 6 0 01-5.84 7.38v-4.8m5.84-2.58a14.98 14.98 0 006.16-12.12A14.98 14.98 0 009.631 8.41m5.96 5.96a14.926 14.926 0 01-5.841 2.58m-.119-8.54a6 6 0 00-7.381 5.84h4.8m2.581-5.84a14.927 14.927 0 00-2.58 5.84m2.699 2.7c-.103.021-.207.041-.311.06a15.09 15.09 0 01-2.448-2.448 14.9 14.9 0 01.06-.312m-2.24 2.39a4.493 4.493 0 00-1.757 4.306 4.493 4.493 0 004.306-1.758M16.5 9a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z" />
              </svg>
            </div>
          </div>
          
          {/* Status text */}
          <div className="space-y-2">
            <h3 className="text-lg font-semibold text-foreground">
              Starting your environment
            </h3>
            <p className="text-sm text-muted-foreground">
              {statusMessage}
            </p>
          </div>
          
          {/* Progress bar */}
          <div className="w-full max-w-xs space-y-2">
            <div className="h-2 bg-muted rounded-full overflow-hidden">
              <div 
                className="h-full bg-gradient-to-r from-primary to-primary/80 rounded-full transition-all duration-500 ease-out"
                style={{ width: `${estimatedProgress}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {status === 'creating' || status === 'not_found' 
                ? 'First-time setup takes up to 30 seconds'
                : status === 'starting'
                ? 'Almost ready...'
                : 'Preparing your workspace...'}
            </p>
          </div>
        </div>
      </div>
    )
  }

  const viewportWidth = VIEWPORT_SIZES[viewport].width

  return (
    <div className={cn("relative h-full w-full bg-muted/20", className)}>
      {/* Refresh Button */}
      <div className="absolute top-2 right-2 z-10">
        <button
          onClick={handleRefresh}
          disabled={isRebuilding}
          className={cn(
            "p-1.5 rounded-full bg-background/90 backdrop-blur-sm border border-border hover:bg-muted transition-colors shadow-sm",
            isRebuilding && "opacity-50 cursor-not-allowed"
          )}
          title="Refresh preview"
        >
          <RefreshCw className={cn(
            "h-3.5 w-3.5 text-muted-foreground",
            isRebuilding && "animate-spin"
          )} />
        </button>
      </div>

      {/* Smooth rebuilding overlay - keeps previous content visible */}
      {isRebuilding && iframeLoaded && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/60 backdrop-blur-[2px] z-5 animate-in fade-in duration-200">
          <div className="flex flex-col items-center gap-3 bg-background/95 backdrop-blur-sm border border-border rounded-lg p-6 shadow-lg">
            <div className="relative">
              <Loader2 className="h-8 w-8 text-primary animate-spin" />
            </div>
            <div className="flex flex-col items-center gap-1">
              <span className="text-sm font-medium text-foreground">Updating preview</span>
              <span className="text-xs text-muted-foreground">Building your changes...</span>
            </div>
          </div>
        </div>
      )}

      {/* Loading overlay for initial load only */}
      {(isLoading || !iframeLoaded) && sandboxUrl && !isRebuilding && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/80 z-5">
          <div className="flex flex-col items-center gap-2">
            <Loader2 className="h-6 w-6 text-primary animate-spin" />
            <span className="text-xs text-muted-foreground">Loading preview...</span>
          </div>
        </div>
      )}

      {/* Viewport-constrained iframe container */}
      {sandboxUrl && (
        <div className="h-full w-full flex items-start justify-center overflow-auto bg-muted/10">
          <div 
            className="h-full bg-background transition-all duration-300 ease-in-out shadow-sm"
            style={{ 
              width: `${viewportWidth}px`,
              minWidth: `${viewportWidth}px`
            }}
          >
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
          </div>
        </div>
      )}
    </div>
  )
}

export default RuntimePreviewPanel
