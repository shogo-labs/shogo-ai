/**
 * ProjectLayout - Main project view layout (Lovable.dev-inspired)
 *
 * Full-screen project editing experience with:
 * - Minimal top bar with project name dropdown, preview controls, and actions
 * - Split view: Chat/History panel (LEFT) + Dynamic workspace/preview (RIGHT)
 * - Toggle between chat and history views
 * - Hide/show left panel entirely
 *
 * Key features:
 * - Chat is on the LEFT side like Lovable.dev
 * - History panel replaces chat when toggled
 * - Preview has subtle border/shadow styling
 */

import { observer } from "mobx-react-lite"
import { useEffect, useCallback, useState, useRef } from "react"
import { useParams, useLocation } from "react-router-dom"
import { useDomains, useSchemaLoadingState, useSDKDomain, useSDKReady, useSDKHttp } from "@/contexts/DomainProvider"
import type { IDomainStore } from "@/generated/domain"
import { useDomainActions } from "@/generated/domain-actions"
import { ChatPanel } from "../chat/ChatPanel"
import { ChatPanelTransitionOverlay } from "../chat/ChatPanelTransitionOverlay"
import { useChatSessionNavigation } from "../advanced-chat/hooks/useChatSessionNavigation"
import { ProjectTopBar } from "./ProjectTopBar"
import { ChatSessionsPanel, type ChatSessionItem } from "./ChatSessionsPanel"
import { RuntimePreviewPanel } from "./RuntimePreviewPanel"
import { CodeEditorPanel } from "./CodeEditorPanel"
import { TerminalPanel } from "./TerminalPanel"
import { DatabasePanel } from "./DatabasePanel"
import { TestPanel } from "./TestPanel"
import { SecurityPanel } from "./SecurityPanel"
import { HistoryPanel } from "./HistoryPanel"
import { cn } from "@/lib/utils"
import { useSession } from "@/contexts/SessionProvider"
import type { ViewportSize } from "./PreviewControls"
import { useToast } from "@/hooks/use-toast"

// Default chat panel width in px
const DEFAULT_CHAT_WIDTH = 480

// Serialized rect for transition animation
interface SerializedRect {
  top: number
  left: number
  width: number
  height: number
  right: number
  bottom: number
}

// Location state passed from homepage transition
interface TransitionLocationState {
  project?: any
  chatSessionId?: string
  initialMessage?: string
  // Transition animation data
  transitionStartRect?: SerializedRect
  transitionPromptText?: string
}

export const ProjectLayout = observer(function ProjectLayout() {
  const { projectId } = useParams<{ projectId: string }>()
  const location = useLocation()
  const { data: session } = useSession()

  // Capture transition state from navigation so it survives replaceState (which would clear location.state)
  // Without this, first message and overlay start rect are lost before ChatPanel can use them
  const [capturedTransition] = useState<TransitionLocationState | null>(
    () => (location.state as TransitionLocationState | null) ?? null
  )
  const transitionState = capturedTransition

  // Use SDK store for data loading
  const store = useSDKDomain() as IDomainStore
  const sdkReady = useSDKReady()
  const actions = useDomainActions()
  const http = useSDKHttp()

  // Legacy domains for platformFeatures
  const { platformFeatures, studioChat, billing } = useDomains<{
    platformFeatures: any
    studioChat: any
    billing: any
  }>()

  // Track current chat session in URL
  const { chatSessionId, setChatSessionId } = useChatSessionNavigation()

  // Chat panel state - now on LEFT side
  const [isChatCollapsed, setIsChatCollapsed] = useState(false)
  const [chatWidth, setChatWidth] = useState(DEFAULT_CHAT_WIDTH)

  // Chat sessions panel state (toggled via history icon)
  const [showChatSessions, setShowChatSessions] = useState(false)

  // Preview controls state
  const [currentViewport, setCurrentViewport] = useState<ViewportSize>("desktop")
  const [currentRoute, setCurrentRoute] = useState("/")
  
  // Toast notifications
  const { toast } = useToast()
  
  // External preview opening state
  const [isOpeningExternal, setIsOpeningExternal] = useState(false)

  // Preview mode: 'runtime' (RuntimePreviewPanel), 'code' (CodeEditorPanel), 'terminal' (TerminalPanel), 'database' (DatabasePanel), 'tests' (TestPanel), 'security' (SecurityPanel), or 'history' (HistoryPanel)
  const [previewMode, setPreviewMode] = useState<'runtime' | 'code' | 'terminal' | 'database' | 'tests' | 'security' | 'history'>('runtime')

  // Code editor refresh trigger - incremented when agent modifies files
  const [codeRefreshTrigger, setCodeRefreshTrigger] = useState(0)

  // Template copy state - tracks when template_copy tool is running for preview overlay
  const [isTemplateCopying, setIsTemplateCopying] = useState(false)

  // Chat error state - passed to RuntimePreviewPanel to stop loading on project creation failure
  const [chatError, setChatError] = useState<Error | null>(null)

  // Injected chat message from Security "Fix with AI" — passed to ChatPanel.injectMessage
  // Nonce is appended to ensure each click produces a unique value for the useEffect dedup
  const securityFixNonceRef = useRef(0)
  const [securityFixMessage, setSecurityFixMessage] = useState<string | null>(null)

  // Auto-scan trigger — incremented after AI code generation to auto-run security scan
  const [autoScanTrigger, setAutoScanTrigger] = useState(0)

  // Build error state - shared between RuntimePreviewPanel and TerminalPanel
  const [buildError, setBuildError] = useState<string | null>(null)
  const [buildErrorContext, setBuildErrorContext] = useState<{
    category?: string
    rootCause?: string
    suggestions?: string[]
  } | null>(null)

  // Stable callbacks for panels to prevent unnecessary re-renders
  const handleDatabaseError = useCallback((err: Error) => {
    console.error('[ProjectLayout] Database error:', err)
  }, [])
  const handleDatabaseLoad = useCallback(() => {
    console.log('[ProjectLayout] Prisma Studio loaded successfully')
  }, [])
  const handleRuntimeError = useCallback((err: Error) => {
    console.error('[ProjectLayout] Runtime error:', err)
  }, [])
  const handleRuntimeLoad = useCallback(() => {
    console.log('[ProjectLayout] Runtime loaded successfully')
  }, [])
  const handleBuildError = useCallback((error: string, context?: { category?: string; rootCause?: string; canAutoRecover?: boolean; suggestions?: string[] } | null) => {
    console.error('[ProjectLayout] Build error:', error, context)
    setBuildError(error)
    setBuildErrorContext(context ? {
      category: context.category,
      rootCause: context.rootCause,
      suggestions: context.suggestions,
    } : null)
    // Switch to terminal tab to show build errors
    setPreviewMode('terminal')
  }, [])

  // Project state
  // Use transition state if available (from homepage flow) to avoid loading flash
  const [project, setProject] = useState<any>(transitionState?.project ?? null)
  const [isLoading, setIsLoading] = useState(!transitionState?.project)

  // Transition overlay state - for animating from homepage to chat panel
  const chatInputContainerRef = useRef<HTMLDivElement>(null)
  const messageContainerRef = useRef<HTMLDivElement>(null)
  const [transitionOverlayActive, setTransitionOverlayActive] = useState(false)
  const [transitionEndRect, setTransitionEndRect] = useState<DOMRect | null>(null)
  const transitionMeasuredRef = useRef(false)

  // Convert serialized start rect to DOMRect
  const transitionStartRect = transitionState?.transitionStartRect
    ? new DOMRect(
        transitionState.transitionStartRect.left,
        transitionState.transitionStartRect.top,
        transitionState.transitionStartRect.width,
        transitionState.transitionStartRect.height
      )
    : null

  // Clear location state after transition is consumed to prevent re-injection on refresh
  // We use captured transition state above, so clearing here only affects back-button behavior
  useEffect(() => {
    if (transitionState?.initialMessage) {
      window.history.replaceState({}, document.title)
    }
  }, []) // Only run on mount

  // Measure ChatPanel message container and activate transition overlay
  // Animation should target the message area (top of chat) not the input (bottom)
  // Delay measurement so layout is stable; chat panel is on the LEFT so reject rects in the right half
  useEffect(() => {
    if (
      !transitionStartRect ||
      !messageContainerRef.current ||
      transitionMeasuredRef.current ||
      isChatCollapsed
    ) {
      return
    }

    const el = messageContainerRef.current
    let retryTimeoutId: ReturnType<typeof setTimeout> | null = null

    const measureAndActivate = () => {
      if (!el || transitionMeasuredRef.current) return
      const endRect = el.getBoundingClientRect()
      const hasSize = endRect && endRect.width > 0 && endRect.height > 0
      // Chat panel is on the left: endRect.left should be in the left half of the viewport
      // Reject (0,0) or right-side coords that would put the overlay in the wrong place
      const inLeftHalf = typeof window !== 'undefined' && endRect.left < window.innerWidth * 0.6
      const sanePosition = endRect.top >= 0 && endRect.left >= 0
      const isValid = hasSize && inLeftHalf && sanePosition

      if (isValid) {
        transitionMeasuredRef.current = true
        setTransitionEndRect(endRect)
        setTransitionOverlayActive(true)
      }
    }

    const RETRY_MS = 80
    const MAX_RETRIES = 25

    const scheduleRetry = (attempt: number) => {
      if (transitionMeasuredRef.current || attempt >= MAX_RETRIES) return
      retryTimeoutId = setTimeout(() => {
        measureAndActivate()
        if (!transitionMeasuredRef.current) scheduleRetry(attempt + 1)
      }, RETRY_MS)
    }

    const observer = new ResizeObserver(() => measureAndActivate())
    observer.observe(el)

    // Wait for layout to settle before first measure (avoids wrong position / bottom-right flash)
    const startDelay = setTimeout(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          measureAndActivate()
          if (!transitionMeasuredRef.current) scheduleRetry(0)
        })
      })
    }, 150)

    return () => {
      clearTimeout(startDelay)
      observer.disconnect()
      if (retryTimeoutId != null) clearTimeout(retryTimeoutId)
    }
  }, [transitionStartRect, isChatCollapsed])

  // Handle transition overlay completion
  const handleTransitionComplete = useCallback(() => {
    setTransitionOverlayActive(false)
    setTransitionEndRect(null)
  }, [])

  // Check if SDK domains are ready
  const domainsReady = sdkReady && !!store?.projectCollection

  // Load project data using SDK store with retry logic
  // CRITICAL FIX: Skip SDK loading if we already have project from navigation state
  useEffect(() => {
    // If we already have a valid project from transition state, skip loading
    if (project?.id === projectId) {
      console.log('[ProjectLayout] Using project from navigation state:', projectId)
      setIsLoading(false)
      return
    }

    if (!projectId || !domainsReady || !session?.user?.id) {
      return
    }

    let cancelled = false
    const MAX_RETRIES = 10
    const RETRY_DELAY_MS = 500

    // Direct API fallback - used when SDK store fails
    const fetchProjectFromAPI = async (): Promise<any | null> => {
      try {
        console.log('[ProjectLayout] Fetching project directly from API...')
        const response = await fetch(`/api/projects/${projectId}`)
        if (response.ok) {
          const data = await response.json()
          console.log('[ProjectLayout] Got project from API:', data.id)
          return data
        }
      } catch (err) {
        console.warn('[ProjectLayout] Direct API fetch failed:', err)
      }
      return null
    }

    const loadProjectData = async (attempt = 1): Promise<void> => {
      if (cancelled) return

      setIsLoading(true)
      try {
        // Load workspaces first to ensure safeReference can resolve
        // This prevents MST reference errors when loading projects directly
        await store.workspaceCollection.loadAll({ userId: session.user!.id })

        // Load the project from SDK store
        await store.projectCollection.loadAll({ id: projectId })

        if (cancelled) return

        // Find the project in the loaded data
        const proj = store.projectCollection.all.find((p: any) => p.id === projectId)

        if (proj) {
          setProject(proj)
          setIsLoading(false)
        } else {
          // Project not found - could be race condition during creation
          // After 3 attempts, try direct API fetch as fallback
          if (attempt === 3) {
            const apiProject = await fetchProjectFromAPI()
            if (apiProject && !cancelled) {
              setProject(apiProject)
              setIsLoading(false)
              return
            }
          }
          
          // Retry a few more times via SDK
          if (attempt < MAX_RETRIES) {
            // Only log at higher attempts to reduce noise
            if (attempt > 3) {
              console.debug(`[ProjectLayout] Project not found yet, retrying (${attempt}/${MAX_RETRIES})...`)
            }
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * attempt))
            return loadProjectData(attempt + 1)
          }
          
          // Final fallback: try API one more time
          const apiProject = await fetchProjectFromAPI()
          if (apiProject && !cancelled) {
            setProject(apiProject)
            setIsLoading(false)
            return
          }
          
          // Only warn after all retries exhausted
          console.warn("[ProjectLayout] Project not found after retries:", projectId)
          setIsLoading(false)
        }
      } catch (err: any) {
        if (cancelled) return

        // Retry if schema not loaded yet (race condition on page refresh)
        const isSchemaNotLoaded = err?.message?.includes("Schema") || err?.message?.includes("SCHEMA_NOT_FOUND")
        const isTransientError = err?.message?.includes("not found") || err?.message?.includes("temporarily")
        
        if ((isSchemaNotLoaded || isTransientError) && attempt < MAX_RETRIES) {
          if (attempt > 3) {
            console.debug(`[ProjectLayout] Transient error, retrying (${attempt}/${MAX_RETRIES})...`)
          }
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * attempt))
          return loadProjectData(attempt + 1)
        }

        console.error("[ProjectLayout] Failed to load project:", err)
        
        // Last resort: try direct API fetch on error
        const apiProject = await fetchProjectFromAPI()
        if (apiProject && !cancelled) {
          setProject(apiProject)
          setIsLoading(false)
          return
        }
        
        setIsLoading(false)
      }
    }

    loadProjectData()

    return () => {
      cancelled = true
    }
  }, [projectId, domainsReady, store, session?.user?.id, project?.id])

  // Get chat sessions for this project (synchronous - uses in-memory data from SDK store)
  const projectChatSessions: ChatSessionItem[] = projectId
    ? (store?.chatSessionCollection?.all.filter((s: any) => s.contextId === projectId) ?? []).map((s: any) => ({
        id: s.id,
        name: s.name || s.inferredName,
        messageCount: s.messageCount ?? 0,
        updatedAt: s.lastActiveAt,
      }))
    : []

  // Helper to get/set last used chat session from localStorage (fallback for URL navigation loss)
  const getLastSessionFromStorage = useCallback((pid: string): string | null => {
    try {
      return localStorage.getItem(`shogo:lastChatSession:${pid}`)
    } catch {
      return null
    }
  }, [])

  const setLastSessionInStorage = useCallback((pid: string, sessionId: string) => {
    try {
      localStorage.setItem(`shogo:lastChatSession:${pid}`, sessionId)
    } catch {
      // Ignore storage errors
    }
  }, [])

  // Persist current chat session to localStorage when it changes
  useEffect(() => {
    if (projectId && chatSessionId) {
      setLastSessionInStorage(projectId, chatSessionId)
    }
  }, [projectId, chatSessionId, setLastSessionInStorage])

  // Auto-select last chat session or create one if none exists
  // This runs when the project loads and there's no session in the URL
  // Priority: URL param > transition state > localStorage > most recent > create new
  useEffect(() => {
    if (!projectId || !store?.chatSessionCollection || chatSessionId) {
      // Already have a session selected, or not ready yet
      return
    }

    let cancelled = false
    const CHAT_MAX_RETRIES = 5
    const CHAT_RETRY_DELAY_MS = 500

    const initializeChatSession = async (attempt = 1): Promise<void> => {
      if (cancelled) return

      try {
        // IMPORTANT: Load chat sessions from backend first!
        // The in-memory collection may be empty after navigation.
        // loadAll fetches sessions from the API and populates the MobX store.
        console.log("[ProjectLayout] Loading chat sessions from backend for project:", projectId)
        await store.chatSessionCollection.loadAll({ contextId: projectId })

        if (cancelled) return

        // Filter sessions for this project
        const existingSessions = store.chatSessionCollection.all.filter(
          (s: any) => s.contextId === projectId
        )
        
        console.log("[ProjectLayout] Found", existingSessions.length, "existing sessions for project:", projectId)

        if (existingSessions.length > 0) {
          // Priority 1: Check transition state for session ID (from homepage navigation)
          const transitionSessionId = transitionState?.chatSessionId
          if (transitionSessionId) {
            const transitionSession = existingSessions.find((s: any) => s.id === transitionSessionId)
            if (transitionSession) {
              console.log("[ProjectLayout] Restoring session from transition state:", transitionSessionId)
              await setChatSessionId(transitionSessionId)
              return
            }
          }

          // Priority 2: Check localStorage for last used session
          const lastSessionId = getLastSessionFromStorage(projectId)
          if (lastSessionId) {
            const lastSession = existingSessions.find((s: any) => s.id === lastSessionId)
            if (lastSession) {
              console.log("[ProjectLayout] Restoring session from localStorage:", lastSessionId)
              await setChatSessionId(lastSessionId)
              return
            }
            console.log("[ProjectLayout] localStorage session not found in existing sessions:", lastSessionId)
          }

          // Priority 3: Sort by lastActiveAt descending and select the most recent
          const sortedSessions = [...existingSessions].sort(
            (a: any, b: any) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0)
          )
          const mostRecent = sortedSessions[0]
          console.log("[ProjectLayout] Selecting most recent session:", mostRecent.id)
          await setChatSessionId(mostRecent.id)
        } else {
          // No existing sessions - create a new one using SDK domain actions
          const newSession = await actions.createChatSession({
            inferredName: `Chat ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}`,
            contextType: "project",
            contextId: projectId,
          })
          console.log("[ProjectLayout] Created new session:", newSession?.id)
          if (newSession?.id) {
            await setChatSessionId(newSession.id)
          }
        }
      } catch (err: any) {
        if (cancelled) return

        // Retry if schema not loaded yet (race condition on page refresh)
        const isSchemaNotLoaded = err?.message?.includes("Schema") || err?.message?.includes("SCHEMA_NOT_FOUND")
        if (isSchemaNotLoaded && attempt < CHAT_MAX_RETRIES) {
          console.debug(`[ProjectLayout] Chat schema not ready, retrying (${attempt}/${CHAT_MAX_RETRIES})...`)
          await new Promise(resolve => setTimeout(resolve, CHAT_RETRY_DELAY_MS * attempt))
          return initializeChatSession(attempt + 1)
        }

        console.error("[ProjectLayout] Failed to initialize chat session:", err)
      }
    }

    initializeChatSession()

    return () => {
      cancelled = true
    }
  }, [projectId, store, chatSessionId, setChatSessionId, transitionState?.chatSessionId, getLastSessionFromStorage, actions])

  // Session handlers
  const handleSelectSession = useCallback(
    async (sessionId: string) => {
      await setChatSessionId(sessionId)
    },
    [setChatSessionId]
  )

  const handleCreateSession = useCallback(async () => {
    if (!projectId) return
    const newSession = await actions.createChatSession({
      inferredName: `Chat ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}`,
      contextType: "project",
      contextId: projectId,
    })
    if (newSession?.id) {
      await setChatSessionId(newSession.id)
    }
  }, [projectId, setChatSessionId, actions])

  const handleChatSessionChange = useCallback(
    async (sessionId: string) => {
      await setChatSessionId(sessionId)
    },
    [setChatSessionId]
  )

  const handleRenameSession = useCallback(
    async (sessionId: string, newName: string) => {
      if (!store?.chatSessionCollection) return
      await store.chatSessionCollection.update(sessionId, {
        name: newName,
      })
    },
    [store]
  )

  // Project rename handler - using SDK domain actions
  const handleRenameProject = useCallback(
    async (newName: string) => {
      if (!projectId) return
      await actions.updateProject(projectId, { name: newName })
      // Update local state
      setProject((prev: any) => prev ? { ...prev, name: newName } : prev)
    },
    [projectId, actions]
  )

  // Chat sessions toggle handler (triggered by history icon)
  const handleChatSessionsToggle = useCallback(() => {
    setShowChatSessions((prev) => !prev)
  }, [])

  // Chat collapse toggle handler
  const handleChatCollapseToggle = useCallback(() => {
    setIsChatCollapsed((prev) => !prev)
  }, [])

  // Preview controls handlers
  const handleViewportChange = useCallback((viewport: ViewportSize) => {
    setCurrentViewport(viewport)
  }, [])

  const handleRouteChange = useCallback((route: string) => {
    setCurrentRoute(route)
    // TODO: Navigate preview iframe to route
  }, [])

  const handleRefresh = useCallback(() => {
    setCodeRefreshTrigger((prev) => prev + 1)
  }, [])

  const handleOpenExternal = useCallback(async () => {
    if (!projectId) return
    
    if (isOpeningExternal) return // Prevent multiple clicks
    
    setIsOpeningExternal(true)
    
    try {
      // Fetch the preview URL using authenticated HTTP client
      const response = await http.get<{
        url: string
        ready: boolean
        status?: string
        error?: {
          code: string
          message: string
          retryable?: boolean
        }
      }>(`/api/projects/${projectId}/sandbox/url`)
      
      if (response.data?.url) {
        // Build the full preview URL with current route
        let previewUrl = response.data.url
        
        // Append current route if it's not the root path
        if (currentRoute && currentRoute !== '/') {
          try {
            const urlObj = new URL(previewUrl)
            // Ensure route path starts with /
            const routePath = currentRoute.startsWith('/') ? currentRoute : `/${currentRoute}`
            // Append route to pathname, handling trailing slashes
            if (urlObj.pathname === '/' || urlObj.pathname === '') {
              urlObj.pathname = routePath
            } else {
              // Remove trailing slash from pathname if present, then append route
              const cleanPathname = urlObj.pathname.endsWith('/') 
                ? urlObj.pathname.slice(0, -1) 
                : urlObj.pathname
              urlObj.pathname = `${cleanPathname}${routePath}`
            }
            previewUrl = urlObj.toString()
          } catch (urlError) {
            // If URL parsing fails, just append the route as a string
            console.warn('Failed to parse preview URL, appending route as string:', urlError)
            const separator = previewUrl.endsWith('/') ? '' : '/'
            previewUrl = `${previewUrl}${separator}${currentRoute.startsWith('/') ? currentRoute.slice(1) : currentRoute}`
          }
        }
        
        if (response.data?.ready) {
          // Open the preview URL in a new tab
          const newWindow = window.open(previewUrl, '_blank', 'noopener,noreferrer')
          
          if (newWindow) {
            toast({
              title: "Preview opened",
              description: "The preview has been opened in a new tab.",
            })
          } else {
            // Popup blocked
            toast({
              variant: "destructive",
              title: "Popup blocked",
              description: "Please allow popups for this site to open the preview in a new tab.",
            })
          }
        } else {
          // Preview not ready yet - still open it but show a warning
          const status = response.data?.status || 'starting'
          const newWindow = window.open(previewUrl, '_blank', 'noopener,noreferrer')
          
          if (newWindow) {
            toast({
              title: "Preview opening",
              description: `The preview is ${status}. It may take a moment to load.`,
            })
          } else {
            toast({
              variant: "destructive",
              title: "Popup blocked",
              description: "Please allow popups for this site to open the preview in a new tab.",
            })
          }
        }
      } else {
        const errorMessage = response.data?.error?.message || 'Preview URL not available'
        toast({
          variant: "destructive",
          title: "Failed to open preview",
          description: errorMessage,
        })
        console.error('Failed to get preview URL:', errorMessage)
      }
    } catch (err: any) {
      const errorMessage = err?.response?.data?.error?.message || err?.message || 'Failed to open preview in new tab'
      toast({
        variant: "destructive",
        title: "Error",
        description: errorMessage,
      })
      console.error('Error opening preview in new tab:', err)
    } finally {
      setIsOpeningExternal(false)
    }
  }, [projectId, http, currentRoute, isOpeningExternal, toast])

  // Publish handlers
  const handlePublish = useCallback(
    async (data: {
      subdomain: string
      accessLevel: "anyone" | "authenticated" | "private"
      siteTitle?: string
      siteDescription?: string
    }) => {
      if (!projectId) throw new Error("No project ID")

      const response = await fetch(`/api/projects/${projectId}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error?.message || "Failed to publish")
      }

      const result = await response.json()

      // Update local project state with publish info
      setProject((prev: any) =>
        prev
          ? {
              ...prev,
              publishedSubdomain: data.subdomain,
              publishedAt: result.publishedAt,
              accessLevel: data.accessLevel,
              siteTitle: data.siteTitle,
              siteDescription: data.siteDescription,
            }
          : prev
      )

      return result
    },
    [projectId]
  )

  const handleUnpublish = useCallback(async () => {
    if (!projectId) throw new Error("No project ID")

    const response = await fetch(`/api/projects/${projectId}/unpublish`, {
      method: "POST",
    })

    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.error?.message || "Failed to unpublish")
    }

    // Clear publish info from local project state
    setProject((prev: any) =>
      prev
        ? {
            ...prev,
            publishedSubdomain: undefined,
            publishedAt: undefined,
            accessLevel: undefined,
            siteTitle: undefined,
            siteDescription: undefined,
          }
        : prev
    )
  }, [projectId])

  const handleUpdatePublishSettings = useCallback(
    async (data: {
      accessLevel?: "anyone" | "authenticated" | "private"
      siteTitle?: string
      siteDescription?: string
    }) => {
      if (!projectId) throw new Error("No project ID")

      const response = await fetch(`/api/projects/${projectId}/publish`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error?.message || "Failed to update settings")
      }

      // Update local project state
      setProject((prev: any) =>
        prev
          ? {
              ...prev,
              ...(data.accessLevel !== undefined && { accessLevel: data.accessLevel }),
              ...(data.siteTitle !== undefined && { siteTitle: data.siteTitle }),
              ...(data.siteDescription !== undefined && { siteDescription: data.siteDescription }),
            }
          : prev
      )
    },
    [projectId]
  )

  // Current user info from session
  const currentUserName = session?.user?.name?.split(" ")[0] || "You"
  const userInitial = session?.user?.name?.charAt(0).toUpperCase() || "U"

  // Get workspace ID for credit lookup
  // Use workspaceId (plain string) instead of workspace reference to avoid MST InvalidReferenceError
  const workspaceId = project?.workspaceId || null

  // Load and get credits from SDK store
  useEffect(() => {
    if (workspaceId && store?.creditLedgerCollection) {
      store.creditLedgerCollection.loadAll({ workspaceId }).catch((err: any) => {
        console.error("[ProjectLayout] Failed to load credit ledger:", err)
      })
    }
  }, [workspaceId, store])

  const creditLedger = workspaceId
    ? store?.creditLedgerCollection?.all.find((l: any) => l.workspaceId === workspaceId)
    : null
  // Compute effective balance from raw credit ledger fields
  const effectiveBalance = creditLedger ? {
    dailyCredits: creditLedger.dailyCredits ?? 0,
    monthlyCredits: creditLedger.monthlyCredits ?? 0,
    rolloverCredits: creditLedger.rolloverCredits ?? 0,
    total: (creditLedger.dailyCredits ?? 0) + (creditLedger.monthlyCredits ?? 0) + (creditLedger.rolloverCredits ?? 0),
  } : null
  const creditsRemaining = effectiveBalance?.total ?? 5
  const maxCredits = effectiveBalance ? (effectiveBalance.dailyCredits + effectiveBalance.monthlyCredits + effectiveBalance.rolloverCredits) : 5

  // Loading state
  if (isLoading || !project) {
    return (
      <div className="h-screen flex flex-col bg-background">
        <ProjectTopBar
          projectName="Loading..."
          projectId={projectId || ""}
          showChatSessions={showChatSessions}
          isChatCollapsed={isChatCollapsed}
          onChatSessionsToggle={handleChatSessionsToggle}
          onChatCollapseToggle={handleChatCollapseToggle}
        />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-muted-foreground animate-pulse">Loading project...</div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-screen flex flex-col bg-background">
        {/* Project top bar - Lovable.dev style */}
        <ProjectTopBar
          projectName={project.name}
          projectId={projectId || ""}
          credits={creditsRemaining}
          maxCredits={maxCredits}
          currentUserName={currentUserName}
          userInitial={userInitial}
          // Publish state props
          isPublished={!!project.publishedSubdomain}
          publishedAt={project.publishedAt ? new Date(project.publishedAt) : undefined}
          publishedSubdomain={project.publishedSubdomain}
          accessLevel={project.accessLevel}
          siteTitle={project.siteTitle}
          siteDescription={project.siteDescription}
          showChatSessions={showChatSessions}
          isChatCollapsed={isChatCollapsed}
          onChatSessionsToggle={handleChatSessionsToggle}
          onChatCollapseToggle={handleChatCollapseToggle}
          onRename={handleRenameProject}
          currentViewport={currentViewport}
          onViewportChange={handleViewportChange}
          currentRoute={currentRoute}
          onRouteChange={handleRouteChange}
          onRefresh={handleRefresh}
          onOpenPreview={() => setPreviewMode('runtime')}
          onOpenExternal={handleOpenExternal}
          onOpenCode={() => setPreviewMode('code')}
          isOpeningExternal={isOpeningExternal}
          // Publish callbacks
          onPublish={handlePublish}
          onUnpublish={handleUnpublish}
          onUpdatePublishSettings={handleUpdatePublishSettings}
        />

        {/* Main content: Chat/History panel (LEFT) + Preview/Workspace (RIGHT) */}
        <div className="flex-1 flex min-h-0">
          {/* Left Panel Container - Chat or History */}
          {/* BUG FIX: ChatPanel stays mounted when collapsed to preserve streaming state */}
          {/* Uses visibility:hidden instead of conditional rendering to keep useChat hook alive */}
          <div
            className={cn(
              "shrink-0 flex flex-col transition-all duration-200 bg-card",
              isChatCollapsed && "w-0 overflow-hidden"
            )}
            style={!isChatCollapsed ? { minWidth: `${chatWidth}px` } : undefined}
          >
            {/* Chat Sessions Panel - only rendered when visible (stateless) */}
            {showChatSessions && !isChatCollapsed && (
              <ChatSessionsPanel
                sessions={projectChatSessions}
                currentSessionId={chatSessionId ?? undefined}
                onSelect={(sessionId) => {
                  handleSelectSession(sessionId)
                  setShowChatSessions(false) // Close panel after selection
                }}
                onCreate={() => {
                  handleCreateSession()
                  setShowChatSessions(false) // Close panel after creation
                }}
                onRename={handleRenameSession}
                className="flex-1"
              />
            )}
            {/* Chat Panel - stays mounted to preserve streaming state when collapsed */}
            {/* credit-tracking: Pass workspaceId and userId for credit deduction */}
            {/* Handle both resolved MST reference (object with .id) and unresolved (string) */}
            <div
              className={cn(
                "flex-1 min-h-0 flex flex-col",
                (isChatCollapsed || showChatSessions) && "invisible absolute pointer-events-none"
              )}
            >
              <ChatPanel
                featureId={projectId ?? null}
                featureName={project.name}
                phase={null}
                chatSessionId={chatSessionId}
                onChatSessionChange={handleChatSessionChange}
                isCollapsed={isChatCollapsed}
                onCollapsedChange={setIsChatCollapsed}
                onWidthChange={setChatWidth}
                workspaceId={project?.workspaceId}
                userId={session?.user?.id}
                projectId={projectId}
                className="flex-1 min-h-0"
                initialMessage={transitionState?.initialMessage}
                inputContainerRef={chatInputContainerRef}
                messageContainerRef={messageContainerRef}
              onChatError={setChatError}
              injectMessage={securityFixMessage}
              onFilesChanged={(paths) => {
                console.log('[ProjectLayout] 📁 Agent modified files:', paths)
                // Increment refresh trigger to reload code editor
                // Preview auto-refresh is handled by SSE build events from Vite
                setCodeRefreshTrigger(prev => prev + 1)
                // Auto-trigger background security scan after AI modifies files
                setAutoScanTrigger(prev => prev + 1)
              }}
              onActiveToolCall={(toolName) => {
                // Track template_copy for preview overlay
                const isTemplateTool = toolName?.includes('template_copy') || toolName?.includes('template.copy')
                setIsTemplateCopying(isTemplateTool === true)
              }}
              />
            </div>
          </div>

          {/* Separator - subtle vertical line */}
          {!isChatCollapsed && (
            <div className="w-px bg-border/60" />
          )}

          {/* Preview/Workspace Container - with border styling */}
          <div className="flex-1 min-w-0 overflow-hidden p-3 bg-muted/30">
            {/* Preview Mode Toggle (subtle tabs) */}
            <div className="flex items-center gap-1 mb-2">
              <button
                onClick={() => setPreviewMode('runtime')}
                className={cn(
                  "px-3 py-1 text-xs font-medium rounded-md transition-colors",
                  previewMode === 'runtime'
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                )}
              >
                Preview
              </button>
              <button
                onClick={() => setPreviewMode('code')}
                className={cn(
                  "px-3 py-1 text-xs font-medium rounded-md transition-colors",
                  previewMode === 'code'
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                )}
              >
                Code
              </button>
              <button
                onClick={() => setPreviewMode('terminal')}
                className={cn(
                  "px-3 py-1 text-xs font-medium rounded-md transition-colors",
                  previewMode === 'terminal'
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                )}
              >
                Terminal
              </button>
              <button
                onClick={() => setPreviewMode('database')}
                className={cn(
                  "px-3 py-1 text-xs font-medium rounded-md transition-colors",
                  previewMode === 'database'
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                )}
              >
                Database
              </button>
              <button
                onClick={() => setPreviewMode('tests')}
                className={cn(
                  "px-3 py-1 text-xs font-medium rounded-md transition-colors",
                  previewMode === 'tests'
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                )}
              >
                Tests
              </button>
              <button
                onClick={() => setPreviewMode('security')}
                className={cn(
                  "px-3 py-1 text-xs font-medium rounded-md transition-colors",
                  previewMode === 'security'
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                )}
              >
                Security
              </button>
              <button
                onClick={() => setPreviewMode('history')}
                className={cn(
                  "px-3 py-1 text-xs font-medium rounded-md transition-colors",
                  previewMode === 'history'
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                )}
              >
                History
              </button>
            </div>

            {/* Preview Frame with border - all panels stay mounted for state persistence */}
            <div className="h-[calc(100%-32px)] w-full rounded-lg border border-border/40 bg-background shadow-sm overflow-hidden relative">
              {/* Runtime Preview - stays mounted to preserve iframe state */}
              <div className={cn(
                "absolute inset-0",
                previewMode !== 'runtime' && "invisible pointer-events-none"
              )}>
                <RuntimePreviewPanel
                  projectId={projectId || ''}
                  className="h-full"
                  onError={handleRuntimeError}
                  onLoad={handleRuntimeLoad}
                  viewport={currentViewport}
                  onBuildError={handleBuildError}
                  forceRefresh={codeRefreshTrigger}
                  isTemplateCopying={isTemplateCopying}
                  chatError={chatError}
                />
              </div>
              {/* Code Editor - stays mounted to preserve editor state */}
              <div className={cn(
                "absolute inset-0",
                previewMode !== 'code' && "invisible pointer-events-none"
              )}>
                <CodeEditorPanel
                  projectId={projectId || ''}
                  className="h-full"
                  refreshTrigger={codeRefreshTrigger}
                />
              </div>
              {/* Terminal Panel - stays mounted for output persistence */}
              <div className={cn(
                "absolute inset-0",
                previewMode !== 'terminal' && "invisible pointer-events-none"
              )}>
                <TerminalPanel
                  projectId={projectId || ''}
                  className="h-full"
                  onRestartServer={async () => {
                    try {
                      await fetch(`/api/projects/${projectId}/runtime/restart`, { method: 'POST' })
                    } catch (err) {
                      console.error('[ProjectLayout] Failed to restart runtime:', err)
                    }
                  }}
                  buildError={buildError}
                  buildErrorContext={buildErrorContext}
                  onRebuild={async () => {
                    try {
                      // Get sandbox URL to call rebuild endpoint on the agent server
                      const sandboxResponse = await fetch(`/api/projects/${projectId}/sandbox/url`)
                      if (!sandboxResponse.ok) {
                        console.error('[ProjectLayout] Failed to get sandbox URL')
                        return
                      }
                      const sandboxData = await sandboxResponse.json()
                      // Use agentUrl (project-runtime) for rebuild, not the Vite URL
                      const baseUrl = sandboxData.agentUrl || (() => { const u = new URL(sandboxData.url); return `${u.protocol}//${u.host}` })()
                      
                      const response = await fetch(`${baseUrl}/preview/rebuild`, { method: 'POST' })
                      const data = await response.json()
                      
                      if (data.success) {
                        // Clear build error on successful rebuild
                        setBuildError(null)
                        setBuildErrorContext(null)
                        // Switch back to preview
                        setPreviewMode('runtime')
                      }
                    } catch (err) {
                      console.error('[ProjectLayout] Failed to trigger rebuild:', err)
                    }
                  }}
                />
              </div>
              {/* Database Panel - Prisma Studio iframe */}
              <div className={cn(
                "absolute inset-0",
                previewMode !== 'database' && "invisible pointer-events-none"
              )}>
                <DatabasePanel
                  projectId={projectId || ''}
                  className="h-full"
                  onError={handleDatabaseError}
                  onLoad={handleDatabaseLoad}
                />
              </div>
              {/* Test Panel - Playwright E2E test runner */}
              <div className={cn(
                "absolute inset-0",
                previewMode !== 'tests' && "invisible pointer-events-none"
              )}>
                <TestPanel
                  projectId={projectId || ''}
                  className="h-full"
                />
              </div>
              {/* Security Panel - Automated security scanning */}
              <div className={cn(
                "absolute inset-0",
                previewMode !== 'security' && "invisible pointer-events-none"
              )}>
                <SecurityPanel
                  projectId={projectId || ''}
                  className="h-full"
                  autoScanTrigger={autoScanTrigger}
                  onFixWithAI={(message) => {
                    // Uncollapse chat panel so the user can see the AI working
                    if (isChatCollapsed) setIsChatCollapsed(false)
                    // Close chat sessions panel if open
                    if (showChatSessions) setShowChatSessions(false)
                    // Inject the message directly into the chat — it auto-sends
                    // Nonce ensures each click produces a unique string for dedup
                    securityFixNonceRef.current += 1
                    setSecurityFixMessage(`${message}\n\n[nonce:${securityFixNonceRef.current}]`)
                  }}
                />
              </div>
              {/* History Panel - Version control checkpoints */}
              <div className={cn(
                "absolute inset-0",
                previewMode !== 'history' && "invisible pointer-events-none"
              )}>
                <HistoryPanel
                  projectId={projectId || ''}
                  className="h-full"
                  onCheckpointCreated={() => {
                    // Refresh code editor and preview after checkpoint
                    setCodeRefreshTrigger(prev => prev + 1)
                  }}
                  onRollbackComplete={() => {
                    // Refresh code editor and preview after rollback
                    setCodeRefreshTrigger(prev => prev + 1)
                  }}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Transition overlay - animates input from homepage to chat panel position */}
        {transitionStartRect && transitionEndRect && (
          <ChatPanelTransitionOverlay
            startRect={transitionStartRect}
            endRect={transitionEndRect}
            promptText={transitionState?.transitionPromptText ?? ""}
            onComplete={handleTransitionComplete}
            isActive={transitionOverlayActive}
            duration={400}
          />
        )}
      </div>
  )
})
