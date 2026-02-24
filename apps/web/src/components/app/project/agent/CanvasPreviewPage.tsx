/**
 * CanvasPreviewPage
 *
 * Standalone full-screen canvas preview. Opened from the "Open in new tab"
 * button in AgentDynamicAppPanel. Connects to the same agent SSE stream
 * and renders surfaces with viewport controls, theme switching, and
 * surface selection — minimal chrome for a focused preview experience.
 */

import { useState, useEffect, useMemo, useCallback, useRef, type CSSProperties } from 'react'
import { useParams } from 'react-router-dom'
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
  Moon,
  Sun,
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
// Viewport definitions (mirrors AgentDynamicAppPanel)
// ---------------------------------------------------------------------------

type CanvasViewport = 'mobile' | 'tablet' | 'desktop' | 'wide'

const CANVAS_VIEWPORTS: Record<CanvasViewport, { width: number; icon: React.ElementType; label: string }> = {
  mobile:  { width: 375,  icon: Smartphone,  label: 'Mobile' },
  tablet:  { width: 768,  icon: Tablet,      label: 'Tablet' },
  desktop: { width: 1024, icon: Monitor,     label: 'Desktop' },
  wide:    { width: 0,    icon: MonitorPlay,  label: 'Full width' },
}

// ---------------------------------------------------------------------------
// Theme helpers (shared with AgentDynamicAppPanel)
// ---------------------------------------------------------------------------

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

export function CanvasPreviewPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const [agentUrl, setAgentUrl] = useState<string | null>(null)
  const [projectName, setProjectName] = useState<string>('Canvas Preview')

  // Theme
  const [canvasThemeId, setCanvasThemeId] = useState<string>(() => {
    if (!projectId) return 'default'
    try {
      return localStorage.getItem(`shogo-canvas-theme-${projectId}`) || 'default'
    } catch {
      return 'default'
    }
  })

  // Viewport
  const [viewport, setViewport] = useState<CanvasViewport>(() => {
    if (!projectId) return 'wide'
    try {
      const saved = localStorage.getItem(`shogo-canvas-viewport-${projectId}`)
      if (saved && saved in CANVAS_VIEWPORTS) return saved as CanvasViewport
    } catch {}
    return 'wide'
  })

  // Dark mode
  const [isDark, setIsDark] = useState(() =>
    document.documentElement.classList.contains('dark')
  )

  const toggleTheme = useCallback(() => {
    setIsDark((prev) => {
      const next = !prev
      document.documentElement.classList.toggle('dark', next)
      localStorage.setItem('theme', next ? 'dark' : 'light')
      return next
    })
  }, [])

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains('dark'))
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  // Fetch agent URL and project info
  useEffect(() => {
    if (!projectId) return
    let cancelled = false

    ;(async () => {
      try {
        const [sandboxRes, projectRes] = await Promise.all([
          fetch(`/api/projects/${projectId}/sandbox/url`),
          fetch(`/api/projects/${projectId}`),
        ])
        if (!cancelled) {
          if (sandboxRes.ok) {
            const data = await sandboxRes.json()
            setAgentUrl(data.agentUrl || data.url)
          }
          if (projectRes.ok) {
            const data = await projectRes.json()
            setProjectName(data.name || data.project?.name || 'Canvas Preview')
            document.title = `${data.name || 'Canvas'} — Preview`
          }
        }
      } catch {}
    })()

    return () => { cancelled = true }
  }, [projectId])

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

  const { surfaces, connected, connecting, error, dispatchAction, updateLocalData, reconnect } =
    useDynamicAppStream(agentUrl)

  const [selectedSurfaceId, setSelectedSurfaceId] = useState<string | null>(null)
  const prevSurfaceIdsRef = useRef<Set<string>>(new Set())
  const surfaceList = useMemo(() => [...surfaces.values()], [surfaces])

  useEffect(() => {
    const currentIds = new Set(surfaces.keys())
    for (const id of currentIds) {
      if (!prevSurfaceIdsRef.current.has(id)) {
        setSelectedSurfaceId(id)
        break
      }
    }
    if (selectedSurfaceId && !currentIds.has(selectedSurfaceId)) {
      const ids = [...currentIds]
      setSelectedSurfaceId(ids.length > 0 ? ids[ids.length - 1] : null)
    }
    if (!selectedSurfaceId && currentIds.size > 0) {
      setSelectedSurfaceId([...currentIds][0])
    }
    prevSurfaceIdsRef.current = currentIds
  }, [surfaces, selectedSurfaceId])

  const activeSurface = selectedSurfaceId ? surfaces.get(selectedSurfaceId) : null
  const hasSurfaces = surfaces.size > 0
  const viewportWidth = CANVAS_VIEWPORTS[viewport].width

  return (
    <div className="h-screen flex flex-col bg-background text-foreground">
      {/* Minimal Top Bar */}
      <div className="h-11 flex items-center justify-between px-4 border-b bg-background/95 backdrop-blur shrink-0">
        {/* Left: Project name + surface */}
        <div className="flex items-center gap-2.5 text-sm min-w-0">
          <LayoutDashboard className="size-4 text-primary shrink-0" />
          <span className="font-medium truncate">{projectName}</span>
          {surfaceList.length > 1 && selectedSurfaceId && (
            <>
              <span className="text-muted-foreground">/</span>
              <Select value={selectedSurfaceId} onValueChange={setSelectedSurfaceId}>
                <SelectTrigger className="h-7 text-xs gap-1 border-none bg-transparent shadow-none px-1 py-0 min-w-0 w-auto">
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
            </>
          )}
          {surfaceList.length <= 1 && activeSurface?.title && (
            <>
              <span className="text-muted-foreground">/</span>
              <span className="text-xs text-muted-foreground truncate">{activeSurface.title}</span>
            </>
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
                  onClick={() => setViewport(size)}
                  className={cn(
                    'h-7 w-7 flex items-center justify-center rounded-sm transition-colors',
                    'text-muted-foreground hover:text-foreground',
                    viewport === size && 'bg-background text-foreground shadow-sm'
                  )}
                >
                  <Icon className="h-4 w-4" />
                </button>
              )
            )}
          </div>
        </div>

        {/* Right: Theme, dark mode, refresh, status */}
        <div className="flex items-center gap-2 shrink-0">
          <ThemeSelector
            selectedThemeId={canvasThemeId}
            onSelectTheme={(id) => {
              setCanvasThemeId(id)
              try { localStorage.setItem(`shogo-canvas-theme-${projectId}`, id) } catch {}
            }}
            variant="compact"
          />

          <button
            onClick={toggleTheme}
            title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            className="h-7 w-7 flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>

          <div className="h-4 w-px bg-border/60" />

          <button
            onClick={reconnect}
            title="Refresh canvas"
            className="h-7 w-7 flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <RefreshCw className={cn('h-4 w-4', connecting && 'animate-spin')} />
          </button>

          {error && (
            <span className="text-xs text-amber-500 max-w-[150px] truncate">{error}</span>
          )}
          {connected ? (
            <div className="flex items-center gap-1.5 text-xs text-emerald-500">
              <Wifi className="size-3.5" />
              <span>Live</span>
            </div>
          ) : agentUrl ? (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <WifiOff className="size-3.5" />
              <span>Offline</span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <RefreshCw className="size-3.5 animate-spin" />
              <span>Starting...</span>
            </div>
          )}
        </div>
      </div>

      {/* Canvas Content */}
      <div className="flex-1 overflow-hidden bg-muted/10">
        {hasSurfaces && activeSurface ? (
          <div className="h-full w-full flex items-start justify-center overflow-auto">
            <div
              className={cn(
                'h-full transition-all duration-300 ease-in-out',
                viewport === 'wide' ? 'w-full' : 'shadow-md border-x border-border/30'
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
          <div style={canvasThemeStyle} className="h-full flex flex-col items-center justify-center gap-4 px-8 text-center">
            {!agentUrl || !connected ? (
              <>
                <RefreshCw className="size-8 text-muted-foreground animate-spin" />
                <p className="text-sm text-muted-foreground">
                  {!agentUrl ? 'Connecting to agent runtime...' : 'Waiting for connection...'}
                </p>
              </>
            ) : (
              <>
                <LayoutDashboard className="size-10 text-muted-foreground" />
                <div>
                  <h3 className="text-base font-semibold mb-1">No Active Surfaces</h3>
                  <p className="text-sm text-muted-foreground">
                    When your agent builds a UI, it will appear here in real time.
                  </p>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
