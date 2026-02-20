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
import { Loader2, AlertCircle, RefreshCw, Hammer } from "lucide-react"
import { cn } from "@/lib/utils"
import { VIEWPORT_SIZES, type ViewportSize } from "./PreviewControls"

/**
 * Runtime status from API response
 */
type RuntimeStatus = 'not_found' | 'creating' | 'starting' | 'running' | 'stopping' | 'stopped' | 'error'

/**
 * Build watch state from runtime
 */
interface BuildWatchState {
  active: boolean
  state: 'idle' | 'building' | 'success' | 'error'
  building: boolean
  startTime: number | null
  duration: number | null
  lastBuildTime: number | null
  error: string | null
  errorContext?: {
    category: string
    rootCause: string
    canAutoRecover: boolean
    suggestions: string[]
  } | null
  logPreview?: string
  watchCrashCount?: number
  canAutoRestart?: boolean
}

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
  buildWatch?: BuildWatchState
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

/**
 * Animated overlay shown during template_copy operation
 * Shows step-by-step progress with animated indicators
 */
function TemplateCopyOverlay() {
  const [currentStep, setCurrentStep] = useState(0)
  
  const steps = [
    { icon: '📦', label: 'Copying template files', sublabel: 'Setting up project structure' },
    { icon: '⚙️', label: 'Installing dependencies', sublabel: 'Preparing packages' },
    { icon: '🔧', label: 'Configuring project', sublabel: 'Setting up development environment' },
    { icon: '🚀', label: 'Starting dev server', sublabel: 'Almost ready...' },
  ]
  
  // Cycle through steps to show activity
  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentStep(prev => (prev + 1) % steps.length)
    }, 2500)
    return () => clearInterval(interval)
  }, [steps.length])
  
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-gradient-to-br from-background via-background/95 to-primary/5 backdrop-blur-sm animate-in fade-in duration-300">
      <div className="flex flex-col items-center gap-8 max-w-md text-center px-8">
        <Loader2 className="h-10 w-10 text-primary animate-spin" />
        
        {/* Title */}
        <div className="space-y-2">
          <h3 className="text-xl font-semibold text-foreground">
            Setting Up Your Project
          </h3>
          <p className="text-sm text-muted-foreground">
            Please wait while we prepare your workspace
          </p>
        </div>
        
        {/* Steps display */}
        <div className="w-full space-y-3">
          {steps.map((step, index) => (
            <div
              key={step.label}
              className={cn(
                "flex items-center gap-3 p-3 rounded-lg transition-all duration-500",
                index === currentStep
                  ? "bg-primary/10 border border-primary/30 scale-[1.02]"
                  : index < currentStep
                    ? "bg-muted/30 opacity-60"
                    : "bg-muted/10 opacity-40"
              )}
            >
              <div className={cn(
                "w-8 h-8 rounded-full flex items-center justify-center text-lg transition-all",
                index === currentStep
                  ? "bg-primary/20 animate-pulse"
                  : index < currentStep
                    ? "bg-green-500/20"
                    : "bg-muted/30"
              )}>
                {index < currentStep ? '✓' : step.icon}
              </div>
              <div className="flex-1 text-left">
                <p className={cn(
                  "text-sm font-medium transition-colors",
                  index === currentStep ? "text-foreground" : "text-muted-foreground"
                )}>
                  {step.label}
                </p>
                <p className="text-xs text-muted-foreground/70">
                  {step.sublabel}
                </p>
              </div>
              {index === currentStep && (
                <Loader2 className="h-4 w-4 text-primary animate-spin" />
              )}
            </div>
          ))}
        </div>
        
        {/* Progress bar */}
        <div className="w-full">
          <div className="h-1.5 bg-muted/30 rounded-full overflow-hidden">
            <div 
              className="h-full bg-gradient-to-r from-primary via-primary/80 to-primary rounded-full transition-all duration-500"
              style={{
                width: `${((currentStep + 1) / steps.length) * 100}%`,
              }}
            />
          </div>
          <p className="text-xs text-muted-foreground/60 mt-2">
            Step {currentStep + 1} of {steps.length}
          </p>
        </div>
      </div>
    </div>
  )
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
  /** Viewport size for responsive preview */
  viewport?: ViewportSize
  /** Callback when build error occurs with detailed info */
  onBuildError?: (error: string, context?: BuildWatchState['errorContext'] | null) => void
  /** Force refresh trigger - increment to force a preview refresh (backup for SSE failures) */
  forceRefresh?: number
  /** Whether template copy is in progress - shows animated overlay */
  isTemplateCopying?: boolean
  /** Chat error from ChatPanel - stops loading animation when project creation fails */
  chatError?: Error | null
}

export function RuntimePreviewPanel({
  projectId,
  className,
  onError,
  onLoad,
  viewport = "desktop",
  onBuildError,
  forceRefresh,
  isTemplateCopying = false,
  chatError,
}: RuntimePreviewPanelProps) {
  const [sandboxUrl, setSandboxUrl] = useState<string | null>(null)
  const [agentUrl, setAgentUrl] = useState<string | null>(null)
  const [sandboxAttributes, setSandboxAttributes] = useState<string>('')
  const [status, setStatus] = useState<RuntimeStatus>('stopped')
  const [statusMessage, setStatusMessage] = useState<string>('Initializing...')
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [iframeLoaded, setIframeLoaded] = useState(false)
  const [pollCount, setPollCount] = useState(0) // Track polls for progress bar
  const [isRebuilding, setIsRebuilding] = useState(false) // Track rebuild state for smooth overlay
  const [buildState, setBuildState] = useState<BuildWatchState['state']>('idle')
  const [lastBuildTime, setLastBuildTime] = useState<number | null>(null)
  const [buildError, setBuildError] = useState<string | null>(null)
  const [buildErrorContext, setBuildErrorContext] = useState<BuildWatchState['errorContext'] | null>(null)
  const [isManualRebuilding, setIsManualRebuilding] = useState(false)

  const iframeRef = useRef<HTMLIFrameElement>(null)
  const retryCountRef = useRef(0)
  const maxAutoRetries = 60 // Allow up to 60 polls (3 minutes at 3s intervals)
  const autoRetryTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const statusPollIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const buildEventSourceRef = useRef<EventSource | null>(null)
  // Track build state inside SSE handler via ref (avoids stale closure issues)
  const buildStateForSSERef = useRef<BuildWatchState['state'] | null>(null)
  // Track isTemplateCopying in a ref so SSE/polling closures can read the current value
  const isTemplateCopyingRef = useRef(isTemplateCopying)
  isTemplateCopyingRef.current = isTemplateCopying
  // Shared ref to track last refresh time - used by both SSE handler and forceRefresh to prevent double-refreshes
  const lastForceRefreshRef = useRef<number>(0)
  const forceRefreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Track the last forceRefresh value we processed to prevent re-firing on dependency changes
  const lastProcessedForceRefreshRef = useRef<number>(0)

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
      const data = await response.json()
      
      // Update build state from polling (fallback if SSE not working)
      if (data.buildWatch && !buildEventSourceRef.current) {
        const prevState = buildState
        setBuildState(data.buildWatch.state)
        setLastBuildTime(data.buildWatch.lastBuildTime)
        
        // Handle state changes same as SSE (skip rebuild overlay during template copy)
        if (data.buildWatch.state === 'building' && prevState !== 'building' && !isTemplateCopyingRef.current) {
          setIsRebuilding(true)
          setStatusMessage('Rebuilding project...')
        } else if (data.buildWatch.state === 'success' && prevState === 'building') {
          setTimeout(() => {
            if (iframeRef.current && sandboxUrl) {
              setIframeLoaded(false)
              const cacheBuster = Date.now()
              const separator = sandboxUrl.includes('?') ? '&' : '?'
              iframeRef.current.src = `${sandboxUrl}${separator}_t=${cacheBuster}`
            }
          }, 500)
        }
      }
      
      return data
    } catch {
      return null
    }
  }, [projectId, buildState, sandboxUrl])

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
   * Trigger a manual rebuild
   */
  const handleRebuild = useCallback(async () => {
    if (!sandboxUrl || isManualRebuilding) return
    
    const url = new URL(sandboxUrl)
    const baseUrl = `${url.protocol}//${url.host}`
    
    console.log('[RuntimePreviewPanel] Triggering manual rebuild...')
    setIsManualRebuilding(true)
    setBuildError(null)
    setBuildErrorContext(null)
    setIsRebuilding(true)
    setStatusMessage('Manual rebuild in progress...')
    
    try {
      const response = await fetch(`${baseUrl}/preview/rebuild`, {
        method: 'POST',
      })
      
      const data = await response.json()
      
      if (!response.ok || !data.success) {
        console.error('[RuntimePreviewPanel] Rebuild failed:', data.error)
        setBuildError(data.error || 'Rebuild failed')
        setIsRebuilding(false)
      } else {
        console.log('[RuntimePreviewPanel] Rebuild succeeded')
        // Refresh iframe after successful rebuild
        setTimeout(() => {
          if (iframeRef.current && sandboxUrl) {
            setIframeLoaded(false)
            const cacheBuster = Date.now()
            const separator = sandboxUrl.includes('?') ? '&' : '?'
            iframeRef.current.src = `${sandboxUrl}${separator}_t=${cacheBuster}`
          }
        }, 500)
      }
    } catch (err: any) {
      console.error('[RuntimePreviewPanel] Rebuild error:', err)
      setBuildError(err.message || 'Rebuild failed')
      setIsRebuilding(false)
    } finally {
      setIsManualRebuilding(false)
    }
  }, [sandboxUrl, isManualRebuilding])

  /**
   * Subscribe to build events via SSE for real-time rebuild notifications
   * MUST be defined before fetchSandboxUrlOnce which uses it
   */
  const subscribeToBuildEvents = useCallback(() => {
    // Don't subscribe until we have a URL
    // Use agentUrl for build-events (in local dev, this is the project-runtime agent server)
    const baseUrl = agentUrl || (sandboxUrl ? (() => { const u = new URL(sandboxUrl); return `${u.protocol}//${u.host}` })() : null)
    if (!baseUrl) return
    
    console.log('[RuntimePreviewPanel] Subscribing to build events:', `${baseUrl}/build-events`)
    
    try {
      const eventSource = new EventSource(`${baseUrl}/build-events`)
      buildEventSourceRef.current = eventSource
      
      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as {
            state: BuildWatchState['state']
            lastBuildTime: number | null
            error: string | null
            errorContext?: BuildWatchState['errorContext']
            logPreview?: string
            watchCrashCount?: number
            canAutoRestart?: boolean
            timestamp: number
          }
          
          console.log('[RuntimePreviewPanel] Build state changed:', data.state, data.error ? `(error: ${data.error})` : '')
          
          // Use ref for previous state to avoid stale closure issues
          // (both 'building' and 'success' events can arrive within one React render)
          const prevState = buildStateForSSERef.current
          buildStateForSSERef.current = data.state
          setBuildState(data.state)
          setLastBuildTime(data.lastBuildTime)
          
          // Show rebuild overlay when build starts (skip during template copy — the overlay already provides feedback)
          if (data.state === 'building' && prevState !== 'building' && !isTemplateCopyingRef.current) {
            console.log('[RuntimePreviewPanel] 📥 SSE_BUILD_STARTED - Vite is rebuilding')
            setIsRebuilding(true)
            setStatusMessage('Rebuilding project...')
            setBuildError(null)
            setBuildErrorContext(null)
          }
          
          // Refresh iframe when build succeeds
          if (data.state === 'success' && prevState === 'building') {
            setBuildError(null)
            setBuildErrorContext(null)
            
            // Cancel any pending forceRefresh fallback timeout — SSE delivered the success event
            if (forceRefreshTimeoutRef.current) {
              clearTimeout(forceRefreshTimeoutRef.current)
              forceRefreshTimeoutRef.current = null
            }
            
            // Throttle: Skip if a refresh happened very recently.
            // Reduced from 2000ms to 500ms to avoid missing legitimate build completions
            // that arrive shortly after a FORCE_REFRESH trigger.
            const now = Date.now()
            const timeSinceLastRefresh = now - lastForceRefreshRef.current
            const SSE_THROTTLE_MS = 500
            
            console.log('[RuntimePreviewPanel] 📥 SSE_BUILD_SUCCESS received:', {
              prevState,
              newState: data.state,
              timeSinceLastRefresh,
              throttleMs: SSE_THROTTLE_MS,
              willThrottle: timeSinceLastRefresh < SSE_THROTTLE_MS,
            })
            
            if (timeSinceLastRefresh < SSE_THROTTLE_MS) {
              console.log('[RuntimePreviewPanel] ⏸️ SSE_BUILD_SUCCESS THROTTLED - skipping refresh')
              setIsRebuilding(false)
            } else {
              console.log('[RuntimePreviewPanel] 🔄 SSE_BUILD_SUCCESS EXECUTING - refreshing iframe')
              lastForceRefreshRef.current = now
              // Wait a moment for server to be ready
              setTimeout(() => {
                if (iframeRef.current && sandboxUrl) {
                  setIframeLoaded(false)
                  const cacheBuster = Date.now()
                  const separator = sandboxUrl.includes('?') ? '&' : '?'
                  console.log('[RuntimePreviewPanel] 🔄 SSE_BUILD_SUCCESS setting iframe src with cacheBuster:', cacheBuster)
                  iframeRef.current.src = `${sandboxUrl}${separator}_t=${cacheBuster}`
                }
              }, 500)
            }
          }
          
          // Handle error state with enhanced context
          if (data.state === 'error') {
            setBuildError(data.error || 'Build failed')
            setBuildErrorContext(data.errorContext || null)
            setIsRebuilding(false)
            
            // Notify parent component of build error
            if (onBuildError && data.error) {
              onBuildError(data.error, data.errorContext)
            }
            
            // Don't set general error if auto-recovery is in progress
            if (!data.canAutoRestart) {
              setError('Build failed - use Rebuild button to retry')
            }
          }
        } catch (e) {
          console.error('[RuntimePreviewPanel] Error parsing build event:', e)
        }
      }
      
      eventSource.onerror = (e) => {
        console.error('[RuntimePreviewPanel] Build event stream error:', e)
        // Try to reconnect after 5s
        setTimeout(() => {
          if (!buildEventSourceRef.current || buildEventSourceRef.current.readyState === EventSource.CLOSED) {
            subscribeToBuildEvents()
          }
        }, 5000)
      }
    } catch (e) {
      console.error('[RuntimePreviewPanel] Failed to subscribe to build events:', e)
    }
  }, [sandboxUrl])

  /**
   * Unsubscribe from build events
   */
  const unsubscribeFromBuildEvents = useCallback(() => {
    if (buildEventSourceRef.current) {
      console.log('[RuntimePreviewPanel] Unsubscribing from build events')
      buildEventSourceRef.current.close()
      buildEventSourceRef.current = null
    }
  }, [])

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
      // Capture agentUrl for SSE endpoints (separate from Vite URL in local dev)
      if (data.agentUrl) {
        setAgentUrl(data.agentUrl)
      }
      setStatus('running')
      retryCountRef.current = 0
      
      // Subscribe to build events for real-time rebuild notifications
      setTimeout(() => {
        subscribeToBuildEvents()
      }, 1000)

    } catch (err: any) {
      setError(err.message || 'Failed to connect to runtime')
    } finally {
      setIsLoading(false)
    }
  }, [projectId, initializeRuntime, subscribeToBuildEvents])

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
    setAgentUrl(null)
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

  // Note: Auto-refresh is handled entirely by SSE build events (subscribeToBuildEvents)
  // When the Vite build completes (state: 'building' -> 'success'), the SSE handler
  // automatically refreshes the iframe with a cache-buster. No manual polling or 
  // refresh triggers needed.

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

  // Force refresh handler - refreshes preview when AI modifies files.
  // Parent component (ProjectLayout) increments forceRefresh when onFilesChanged fires.
  // 
  // IMPORTANT: onFilesChanged fires at the END of the AI's full response (not per-tool-call),
  // so by the time this triggers, the build/HMR has likely already completed.
  // In local dev: Vite HMR handles updates in real-time (no SSE needed)
  // In production: SSE build-events handles updates (cancels fallback if it fires first)
  //
  // NOTE: This effect ONLY depends on [forceRefresh, sandboxUrl]. We deliberately exclude
  // iframeLoaded and buildState to prevent a continuous refresh loop where dependency changes
  // re-trigger the effect even though forceRefresh hasn't changed.
  useEffect(() => {
    // Skip initial render (forceRefresh starts at 0)
    if (!forceRefresh || forceRefresh === 0) return
    
    // Skip if we already processed this forceRefresh value
    // This prevents re-firing when other state (iframeLoaded, buildState) changes
    if (forceRefresh === lastProcessedForceRefreshRef.current) return
    lastProcessedForceRefreshRef.current = forceRefresh
    
    // Throttle: ignore if a refresh happened very recently.
    // Reduced from 2000ms to 500ms to prevent missed refreshes after AI code changes.
    const now = Date.now()
    const timeSinceLastRefresh = now - lastForceRefreshRef.current
    const THROTTLE_MS = 500
    
    console.log('[RuntimePreviewPanel] 📥 FORCE_REFRESH received:', {
      forceRefresh,
      timeSinceLastRefresh,
      throttleMs: THROTTLE_MS,
      willThrottle: timeSinceLastRefresh < THROTTLE_MS,
      sandboxUrl: !!sandboxUrl,
    })
    
    if (timeSinceLastRefresh < THROTTLE_MS) {
      console.log('[RuntimePreviewPanel] ⏸️ FORCE_REFRESH THROTTLED - skipping refresh')
      return
    }
    
    // Act if we have a sandbox URL (don't require iframeLoaded - first load may not have completed)
    if (iframeRef.current && sandboxUrl) {
      // Clear any pending refresh timeout
      if (forceRefreshTimeoutRef.current) {
        clearTimeout(forceRefreshTimeoutRef.current)
      }
      
      // Show "rebuilding" overlay briefly while we wait for the refresh
      setIsRebuilding(true)
      setStatusMessage('Updating preview...')
      
      // Trigger a full rebuild on the server since Vite watch mode may not detect
      // AI-written file changes reliably. The SSE handler will pick up the build
      // completion and refresh the iframe, but we also set a fallback timeout.
      const url = new URL(sandboxUrl)
      const baseUrl = `${url.protocol}//${url.host}`
      fetch(`${baseUrl}/preview/rebuild`, { method: 'POST' })
        .then(res => res.json())
        .then(data => {
          if (data.success) {
            console.log('[RuntimePreviewPanel] 🔄 FORCE_REFRESH rebuild succeeded, SSE will refresh iframe')
          } else {
            console.warn('[RuntimePreviewPanel] ⚠️ FORCE_REFRESH rebuild failed:', data.error)
            // Rebuild failed, but SSE may not fire success - fall back to direct refresh
            if (iframeRef.current && sandboxUrl) {
              lastForceRefreshRef.current = Date.now()
              setIframeLoaded(false)
              const cacheBuster = Date.now()
              const separator = sandboxUrl.includes('?') ? '&' : '?'
              iframeRef.current.src = `${sandboxUrl}${separator}_t=${cacheBuster}`
            }
          }
        })
        .catch(err => {
          console.error('[RuntimePreviewPanel] ⚠️ FORCE_REFRESH rebuild request failed:', err)
          // Network error - refresh iframe directly as fallback
          if (iframeRef.current && sandboxUrl) {
            lastForceRefreshRef.current = Date.now()
            setIframeLoaded(false)
            const cacheBuster = Date.now()
            const separator = sandboxUrl.includes('?') ? '&' : '?'
            iframeRef.current.src = `${sandboxUrl}${separator}_t=${cacheBuster}`
          }
        })
      
      // Fallback: if SSE doesn't fire within 5 seconds, refresh iframe directly.
      // This is a safety net; normally the SSE BUILD_SUCCESS handler refreshes the iframe.
      // Reduced from 10s to 5s since builds typically complete in 1-3s and stale previews
      // are a significant UX issue (users think nothing happened).
      forceRefreshTimeoutRef.current = setTimeout(() => {
        if (iframeRef.current && sandboxUrl) {
          console.log('[RuntimePreviewPanel] 🔄 FORCE_REFRESH fallback - refreshing iframe directly')
          lastForceRefreshRef.current = Date.now()
          setIframeLoaded(false)
          setIsRebuilding(false)
          const cacheBuster = Date.now()
          const separator = sandboxUrl.includes('?') ? '&' : '?'
          iframeRef.current.src = `${sandboxUrl}${separator}_t=${cacheBuster}`
        }
      }, 5000) // 5 second fallback - normally SSE fires much sooner
    } else {
      console.log('[RuntimePreviewPanel] ⚠️ FORCE_REFRESH skipped - conditions not met:', {
        hasIframeRef: !!iframeRef.current,
        sandboxUrl: !!sandboxUrl,
      })
    }
  }, [forceRefresh, sandboxUrl])

  // When template copy completes (isTemplateCopying transitions true → false),
  // refresh the iframe. The server-side rebuild (triggered by /preview/restart)
  // may have already completed via SSE before the tool call finishes streaming,
  // so check SSE build state to avoid showing a redundant "Rebuilding" overlay.
  const prevIsTemplateCopyingRef = useRef(isTemplateCopying)
  useEffect(() => {
    const wasTemplateCopying = prevIsTemplateCopyingRef.current
    prevIsTemplateCopyingRef.current = isTemplateCopying
    
    // Detect transition: was copying → now done
    if (wasTemplateCopying && !isTemplateCopying && iframeRef.current && sandboxUrl) {
      if (forceRefreshTimeoutRef.current) {
        clearTimeout(forceRefreshTimeoutRef.current)
      }

      // Clear any stale rebuild state that SSE/polling may have set while the overlay was active
      setIsRebuilding(false)

      if (buildStateForSSERef.current === 'success') {
        // SSE already reported a successful build while the overlay was showing.
        // Silently refresh the iframe without showing a second loading screen.
        console.log('[RuntimePreviewPanel] 🎯 Template copy completed - build already succeeded, silent refresh')
        lastForceRefreshRef.current = Date.now()
        setIframeLoaded(false)
        const cacheBuster = Date.now()
        const separator = sandboxUrl.includes('?') ? '&' : '?'
        iframeRef.current.src = `${sandboxUrl}${separator}_t=${cacheBuster}`
      } else {
        // Build hasn't completed yet — let SSE handle the rebuild overlay naturally.
        // Don't force isRebuilding here; SSE will set it when the build actually starts.
        console.log('[RuntimePreviewPanel] 🎯 Template copy completed - waiting for build via SSE')
        
        forceRefreshTimeoutRef.current = setTimeout(() => {
          if (iframeRef.current && sandboxUrl) {
            console.log('[RuntimePreviewPanel] 🔄 Template copy fallback - refreshing iframe')
            lastForceRefreshRef.current = Date.now()
            setIframeLoaded(false)
            const cacheBuster = Date.now()
            const separator = sandboxUrl.includes('?') ? '&' : '?'
            iframeRef.current.src = `${sandboxUrl}${separator}_t=${cacheBuster}`
          }
        }, 3000)
      }
    }
  }, [isTemplateCopying, sandboxUrl])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      // Unsubscribe from build events
      unsubscribeFromBuildEvents()
      
      // Clear any pending auto-retry timeouts
      if (autoRetryTimeoutRef.current) {
        clearTimeout(autoRetryTimeoutRef.current)
      }
      // Clear force refresh timeout
      if (forceRefreshTimeoutRef.current) {
        clearTimeout(forceRefreshTimeoutRef.current)
      }
      // Clear status poll interval
      if (statusPollIntervalRef.current) {
        clearInterval(statusPollIntervalRef.current)
      }
      // Fire-and-forget stop request on unmount
      fetch(`/api/projects/${projectId}/runtime/stop`, { method: 'POST' })
        .catch(() => {}) // Ignore errors on unmount
    }
  }, [projectId, unsubscribeFromBuildEvents])

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

  // If a chat error occurred during project creation, stop the loading animation
  // and show a user-friendly error state instead of spinning forever
  if (isLoading && !sandboxUrl && chatError) {
    return (
      <div className={cn(
        "flex flex-col items-center justify-center h-full w-full bg-gradient-to-b from-background to-destructive/5",
        className
      )}>
        <div className="flex flex-col items-center gap-4 max-w-md text-center px-6">
          <div className="bg-destructive/10 p-4 rounded-full border border-destructive/20">
            <AlertCircle className="h-10 w-10 text-destructive" />
          </div>
          <div className="space-y-2">
            <h3 className="text-lg font-semibold text-foreground">
              Environment setup failed
            </h3>
            <p className="text-sm text-muted-foreground">
              There was a problem starting your project. Check the chat panel for details, or try again.
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
      {/* Refresh Button & Build Status Indicator */}
      <div className="absolute top-2 right-2 z-10 flex items-center gap-2">
        {/* Build status indicator */}
        {buildState === 'building' && (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 backdrop-blur-sm border border-primary/20 shadow-sm animate-in fade-in slide-in-from-top-2 duration-200">
            <div className="h-2 w-2 rounded-full bg-primary animate-pulse" />
            <span className="text-xs font-medium text-primary">Rebuilding...</span>
          </div>
        )}
        
        {buildState === 'success' && lastBuildTime && Date.now() - lastBuildTime < 3000 && (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-green-500/10 backdrop-blur-sm border border-green-500/20 shadow-sm animate-in fade-in slide-in-from-top-2 duration-200">
            <div className="h-2 w-2 rounded-full bg-green-500" />
            <span className="text-xs font-medium text-green-600 dark:text-green-400">Build complete!</span>
          </div>
        )}
        
        {/* Build error indicator with rebuild button */}
        {buildState === 'error' && buildError && (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-red-500/10 backdrop-blur-sm border border-red-500/20 shadow-sm animate-in fade-in slide-in-from-top-2 duration-200">
            <AlertCircle className="h-4 w-4 text-red-500" />
            <span className="text-xs font-medium text-red-600 dark:text-red-400 max-w-[200px] truncate" title={buildError}>
              {buildErrorContext?.rootCause || 'Build failed'}
            </span>
            <button
              onClick={handleRebuild}
              disabled={isManualRebuilding}
              className={cn(
                "flex items-center gap-1 px-2 py-1 text-xs font-medium rounded bg-red-500 text-white hover:bg-red-600 transition-colors",
                isManualRebuilding && "opacity-50 cursor-not-allowed"
              )}
              title="Trigger a manual rebuild"
            >
              {isManualRebuilding ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              Rebuild
            </button>
          </div>
        )}
        
        {/* Rebuild button (shown when not in error state but build crashed) */}
        {buildState !== 'error' && buildState !== 'building' && (
          <button
            onClick={handleRebuild}
            disabled={isManualRebuilding || isRebuilding}
            className={cn(
              "p-2 rounded-full bg-background/90 backdrop-blur-sm border border-border hover:bg-muted transition-all shadow-sm hover:shadow-md",
              (isManualRebuilding || isRebuilding) && "opacity-50 cursor-not-allowed"
            )}
            title="Trigger full rebuild"
          >
            <Hammer className={cn(
              "h-4 w-4 text-muted-foreground",
              isManualRebuilding && "animate-pulse"
            )} />
          </button>
        )}
        
        {/* Refresh button */}
        <button
          onClick={handleRefresh}
          disabled={isRebuilding}
          className={cn(
            "p-2 rounded-full bg-background/90 backdrop-blur-sm border border-border hover:bg-muted transition-all shadow-sm hover:shadow-md",
            isRebuilding && "opacity-50 cursor-not-allowed"
          )}
          title="Refresh preview"
        >
          <RefreshCw className={cn(
            "h-4 w-4 text-muted-foreground transition-transform",
            isRebuilding && "animate-spin"
          )} />
        </button>
      </div>

      {/* Smooth rebuilding overlay - keeps previous content visible */}
      {isRebuilding && iframeLoaded && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/70 backdrop-blur-[3px] z-5 animate-in fade-in duration-200">
          <div className="flex flex-col items-center gap-4 bg-gradient-to-br from-background/98 to-background/95 backdrop-blur-md border-2 border-primary/20 rounded-xl p-8 shadow-2xl max-w-sm">
            {/* Animated icon */}
            <div className="relative">
              <div className="absolute inset-0 bg-primary/10 rounded-full blur-xl animate-pulse" />
              <div className="relative">
                <Loader2 className="h-10 w-10 text-primary animate-spin" />
              </div>
            </div>
            
            {/* Status text */}
            <div className="flex flex-col items-center gap-2 text-center">
              <span className="text-base font-semibold text-foreground">Rebuilding Project</span>
              <div className="flex flex-col gap-1">
                <span className="text-sm text-muted-foreground">
                  {statusMessage || 'Compiling your changes...'}
                </span>
                <span className="text-xs text-muted-foreground/70">
                  This usually takes 2-4 seconds
                </span>
              </div>
            </div>
            
            {/* Progress indicator */}
            <div className="w-full h-1 bg-muted rounded-full overflow-hidden">
              <div 
                className="h-full bg-primary rounded-full" 
                style={{
                  width: '40%',
                  animation: 'shimmer 1.5s ease-in-out infinite'
                }} 
              />
            </div>
          </div>
        </div>
      )}

      {/* Loading overlay for initial load only */}
      {(isLoading || !iframeLoaded) && sandboxUrl && !isRebuilding && !isTemplateCopying && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/80 z-5">
          <div className="flex flex-col items-center gap-2">
            <Loader2 className="h-6 w-6 text-primary animate-spin" />
            <span className="text-xs text-muted-foreground">Loading preview...</span>
          </div>
        </div>
      )}

      {/* Template copy overlay - shows animated progress during template_copy */}
      {isTemplateCopying && (
        <TemplateCopyOverlay />
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
