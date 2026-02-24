/**
 * AgentDynamicAppPanel
 *
 * Panel wrapper that connects to the agent runtime's SSE stream and renders
 * all active surfaces. Supports per-project theme switching, viewport preview
 * (mobile/tablet/desktop/wide), and opening the canvas in a new tab.
 */

import { useState, useEffect, useMemo, useRef, useCallback, type CSSProperties } from 'react'
import { cn } from '@/lib/utils'
import {
  LayoutDashboard,
  Wifi,
  WifiOff,
  RefreshCw,
  Smartphone,
  Tablet,
  Monitor,
  MonitorPlay,
  ExternalLink,
} from 'lucide-react'
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

// ---------------------------------------------------------------------------
// Viewport definitions
// ---------------------------------------------------------------------------

type CanvasViewport = 'mobile' | 'tablet' | 'desktop' | 'wide'

const CANVAS_VIEWPORTS: Record<CanvasViewport, { width: number; icon: React.ElementType; label: string }> = {
  mobile:  { width: 375,  icon: Smartphone,  label: 'Mobile' },
  tablet:  { width: 768,  icon: Tablet,      label: 'Tablet' },
  desktop: { width: 1024, icon: Monitor,     label: 'Desktop' },
  wide:    { width: 0,    icon: MonitorPlay,  label: 'Full width' },
}

// ---------------------------------------------------------------------------
// Theme helpers
// ---------------------------------------------------------------------------

function getCanvasThemeStorageKey(projectId: string) {
  return `shogo-canvas-theme-${projectId}`
}

function getCanvasViewportStorageKey(projectId: string) {
  return `shogo-canvas-viewport-${projectId}`
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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

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

  // Viewport state, persisted per project
  const [viewport, setViewport] = useState<CanvasViewport>(() => {
    if (!projectId) return 'wide'
    try {
      const saved = localStorage.getItem(getCanvasViewportStorageKey(projectId))
      if (saved && saved in CANVAS_VIEWPORTS) return saved as CanvasViewport
    } catch {}
    return 'wide'
  })

  const handleSelectTheme = (themeId: string) => {
    setCanvasThemeId(themeId)
    try {
      localStorage.setItem(getCanvasThemeStorageKey(projectId), themeId)
    } catch {}
  }

  const handleViewportChange = useCallback((vp: CanvasViewport) => {
    setViewport(vp)
    try {
      localStorage.setItem(getCanvasViewportStorageKey(projectId), vp)
    } catch {}
  }, [projectId])

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

  const handleOpenNewTab = useCallback(() => {
    const url = `/projects/${projectId}/canvas-preview`
    window.open(url, '_blank', 'noopener,noreferrer')
  }, [projectId])

  const handleRefresh = useCallback(() => {
    reconnect()
  }, [reconnect])

  const viewportWidth = CANVAS_VIEWPORTS[viewport].width

  return (
    <div className={cn('absolute inset-0 flex flex-col', !visible && 'invisible pointer-events-none')}>
      {/* Preview Toolbar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b bg-muted/30 shrink-0 gap-2">
        {/* Left: Surface selector */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground min-w-0">
          <LayoutDashboard className="size-3.5 shrink-0" />
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
            <span className="truncate">{activeSurface?.title || 'Canvas'}</span>
          )}
        </div>

        {/* Center: Viewport controls */}
        <div className="flex items-center gap-1">
          <div className="flex items-center rounded-md bg-muted/50 p-0.5">
            {(Object.entries(CANVAS_VIEWPORTS) as [CanvasViewport, typeof CANVAS_VIEWPORTS[CanvasViewport]][]).map(
              ([size, { icon: Icon, label }]) => (
                <button
                  key={size}
                  title={label}
                  onClick={() => handleViewportChange(size)}
                  className={cn(
                    'h-6 w-6 flex items-center justify-center rounded-sm transition-colors',
                    'text-muted-foreground hover:text-foreground',
                    viewport === size && 'bg-background text-foreground shadow-sm'
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                </button>
              )
            )}
          </div>
        </div>

        {/* Right: Theme, refresh, open new tab, connection status */}
        <div className="flex items-center gap-1.5 shrink-0">
          <ThemeSelector
            selectedThemeId={canvasThemeId}
            onSelectTheme={handleSelectTheme}
            variant="compact"
          />

          <div className="h-4 w-px bg-border/60" />

          <button
            onClick={handleRefresh}
            title="Refresh canvas"
            className="h-6 w-6 flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', connecting && 'animate-spin')} />
          </button>

          <button
            onClick={handleOpenNewTab}
            title="Open canvas in new tab"
            className="h-6 w-6 flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>

          <div className="h-4 w-px bg-border/60" />

          {error && (
            <span className="text-xs text-amber-500 max-w-[120px] truncate">{error}</span>
          )}
          {connected ? (
            <div className="flex items-center gap-1 text-xs text-emerald-500">
              <Wifi className="size-3" />
              <span className="hidden lg:inline">Live</span>
            </div>
          ) : agentUrl ? (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <WifiOff className="size-3" />
              <span className="hidden lg:inline">Offline</span>
            </div>
          ) : (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <RefreshCw className="size-3 animate-spin" />
              <span className="hidden lg:inline">Starting...</span>
            </div>
          )}
        </div>
      </div>

      {/* Content Area — viewport-constrained with scoped theme */}
      <div className="flex-1 overflow-hidden rounded-b-lg bg-muted/10">
        {hasSurfaces && activeSurface ? (
          <div className="h-full w-full flex items-start justify-center overflow-auto">
            <div
              className={cn(
                'h-full transition-all duration-300 ease-in-out',
                viewport === 'wide' ? 'w-full' : 'shadow-sm border-x border-border/30'
              )}
              style={
                viewportWidth > 0
                  ? {
                      width: `${viewportWidth}px`,
                      minWidth: `${viewportWidth}px`,
                      maxWidth: `${viewportWidth}px`,
                      ...canvasThemeStyle,
                    }
                  : canvasThemeStyle
              }
            >
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
            </div>
          </div>
        ) : (
          <div style={canvasThemeStyle} className="h-full">
            <EmptyState connected={connected} agentUrl={agentUrl} />
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Empty State
// ---------------------------------------------------------------------------

function EmptyState({
  connected,
  agentUrl,
}: {
  connected: boolean
  agentUrl: string | null
}) {
  if (!agentUrl || !connected) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 px-8 text-center">
        <div className="relative">
          <div className="absolute inset-0 bg-primary/10 rounded-full blur-xl animate-pulse" />
          <div className="relative bg-muted/50 p-5 rounded-full border border-border/50">
            <RefreshCw className="size-7 text-muted-foreground animate-spin" />
          </div>
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">
            {!agentUrl ? 'Starting agent runtime...' : 'Connecting to agent...'}
          </p>
          <p className="text-xs text-muted-foreground">
            This usually takes a few seconds
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center justify-center h-full gap-6 px-8 text-center">
      <div className="relative">
        <div className="absolute inset-0 bg-primary/5 rounded-2xl blur-xl" />
        <div className="relative w-16 h-16 rounded-2xl bg-muted/50 border border-border/50 flex items-center justify-center">
          <LayoutDashboard className="size-8 text-muted-foreground" />
        </div>
      </div>

      <div className="space-y-1.5">
        <h3 className="text-base font-semibold">Canvas Preview</h3>
        <p className="text-sm text-muted-foreground max-w-md">
          No active surfaces yet. When your agent builds a UI, it will appear here in real time.
        </p>
      </div>

      <div className="text-xs text-muted-foreground bg-muted/50 rounded-xl px-5 py-4 max-w-sm border border-border/30">
        <p className="font-medium mb-2">Try asking your agent to:</p>
        <ul className="space-y-1.5 text-left">
          <li className="flex items-start gap-2">
            <span className="text-primary mt-0.5">&#8227;</span>
            <span>&ldquo;Show me a dashboard with the latest metrics&rdquo;</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary mt-0.5">&#8227;</span>
            <span>&ldquo;Display the search results as cards&rdquo;</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary mt-0.5">&#8227;</span>
            <span>&ldquo;Create a form for me to fill out&rdquo;</span>
          </li>
        </ul>
      </div>
    </div>
  )
}
