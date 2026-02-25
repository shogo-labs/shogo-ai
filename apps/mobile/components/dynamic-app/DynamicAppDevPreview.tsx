/**
 * DynamicAppDevPreview (React Native)
 *
 * Standalone dev preview for the Dynamic App renderer.
 * Renders all demo surfaces with a sidebar selector for switching between them.
 * Matches the staging Tailwind/shadcn layout using NativeWind/Gluestack.
 */

import { useState, useCallback } from 'react'
import { View, Pressable, ScrollView, Platform } from 'react-native'
import { useColorScheme } from 'nativewind'
import { Text } from '@/components/ui/text'
import { MultiSurfaceRenderer } from './DynamicAppRenderer'
import { DEMO_SURFACES, getAllDemoSurfaces } from './demo-surfaces'
import type { SurfaceState } from './types'
import { Moon, Sun } from 'lucide-react-native'

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
  const { colorScheme, setColorScheme } = useColorScheme()
  const isDark = colorScheme === 'dark'

  const toggleTheme = useCallback(() => {
    const next = isDark ? 'light' : 'dark'
    setColorScheme(next)
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      document.documentElement.classList.toggle('dark', next === 'dark')
      document.documentElement.classList.toggle('light', next === 'light')
      document.documentElement.style.colorScheme = next
      localStorage.setItem('theme', next)
    }
  }, [isDark, setColorScheme])

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
    <View className="flex-1 flex-row bg-background text-foreground">
      {/* Sidebar */}
      <View className="w-64 border-r border-border bg-background-muted/30 shrink-0">
        <View className="p-4 border-b border-border flex-row items-center justify-between">
          <View className="flex-1 mr-2">
            <Text className="text-sm font-semibold">Dynamic App Preview</Text>
            <Text className="text-xs text-muted-foreground mt-1">Visual QA for canvas components</Text>
          </View>
          <Pressable
            onPress={toggleTheme}
            className="w-8 h-8 items-center justify-center rounded-md shrink-0"
          >
            {isDark
              ? <Sun size={16} className="text-foreground" />
              : <Moon size={16} className="text-foreground" />
            }
          </Pressable>
        </View>
        <ScrollView className="flex-1">
          <View className="p-3 gap-1">
            {Object.entries(DEMO_SURFACES).map(([key, { label }]) => (
              <Pressable
                key={key}
                onPress={() => selectDemo(key)}
                className={`px-3 py-2 rounded-md ${
                  activeKey === key
                    ? 'bg-primary'
                    : ''
                }`}
              >
                <Text
                  className={`text-sm ${
                    activeKey === key
                      ? 'text-primary-foreground font-medium'
                      : 'text-foreground'
                  }`}
                >
                  {label}
                </Text>
              </Pressable>
            ))}
            <View className="border-t border-border my-2" />
            <Pressable
              onPress={() => selectDemo('all')}
              className={`px-3 py-2 rounded-md ${
                activeKey === 'all'
                  ? 'bg-primary'
                  : ''
              }`}
            >
              <Text
                className={`text-sm ${
                  activeKey === 'all'
                    ? 'text-primary-foreground font-medium'
                    : 'text-foreground'
                }`}
              >
                All Surfaces
              </Text>
            </Pressable>
          </View>

          {/* Action Log */}
          {actionLog.length > 0 && (
            <View className="border-t border-border p-3">
              <Text className="text-xs font-medium text-muted-foreground mb-2">Action Log</Text>
              <View className="gap-1.5">
                {actionLog.map((entry, i) => (
                  <View key={i} className="bg-background rounded p-2 border border-border">
                    <Text className="text-xs font-medium text-primary">{entry.action}</Text>
                    {entry.context && Object.keys(entry.context).length > 0 && (
                      <Text className="text-muted-foreground mt-0.5 text-[10px] font-mono">
                        {JSON.stringify(entry.context, null, 2)}
                      </Text>
                    )}
                  </View>
                ))}
              </View>
            </View>
          )}
        </ScrollView>
      </View>

      {/* Main Content */}
      <ScrollView className="flex-1">
        <MultiSurfaceRenderer surfaces={activeSurface} agentUrl={null} onAction={handleAction} />
      </ScrollView>
    </View>
  )
}
