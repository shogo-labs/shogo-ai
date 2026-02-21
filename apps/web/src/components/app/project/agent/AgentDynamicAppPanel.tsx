/**
 * AgentDynamicAppPanel
 *
 * Panel wrapper that connects to the agent runtime's SSE stream and renders
 * all active surfaces.
 */

import { useState, useEffect } from 'react'
import { cn } from '@/lib/utils'
import { LayoutDashboard, Wifi, WifiOff, RefreshCw } from 'lucide-react'
import { useDynamicAppStream } from './dynamic-app/use-dynamic-app-stream'
import { MultiSurfaceRenderer } from './dynamic-app/DynamicAppRenderer'
import { ScrollArea } from '@/components/ui/scroll-area'

interface AgentDynamicAppPanelProps {
  projectId: string
  visible: boolean
  localAgentUrl?: string | null
}

export function AgentDynamicAppPanel({ projectId, visible, localAgentUrl }: AgentDynamicAppPanelProps) {
  const [agentUrl, setAgentUrl] = useState<string | null>(null)

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

  const hasSurfaces = surfaces.size > 0

  return (
    <div className={cn('absolute inset-0 flex flex-col', !visible && 'invisible pointer-events-none')}>
      {/* Status Bar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b bg-muted/30 shrink-0">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <LayoutDashboard className="size-3.5" />
          <span>Canvas</span>
          {surfaces.size > 0 && (
            <span className="text-muted-foreground/60">
              ({surfaces.size} surface{surfaces.size !== 1 ? 's' : ''})
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
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

      {/* Content Area */}
      <div className="flex-1 overflow-hidden">
        {hasSurfaces ? (
          <ScrollArea className="h-full">
            <MultiSurfaceRenderer
              surfaces={surfaces}
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
