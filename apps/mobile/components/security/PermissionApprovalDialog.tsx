import { useState, useEffect, useCallback, useRef } from 'react'
import { View, Text, Pressable } from 'react-native'
import { Shield, Terminal, FileEdit, Trash2, Globe, Puzzle } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'

interface PermissionRequestData {
  id: string
  toolName: string
  category: string
  params: Record<string, any>
  reason: string
  timeout: number
}

interface PermissionApprovalDialogProps {
  request: PermissionRequestData
  onRespond: (response: {
    id: string
    decision: 'allow_once' | 'always_allow' | 'deny'
    pattern?: string
  }) => void
}

const CATEGORY_CONFIG: Record<string, { icon: typeof Shield; label: string; color: string }> = {
  shell: { icon: Terminal, label: 'Run shell command', color: 'text-amber-500' },
  file_write: { icon: FileEdit, label: 'Write file', color: 'text-blue-500' },
  file_delete: { icon: Trash2, label: 'Delete file', color: 'text-red-500' },
  file_read: { icon: Shield, label: 'Read file', color: 'text-green-500' },
  network: { icon: Globe, label: 'Network request', color: 'text-purple-500' },
  mcp: { icon: Puzzle, label: 'Install MCP tool', color: 'text-indigo-500' },
}

function extractAlwaysAllowPattern(toolName: string, category: string, params: Record<string, any>): string | null {
  if ((toolName === 'exec' || category === 'shell') && params.command) {
    const command = params.command as string
    const firstWord = command.split(/\s+/)[0]
    if (firstWord) return `${firstWord} *`
  }
  if ((category === 'file_write' || category === 'file_delete') && params.path) {
    const path = params.path as string
    if (path.includes('.')) return `*${path.slice(path.lastIndexOf('.'))}`
    return path
  }
  if ((toolName === 'tool_install' || toolName === 'mcp_install' || category === 'mcp') && params.name) {
    return params.name as string
  }
  return null
}

export function PermissionApprovalDialog({ request, onRespond }: PermissionApprovalDialogProps) {
  const [secondsLeft, setSecondsLeft] = useState(request.timeout)
  const respondedRef = useRef(false)

  useEffect(() => {
    respondedRef.current = false
    setSecondsLeft(request.timeout)
    const interval = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          clearInterval(interval)
          if (!respondedRef.current) {
            respondedRef.current = true
            onRespond({ id: request.id, decision: 'deny' })
          }
          return 0
        }
        return s - 1
      })
    }, 1000)
    return () => clearInterval(interval)
  }, [request.id, request.timeout, onRespond])

  const config = CATEGORY_CONFIG[request.category] ?? CATEGORY_CONFIG.shell
  const Icon = config.icon
  const alwaysAllowPattern = extractAlwaysAllowPattern(request.toolName, request.category, request.params)

  const displayValue = request.params.command
    || request.params.path
    || request.params.url
    || request.params.name
    || JSON.stringify(request.params)

  const handleDeny = useCallback(() => {
    if (respondedRef.current) return
    respondedRef.current = true
    onRespond({ id: request.id, decision: 'deny' })
  }, [request.id, onRespond])

  const handleAllowOnce = useCallback(() => {
    if (respondedRef.current) return
    respondedRef.current = true
    onRespond({ id: request.id, decision: 'allow_once' })
  }, [request.id, onRespond])

  const handleAlwaysAllow = useCallback(() => {
    if (respondedRef.current) return
    respondedRef.current = true
    onRespond({
      id: request.id,
      decision: 'always_allow',
      pattern: alwaysAllowPattern ?? undefined,
    })
  }, [request.id, alwaysAllowPattern, onRespond])

  return (
    <View className="bg-card border border-border rounded-xl overflow-hidden mx-2 mb-2">
      {/* Header */}
      <View className="flex-row items-center justify-between px-4 py-3 border-b border-border bg-muted/30">
        <View className="flex-row items-center gap-2">
          <Shield size={16} className="text-primary" />
          <Text className="text-sm font-semibold text-foreground">Permission Required</Text>
        </View>
        <View className="bg-muted px-2 py-0.5 rounded-md">
          <Text className="text-xs font-mono text-muted-foreground">
            {String(Math.floor(secondsLeft / 60)).padStart(2, '0')}:
            {String(secondsLeft % 60).padStart(2, '0')}
          </Text>
        </View>
      </View>

      {/* Body */}
      <View className="px-4 py-3 gap-2">
        <View className="flex-row items-center gap-2">
          <Icon size={14} className={config.color} />
          <Text className="text-sm font-medium text-foreground">{config.label}</Text>
        </View>

        <View className="bg-muted/50 rounded-lg px-3 py-2">
          <Text className="text-xs font-mono text-foreground" numberOfLines={3}>
            {typeof displayValue === 'string' ? displayValue : JSON.stringify(displayValue)}
          </Text>
        </View>
      </View>

      {/* Actions */}
      <View className="flex-row items-center gap-2 px-4 py-3 border-t border-border">
        <Pressable
          onPress={handleDeny}
          className="px-4 py-2 rounded-lg border border-border bg-background"
        >
          <Text className="text-sm font-medium text-muted-foreground">Deny</Text>
        </Pressable>

        <Pressable
          onPress={handleAllowOnce}
          className="px-4 py-2 rounded-lg bg-primary"
        >
          <Text className="text-sm font-medium text-primary-foreground">Allow Once</Text>
        </Pressable>

        {alwaysAllowPattern && (
          <Pressable
            onPress={handleAlwaysAllow}
            className="px-4 py-2 rounded-lg border border-primary/30 bg-primary/5"
          >
            <Text className="text-sm font-medium text-primary">Always Allow</Text>
          </Pressable>
        )}
      </View>
    </View>
  )
}

export default PermissionApprovalDialog
