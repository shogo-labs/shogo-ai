/**
 * DynamicAppDevPreview
 *
 * Standalone dev preview for the Dynamic App renderer.
 * Renders all demo surfaces with a selector for switching between them.
 * Used for visual QA without needing the full app or agent runtime.
 */

import { useState, useCallback, useEffect } from 'react'
import { MultiSurfaceRenderer, DynamicAppRenderer } from './DynamicAppRenderer'
import { DEMO_SURFACES, getAllDemoSurfaces } from './demo-surfaces'
import type { SurfaceState } from './types'
import { Button } from '@/components/ui/button'
import { Moon, Sun } from 'lucide-react'

export function DynamicAppDevPreview() {
  const [activeSurface, setActiveSurface] = useState<Map<string, SurfaceState>>(
    () => {
      const first = Object.values(DEMO_SURFACES)[0]
      const map = new Map<string, SurfaceState>()
      map.set(first.surface.surfaceId, first.surface)
      return map
    }
  )
  const [activeKey, setActiveKey] = useState<string>(Object.keys(DEMO_SURFACES)[0])
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('dark'))

  const toggleTheme = useCallback(() => {
    setIsDark((prev) => {
      const next = !prev
      document.documentElement.classList.toggle('dark', next)
      localStorage.setItem('theme', next ? 'dark' : 'light')
      return next
    })
  }, [])

  const selectDemo = useCallback((key: string) => {
    if (key === 'all') {
      setActiveSurface(getAllDemoSurfaces())
      setActiveKey('all')
    } else {
      const entry = DEMO_SURFACES[key]
      if (entry) {
        const map = new Map<string, SurfaceState>()
        map.set(entry.surface.surfaceId, entry.surface)
        setActiveSurface(map)
        setActiveKey(key)
      }
    }
  }, [])

  const handleAction = useCallback((surfaceId: string, name: string, context?: Record<string, unknown>) => {
    const logEntry = { surfaceId, action: name, context, timestamp: new Date().toISOString() }
    console.log('[DynamicApp Action]', logEntry)
    setActionLog((prev) => [logEntry, ...prev].slice(0, 20))
  }, [])

  const [actionLog, setActionLog] = useState<any[]>([])

  return (
    <div className="flex h-screen bg-background text-foreground">
      {/* Sidebar */}
      <div className="w-64 border-r bg-muted/30 flex flex-col shrink-0">
        <div className="p-4 border-b flex items-center justify-between">
          <div>
            <h1 className="text-sm font-semibold">Dynamic App Preview</h1>
            <p className="text-xs text-muted-foreground mt-1">Visual QA for canvas components</p>
          </div>
          <Button variant="ghost" size="icon" onClick={toggleTheme} className="size-8 shrink-0">
            {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>
        </div>
        <div className="p-3 flex flex-col gap-1">
          {Object.entries(DEMO_SURFACES).map(([key, { label }]) => (
            <button
              key={key}
              onClick={() => selectDemo(key)}
              className={`px-3 py-2 text-sm rounded-md text-left transition-colors ${
                activeKey === key
                  ? 'bg-primary text-primary-foreground'
                  : 'hover:bg-muted text-foreground'
              }`}
            >
              {label}
            </button>
          ))}
          <div className="border-t my-2" />
          <button
            onClick={() => selectDemo('all')}
            className={`px-3 py-2 text-sm rounded-md text-left transition-colors ${
              activeKey === 'all'
                ? 'bg-primary text-primary-foreground'
                : 'hover:bg-muted text-foreground'
            }`}
          >
            All Surfaces
          </button>
        </div>

        {/* Action Log */}
        {actionLog.length > 0 && (
          <div className="flex-1 overflow-auto border-t p-3">
            <p className="text-xs font-medium text-muted-foreground mb-2">Action Log</p>
            <div className="space-y-1.5">
              {actionLog.map((entry, i) => (
                <div key={i} className="text-[11px] bg-background rounded p-2 border">
                  <span className="font-medium text-primary">{entry.action}</span>
                  {entry.context && Object.keys(entry.context).length > 0 && (
                    <pre className="text-muted-foreground mt-0.5 text-[10px]">
                      {JSON.stringify(entry.context, null, 2)}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-auto">
        <MultiSurfaceRenderer surfaces={activeSurface} agentUrl={null} onAction={handleAction} />
      </div>
    </div>
  )
}
