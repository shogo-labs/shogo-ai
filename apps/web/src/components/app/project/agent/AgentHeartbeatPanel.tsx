/**
 * AgentHeartbeatPanel
 *
 * Displays heartbeat configuration, status, and allows manual triggering.
 * Shows HEARTBEAT.md content and heartbeat history.
 */

import { useState, useEffect, useCallback } from 'react'
import { Heart, Play, RefreshCw, Clock, CheckCircle, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'

interface HeartbeatStatus {
  enabled: boolean
  intervalSeconds: number
  lastTick: string | null
  nextTick: string | null
  quietHours: { start: string; end: string; timezone: string }
}

interface AgentHeartbeatPanelProps {
  projectId: string
  visible: boolean
}

export function AgentHeartbeatPanel({ projectId, visible }: AgentHeartbeatPanelProps) {
  const [status, setStatus] = useState<HeartbeatStatus | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isTriggering, setIsTriggering] = useState(false)
  const [triggerResult, setTriggerResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadStatus = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const sandboxRes = await fetch(`/api/projects/${projectId}/sandbox/url`)
      if (!sandboxRes.ok) throw new Error('Agent not running')
      const sandboxData = await sandboxRes.json()
      const baseUrl = sandboxData.agentUrl || sandboxData.url

      const res = await fetch(`${baseUrl}/agent/status`)
      if (!res.ok) throw new Error('Agent not reachable')
      const data = await res.json()
      setStatus(data.heartbeat || null)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsLoading(false)
    }
  }, [projectId])

  const triggerHeartbeat = async () => {
    setIsTriggering(true)
    setTriggerResult(null)
    try {
      const sandboxRes = await fetch(`/api/projects/${projectId}/sandbox/url`)
      if (!sandboxRes.ok) throw new Error('Agent not running')
      const sandboxData = await sandboxRes.json()
      const baseUrl = sandboxData.agentUrl || sandboxData.url

      const res = await fetch(`${baseUrl}/agent/heartbeat/trigger`, { method: 'POST' })
      const data = await res.json()
      setTriggerResult(data.result || data.error || 'Done')
      await loadStatus()
    } catch (err: any) {
      setTriggerResult(`Error: ${err.message}`)
    } finally {
      setIsTriggering(false)
    }
  }

  useEffect(() => {
    if (visible) loadStatus()
  }, [visible, loadStatus])

  return (
    <div className={cn('absolute inset-0 flex flex-col', !visible && 'invisible pointer-events-none')}>
      <div className="px-4 py-3 border-b flex items-center gap-2">
        <Heart className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Heartbeat</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={triggerHeartbeat}
            disabled={isTriggering}
            className="flex items-center gap-1 px-2 py-1 rounded-md bg-primary text-primary-foreground text-xs disabled:opacity-50"
          >
            <Play className="h-3 w-3" />
            {isTriggering ? 'Running...' : 'Trigger Now'}
          </button>
          <button
            onClick={loadStatus}
            className="p-1 rounded hover:bg-muted text-muted-foreground"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {error && (
        <div className="px-4 py-2 bg-destructive/10 text-destructive text-xs">{error}</div>
      )}

      <div className="flex-1 overflow-y-auto p-4">
        {isLoading ? (
          <div className="text-sm text-muted-foreground text-center py-8">Loading...</div>
        ) : status ? (
          <div className="space-y-4">
            {/* Status card */}
            <div className="border rounded-lg p-4 space-y-3">
              <div className="flex items-center gap-2">
                {status.enabled ? (
                  <CheckCircle className="h-4 w-4 text-green-500" />
                ) : (
                  <AlertTriangle className="h-4 w-4 text-amber-500" />
                )}
                <span className="text-sm font-medium">
                  {status.enabled ? 'Active' : 'Disabled'}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <div className="text-muted-foreground">Interval</div>
                  <div className="font-medium">{Math.round(status.intervalSeconds / 60)} min</div>
                </div>
                <div>
                  <div className="text-muted-foreground">Quiet Hours</div>
                  <div className="font-medium">
                    {status.quietHours.start && status.quietHours.end
                      ? `${status.quietHours.start} - ${status.quietHours.end}`
                      : 'None'}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground">Last Tick</div>
                  <div className="font-medium">
                    {status.lastTick
                      ? new Date(status.lastTick).toLocaleTimeString()
                      : 'Never'}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground">Next Tick</div>
                  <div className="font-medium">
                    {status.nextTick
                      ? new Date(status.nextTick).toLocaleTimeString()
                      : '-'}
                  </div>
                </div>
              </div>
            </div>

            {/* Trigger result */}
            {triggerResult && (
              <div className="border rounded-lg p-3">
                <div className="text-xs text-muted-foreground mb-1">Last trigger result</div>
                <div className="text-sm font-mono whitespace-pre-wrap">
                  {triggerResult}
                </div>
              </div>
            )}

            <div className="text-xs text-muted-foreground">
              Edit HEARTBEAT.md in the Workspace tab to define what the agent checks on each tick.
              Use the builder AI chat to configure heartbeat settings.
            </div>
          </div>
        ) : (
          <div className="text-center py-12">
            <Heart className="h-8 w-8 text-muted-foreground/50 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">No heartbeat data</p>
            <p className="text-xs text-muted-foreground/70 mt-1">
              Start the agent to see heartbeat status
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
