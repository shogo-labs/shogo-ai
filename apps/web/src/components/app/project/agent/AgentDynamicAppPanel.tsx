/**
 * AgentDynamicAppPanel
 *
 * Panel wrapper that connects to the agent runtime's SSE stream and renders
 * all active surfaces. Supports per-project theme switching for the canvas.
 */

import { useState, useEffect, useMemo, useRef, useCallback, type CSSProperties } from 'react'
import { cn } from '@/lib/utils'
import {
  LayoutDashboard, Wifi, WifiOff, RefreshCw,
  Zap, MessageSquare, Calendar, ListTodo, Bot, Send,
  CheckCircle2, Circle, Loader2,
} from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { useDynamicAppStream } from './dynamic-app/use-dynamic-app-stream'
import { DynamicAppRenderer } from './dynamic-app/DynamicAppRenderer'
import { CanvasErrorBoundary } from './dynamic-app/CanvasErrorBoundary'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ThemeSelector } from '@/components/app/shared/ThemeSelector'
import { getThemeById, getDefaultTheme } from '@/lib/themes/presets'
import type { ThemeColors } from '@/lib/themes/types'

function getCanvasThemeStorageKey(projectId: string) {
  return `shogo-canvas-theme-${projectId}`
}

function hsl(v: string) { return `hsl(${v})` }

function themeColorsToStyleVars(colors: ThemeColors): CSSProperties {
  // Must set both --<name> (raw CSS vars) AND --color-<name> (Tailwind v4 @theme vars)
  // because Tailwind v4 @theme registered properties resolve at :root, not at the element
  return {
    '--background': hsl(colors.background),
    '--foreground': hsl(colors.foreground),
    '--card': hsl(colors.card.DEFAULT),
    '--card-foreground': hsl(colors.card.foreground),
    '--popover': hsl(colors.popover.DEFAULT),
    '--popover-foreground': hsl(colors.popover.foreground),
    '--primary': hsl(colors.primary.DEFAULT),
    '--primary-foreground': hsl(colors.primary.foreground),
    '--secondary': hsl(colors.secondary.DEFAULT),
    '--secondary-foreground': hsl(colors.secondary.foreground),
    '--muted': hsl(colors.muted.DEFAULT),
    '--muted-foreground': hsl(colors.muted.foreground),
    '--accent': hsl(colors.accent.DEFAULT),
    '--accent-foreground': hsl(colors.accent.foreground),
    '--destructive': hsl(colors.destructive.DEFAULT),
    '--destructive-foreground': hsl(colors.destructive.foreground),
    '--border': hsl(colors.border),
    '--input': hsl(colors.input),
    '--ring': hsl(colors.ring),
    '--color-background': hsl(colors.background),
    '--color-foreground': hsl(colors.foreground),
    '--color-card': hsl(colors.card.DEFAULT),
    '--color-card-foreground': hsl(colors.card.foreground),
    '--color-popover': hsl(colors.popover.DEFAULT),
    '--color-popover-foreground': hsl(colors.popover.foreground),
    '--color-primary': hsl(colors.primary.DEFAULT),
    '--color-primary-foreground': hsl(colors.primary.foreground),
    '--color-secondary': hsl(colors.secondary.DEFAULT),
    '--color-secondary-foreground': hsl(colors.secondary.foreground),
    '--color-muted': hsl(colors.muted.DEFAULT),
    '--color-muted-foreground': hsl(colors.muted.foreground),
    '--color-accent': hsl(colors.accent.DEFAULT),
    '--color-accent-foreground': hsl(colors.accent.foreground),
    '--color-destructive': hsl(colors.destructive.DEFAULT),
    '--color-destructive-foreground': hsl(colors.destructive.foreground),
    '--color-border': hsl(colors.border),
    '--color-input': hsl(colors.input),
    '--color-ring': hsl(colors.ring),
  } as CSSProperties
}

interface AgentDynamicAppPanelProps {
  projectId: string
  visible: boolean
  localAgentUrl?: string | null
}

export function AgentDynamicAppPanel({ projectId, visible, localAgentUrl }: AgentDynamicAppPanelProps) {
  const [agentUrl, setAgentUrl] = useState<string | null>(null)

  // Canvas theme state, persisted per project
  const [canvasThemeId, setCanvasThemeId] = useState<string>(() => {
    if (!projectId) return 'default'
    try {
      return localStorage.getItem(getCanvasThemeStorageKey(projectId)) || 'default'
    } catch {
      return 'default'
    }
  })

  const handleSelectTheme = (themeId: string) => {
    setCanvasThemeId(themeId)
    try {
      localStorage.setItem(getCanvasThemeStorageKey(projectId), themeId)
    } catch {}
  }

  // Detect dark mode
  const [isDark, setIsDark] = useState(() =>
    document.documentElement.classList.contains('dark')
  )
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains('dark'))
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  // Build scoped CSS variables for the canvas content
  const canvasThemeStyle = useMemo(() => {
    const theme = getThemeById(canvasThemeId) ?? getDefaultTheme()
    const colors = isDark ? theme.dark : theme.light
    return {
      ...themeColorsToStyleVars(colors),
      '--radius': `${theme.effects?.radius ?? '0.5'}rem`,
      backgroundColor: hsl(colors.background),
      color: hsl(colors.foreground),
    } as CSSProperties
  }, [canvasThemeId, isDark])

  useEffect(() => {
    if (localAgentUrl) {
      setAgentUrl(localAgentUrl)
      return
    }

    if (!projectId) return
    let cancelled = false

    ;(async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/sandbox/url`)
        if (!res.ok) return
        const data = await res.json()
        if (!cancelled) {
          setAgentUrl(data.agentUrl || data.url)
        }
      } catch {}
    })()

    return () => { cancelled = true }
  }, [projectId, localAgentUrl])

  const { surfaces, connected, connecting, error, dispatchAction, updateLocalData, reconnect } = useDynamicAppStream(
    visible ? agentUrl : null
  )

  const [isRefreshing, setIsRefreshing] = useState(false)
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const handleRefresh = useCallback(() => {
    if (isRefreshing) return
    setIsRefreshing(true)
    reconnect()
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
    refreshTimerRef.current = setTimeout(() => setIsRefreshing(false), 1200)
  }, [reconnect, isRefreshing])
  useEffect(() => () => { if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current) }, [])

  const [selectedSurfaceId, setSelectedSurfaceId] = useState<string | null>(null)
  const prevSurfaceIdsRef = useRef<Set<string>>(new Set())

  const surfaceList = useMemo(() => [...surfaces.values()], [surfaces])

  // Auto-select the most recently added surface
  useEffect(() => {
    const currentIds = new Set(surfaces.keys())

    // Find newly added surfaces
    for (const id of currentIds) {
      if (!prevSurfaceIdsRef.current.has(id)) {
        setSelectedSurfaceId(id)
        break
      }
    }

    // If selected surface was deleted, fall back to the last surface
    if (selectedSurfaceId && !currentIds.has(selectedSurfaceId)) {
      const ids = [...currentIds]
      setSelectedSurfaceId(ids.length > 0 ? ids[ids.length - 1] : null)
    }

    // If nothing selected yet but surfaces exist, select the first
    if (!selectedSurfaceId && currentIds.size > 0) {
      setSelectedSurfaceId([...currentIds][0])
    }

    prevSurfaceIdsRef.current = currentIds
  }, [surfaces, selectedSurfaceId])

  const activeSurface = selectedSurfaceId ? surfaces.get(selectedSurfaceId) : null
  const hasSurfaces = surfaces.size > 0

  return (
    <div className={cn('absolute inset-0 flex flex-col', !visible && 'invisible pointer-events-none')}>
      {/* Status Bar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b bg-muted/30 shrink-0">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <LayoutDashboard className="size-3.5" />
          {surfaceList.length > 1 && selectedSurfaceId ? (
            <Select value={selectedSurfaceId} onValueChange={setSelectedSurfaceId}>
              <SelectTrigger className="h-6 text-xs gap-1 border-none bg-transparent shadow-none px-1 py-0 min-w-0 w-auto">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {surfaceList.map((s) => (
                  <SelectItem key={s.surfaceId} value={s.surfaceId} className="text-xs">
                    {s.title || s.surfaceId}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <span>{activeSurface?.title || 'Canvas'}</span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <ThemeSelector
            selectedThemeId={canvasThemeId}
            onSelectTheme={handleSelectTheme}
            variant="compact"
          />

          <div className="w-px h-3.5 bg-border/60 mx-0.5" />

          {error && (
            <span className="text-xs text-amber-500 mr-1">{error}</span>
          )}

          {connected ? (
            <div className="flex items-center gap-1 text-xs text-emerald-500">
              <Wifi className="size-3" />
              <span>Connected</span>
            </div>
          ) : agentUrl ? (
            <button
              type="button"
              onClick={handleRefresh}
              className={cn(
                'flex items-center gap-1 text-xs text-amber-500',
                'hover:text-amber-400 transition-colors',
              )}
              title="Click to reconnect"
            >
              <WifiOff className="size-3" />
              <span>Disconnected</span>
            </button>
          ) : (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              <span>Connecting...</span>
            </div>
          )}

          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            className={cn(
              'ml-0.5 p-1 rounded-md transition-all duration-150',
              'text-muted-foreground/60 hover:text-foreground hover:bg-muted',
              'disabled:pointer-events-none',
              isRefreshing && 'text-primary',
            )}
            title="Refresh canvas"
          >
            <RefreshCw className={cn('size-3', isRefreshing && 'animate-spin')} />
          </button>
        </div>
      </div>

      {/* Content Area — scoped theme via CSS variables */}
      <div className="flex-1 overflow-hidden rounded-b-lg" style={canvasThemeStyle}>
        {hasSurfaces && activeSurface ? (
          <CanvasErrorBoundary key={activeSurface.surfaceId} surfaceTitle={activeSurface.title}>
            <ScrollArea className="h-full">
              <DynamicAppRenderer
                surface={activeSurface}
                agentUrl={agentUrl}
                onAction={dispatchAction}
                onDataChange={updateLocalData}
              />
            </ScrollArea>
          </CanvasErrorBoundary>
        ) : (
          <EmptyState
            connected={connected}
            agentUrl={agentUrl}
          />
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Loading Phases
// ---------------------------------------------------------------------------

type LoadingPhase = 'initializing' | 'starting' | 'connecting' | 'ready'

const PHASE_CONFIG: { id: LoadingPhase; label: string; duration: number }[] = [
  { id: 'initializing', label: 'Initializing environment', duration: 2000 },
  { id: 'starting', label: 'Starting agent runtime', duration: 4000 },
  { id: 'connecting', label: 'Connecting to agent', duration: 3000 },
  { id: 'ready', label: 'Ready', duration: 0 },
]

function useLoadingPhase(agentUrl: string | null, connected: boolean): LoadingPhase {
  const [phase, setPhase] = useState<LoadingPhase>('initializing')
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    if (connected) {
      setPhase('ready')
      return
    }
    if (agentUrl && !connected) {
      setPhase('connecting')
      return
    }

    setPhase('initializing')
    timerRef.current = setTimeout(() => {
      setPhase('starting')
    }, PHASE_CONFIG[0].duration)

    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [agentUrl, connected])

  return phase
}

// ---------------------------------------------------------------------------
// Skeleton Dashboard
// ---------------------------------------------------------------------------

function SkeletonDashboard() {
  return (
    <div className="absolute inset-0 p-6 opacity-[0.04] pointer-events-none select-none">
      <div className="flex gap-4 mb-6">
        <Skeleton className="h-20 flex-1 rounded-xl" />
        <Skeleton className="h-20 flex-1 rounded-xl" />
        <Skeleton className="h-20 flex-1 rounded-xl" />
      </div>
      <div className="flex gap-4 mb-6">
        <div className="flex-[2] space-y-3">
          <Skeleton className="h-5 w-32 rounded-md" />
          <Skeleton className="h-12 w-full rounded-lg" />
          <Skeleton className="h-12 w-full rounded-lg" />
          <Skeleton className="h-12 w-full rounded-lg" />
          <Skeleton className="h-12 w-3/4 rounded-lg" />
        </div>
        <div className="flex-1 space-y-3">
          <Skeleton className="h-5 w-24 rounded-md" />
          <Skeleton className="h-40 w-full rounded-lg" />
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Phase Progress Indicator
// ---------------------------------------------------------------------------

function PhaseProgress({ currentPhase }: { currentPhase: LoadingPhase }) {
  const currentIdx = PHASE_CONFIG.findIndex(p => p.id === currentPhase)

  return (
    <div className="flex flex-col gap-2.5 w-full max-w-[240px]">
      {PHASE_CONFIG.slice(0, -1).map((phase, idx) => {
        const isComplete = idx < currentIdx
        const isActive = idx === currentIdx
        return (
          <div key={phase.id} className="flex items-center gap-2.5">
            {isComplete ? (
              <CheckCircle2 className="size-4 text-emerald-500 shrink-0" />
            ) : isActive ? (
              <Loader2 className="size-4 text-primary animate-spin shrink-0" />
            ) : (
              <Circle className="size-4 text-muted-foreground/40 shrink-0" />
            )}
            <span
              className={cn(
                'text-xs transition-colors duration-300',
                isComplete && 'text-emerald-500',
                isActive && 'text-foreground font-medium',
                !isComplete && !isActive && 'text-muted-foreground/50',
              )}
            >
              {phase.label}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Welcome Card (connected, no surfaces)
// ---------------------------------------------------------------------------

const QUICK_PROMPTS = [
  { icon: ListTodo, label: 'Build a task manager' },
  { icon: Calendar, label: 'Show a daily planner' },
  { icon: MessageSquare, label: 'Create a feedback form' },
  { icon: Bot, label: 'Set up a personal dashboard' },
]

function WelcomeCard() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-8 px-8 text-center">
      <div className="space-y-3">
        <div className="mx-auto w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center">
          <Zap className="size-7 text-primary" />
        </div>
        <h3 className="text-lg font-semibold">Your canvas is ready</h3>
        <p className="text-sm text-muted-foreground max-w-sm">
          Ask your agent to build interactive UIs. They&apos;ll appear here in real time.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2.5 w-full max-w-md">
        {QUICK_PROMPTS.map((item) => (
          <button
            key={item.label}
            type="button"
            className={cn(
              'group flex items-center gap-2.5 rounded-lg border border-border/60 bg-card px-3.5 py-3 text-left',
              'transition-all duration-150 hover:border-primary/40 hover:bg-primary/5',
              'cursor-default',
            )}
          >
            <item.icon className="size-4 text-muted-foreground group-hover:text-primary shrink-0 transition-colors" />
            <span className="text-xs text-muted-foreground group-hover:text-foreground transition-colors">
              {item.label}
            </span>
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2 text-xs text-muted-foreground/60">
        <Send className="size-3" />
        <span>Type a prompt in the chat panel to get started</span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Empty State (Orchestrator)
// ---------------------------------------------------------------------------

function EmptyState({
  connected,
  agentUrl,
}: {
  connected: boolean
  agentUrl: string | null
}) {
  const phase = useLoadingPhase(agentUrl, connected)

  if (connected) {
    return <WelcomeCard />
  }

  return (
    <div className="relative h-full">
      <SkeletonDashboard />
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 px-8">
        <div className="flex flex-col items-center gap-5">
          <div className="relative">
            <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
              <Bot className="size-6 text-primary" />
            </div>
            <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-background flex items-center justify-center">
              <div className="w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse" />
            </div>
          </div>
          <div className="text-center space-y-1">
            <p className="text-sm font-medium">Setting up your agent</p>
            <p className="text-xs text-muted-foreground">This usually takes a few seconds</p>
          </div>
        </div>
        <PhaseProgress currentPhase={phase} />
      </div>
    </div>
  )
}
