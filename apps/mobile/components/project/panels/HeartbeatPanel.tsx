import { useState, useEffect, useCallback } from 'react'
import { View, Text, Pressable, ScrollView, ActivityIndicator } from 'react-native'
import { Heart, Play, RefreshCw, CheckCircle, AlertTriangle } from 'lucide-react-native'

interface HeartbeatStatus {
  enabled: boolean
  intervalSeconds: number
  lastTick: string | null
  nextTick: string | null
  quietHours: { start: string; end: string; timezone: string }
}

interface HeartbeatPanelProps {
  projectId: string
  agentUrl: string | null
  visible: boolean
}

export function HeartbeatPanel({ projectId, agentUrl, visible }: HeartbeatPanelProps) {
  const [status, setStatus] = useState<HeartbeatStatus | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isTriggering, setIsTriggering] = useState(false)
  const [triggerResult, setTriggerResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadStatus = useCallback(async () => {
    if (!agentUrl) return
    setIsLoading(true)
    setError(null)
    try {
      const res = await fetch(`${agentUrl}/agent/status`)
      if (!res.ok) throw new Error('Agent not reachable')
      const data = await res.json()
      setStatus(data.heartbeat || null)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsLoading(false)
    }
  }, [agentUrl])

  const triggerHeartbeat = async () => {
    if (!agentUrl) return
    setIsTriggering(true)
    setTriggerResult(null)
    try {
      const res = await fetch(`${agentUrl}/agent/heartbeat/trigger`, { method: 'POST' })
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

  if (!visible) return null

  return (
    <View className="absolute inset-0 flex-col" style={{ display: visible ? 'flex' : 'none' }}>
      <View className="px-4 py-3 border-b border-border flex-row items-center gap-2">
        <Heart size={16} className="text-muted-foreground" />
        <Text className="text-sm font-medium text-foreground">Heartbeat</Text>

        <View className="ml-auto flex-row items-center gap-1">
          <Pressable
            onPress={triggerHeartbeat}
            disabled={isTriggering}
            className="flex-row items-center gap-1 px-2 py-1 rounded-md bg-primary active:bg-primary/80"
            style={isTriggering ? { opacity: 0.5 } : undefined}
          >
            <Play size={12} className="text-primary-foreground" />
            <Text className="text-xs font-medium text-primary-foreground">
              {isTriggering ? 'Running...' : 'Trigger Now'}
            </Text>
          </Pressable>
          <Pressable onPress={loadStatus} className="p-1 rounded-md active:bg-muted">
            <RefreshCw size={14} className="text-muted-foreground" />
          </Pressable>
        </View>
      </View>

      {error && (
        <View className="px-4 py-2 bg-destructive/10">
          <Text className="text-xs text-destructive">{error}</Text>
        </View>
      )}

      <ScrollView className="flex-1" contentContainerStyle={{ padding: 16 }}>
        {isLoading ? (
          <View className="items-center py-8">
            <ActivityIndicator size="small" />
          </View>
        ) : status ? (
          <View className="gap-4">
            {/* Status card */}
            <View className="border border-border rounded-lg p-4 gap-3">
              <View className="flex-row items-center gap-2">
                {status.enabled ? (
                  <CheckCircle size={16} className="text-emerald-500" />
                ) : (
                  <AlertTriangle size={16} className="text-amber-500" />
                )}
                <Text className="text-sm font-medium text-foreground">
                  {status.enabled ? 'Active' : 'Disabled'}
                </Text>
              </View>

              <View className="flex-row flex-wrap gap-x-8 gap-y-3">
                <View>
                  <Text className="text-xs text-muted-foreground">Interval</Text>
                  <Text className="text-xs font-medium text-foreground">
                    {Math.round(status.intervalSeconds / 60)} min
                  </Text>
                </View>
                <View>
                  <Text className="text-xs text-muted-foreground">Quiet Hours</Text>
                  <Text className="text-xs font-medium text-foreground">
                    {status.quietHours?.start && status.quietHours?.end
                      ? `${status.quietHours.start} - ${status.quietHours.end}`
                      : 'None'}
                  </Text>
                </View>
                <View>
                  <Text className="text-xs text-muted-foreground">Last Tick</Text>
                  <Text className="text-xs font-medium text-foreground">
                    {status.lastTick
                      ? new Date(status.lastTick).toLocaleTimeString()
                      : 'Never'}
                  </Text>
                </View>
                <View>
                  <Text className="text-xs text-muted-foreground">Next Tick</Text>
                  <Text className="text-xs font-medium text-foreground">
                    {status.nextTick
                      ? new Date(status.nextTick).toLocaleTimeString()
                      : '-'}
                  </Text>
                </View>
              </View>
            </View>

            {triggerResult && (
              <View className="border border-border rounded-lg p-3">
                <Text className="text-xs text-muted-foreground mb-1">Last trigger result</Text>
                <Text className="text-sm font-mono text-foreground">{triggerResult}</Text>
              </View>
            )}

            <Text className="text-xs text-muted-foreground">
              Edit HEARTBEAT.md in the Workspace tab to define what the agent checks on each tick.
              Use the builder AI chat to configure heartbeat settings.
            </Text>
          </View>
        ) : (
          <View className="items-center py-12">
            <Heart size={32} className="text-muted-foreground/50 mb-3" />
            <Text className="text-sm text-muted-foreground">No heartbeat data</Text>
            <Text className="text-xs text-muted-foreground/70 mt-1">
              Start the agent to see heartbeat status
            </Text>
          </View>
        )}
      </ScrollView>
    </View>
  )
}
