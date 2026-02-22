/**
 * AgentDynamicAppPanel
 *
 * Panel wrapper that connects to the agent runtime's SSE stream and renders
 * all active surfaces. Supports per-project theme switching for the canvas.
 */

import { useState, useEffect, useMemo, useRef, type CSSProperties } from 'react'
import { cn } from '@/lib/utils'
import { LayoutDashboard, Wifi, WifiOff, RefreshCw } from 'lucide-react'
import { useDynamicAppStream } from './dynamic-app/use-dynamic-app-stream'
import { DynamicAppRenderer } from './dynamic-app/DynamicAppRenderer'
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

  const { surfaces, connected, error, dispatchAction, updateLocalData } = useDynamicAppStream(
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
        <div className="flex items-center gap-2">
          <ThemeSelector
            selectedThemeId={canvasThemeId}
            onSelectTheme={handleSelectTheme}
            variant="compact"
          />
          {error && (
            <span className="text-xs text-amber-500">{error}</span>
          )}
          {connected ? (
            <div className="flex items-center gap-1 text-xs text-emerald-500">
              <Wifi className="size-3" />
              <span>Connected</span>
            </div>
          ) : agentUrl ? (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <WifiOff className="size-3" />
              <span>Disconnected</span>
            </div>
          ) : (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <RefreshCw className="size-3 animate-spin" />
              <span>Connecting...</span>
            </div>
          )}
        </div>
      </div>

      {/* Content Area — scoped theme via CSS variables */}
      <div className="flex-1 overflow-hidden rounded-b-lg" style={canvasThemeStyle}>
        {hasSurfaces && activeSurface ? (
          <ScrollArea className="h-full">
            <DynamicAppRenderer
              surface={activeSurface}
              agentUrl={agentUrl}
              onAction={dispatchAction}
              onDataChange={updateLocalData}
            />
          </ScrollArea>
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
        <RefreshCw className="size-6 text-muted-foreground animate-spin" />
        <p className="text-sm text-muted-foreground">
          {!agentUrl ? 'Starting agent runtime...' : 'Connecting to agent...'}
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center justify-center h-full gap-6 px-8 text-center">
      <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center">
        <LayoutDashboard className="size-8 text-muted-foreground" />
      </div>

      <div>
        <h3 className="text-base font-semibold mb-1">Canvas</h3>
        <p className="text-sm text-muted-foreground max-w-md">
          No active surfaces. When your agent uses canvas tools to build a UI, it will appear here.
        </p>
      </div>

      <div className="text-xs text-muted-foreground bg-muted rounded-lg px-4 py-3 max-w-sm">
        <p className="font-medium mb-1">Try telling your agent:</p>
        <ul className="space-y-1 text-left">
          <li>&ldquo;Show me a dashboard with the latest metrics&rdquo;</li>
          <li>&ldquo;Display the search results as cards&rdquo;</li>
          <li>&ldquo;Create a form for me to fill out&rdquo;</li>
        </ul>
      </div>
    </div>
  )
}
