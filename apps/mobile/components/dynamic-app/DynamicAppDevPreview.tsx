/**
 * DynamicAppDevPreview (React Native)
 *
 * Standalone dev preview for the Dynamic App renderer.
 * Renders all demo surfaces with a sidebar selector for switching between them.
 * Includes visual editing mode for testing the canvas editor.
 */

import { useState, useCallback } from 'react'
import { View, Pressable, ScrollView } from 'react-native'
import { useColorScheme } from 'nativewind'
import { Text } from '@/components/ui/text'
import { DynamicAppRenderer } from './DynamicAppRenderer'
import { DEMO_SURFACES, getAllDemoSurfaces } from './demo-surfaces'
import type { SurfaceState, ComponentDefinition } from './types'
import { Moon, Sun } from 'lucide-react-native'
import { useTheme } from '../../contexts/theme'
import { EditModeProvider, useEditModeOptional, type EditAction, type EditActionResult } from './edit/EditModeContext'
import { EditToolbar } from './edit/EditToolbar'
import { InspectorPanel } from './edit/InspectorPanel'
import { ComponentTreePanel } from './edit/ComponentTreePanel'

export function DynamicAppDevPreview() {
  const [activeSurface, setActiveSurface] = useState<SurfaceState>(
    () => {
      const first = Object.values(DEMO_SURFACES)[0]
      return first.surface
    }
  )
  const [activeKey, setActiveKey] = useState<string>(Object.keys(DEMO_SURFACES)[0])
  const { colorScheme } = useColorScheme()
  const { theme, setTheme } = useTheme()
  const isDark = colorScheme === 'dark'

  const toggleTheme = useCallback(() => {
    setTheme(isDark ? 'light' : 'dark')
  }, [isDark, setTheme])

  const selectDemo = useCallback((key: string) => {
    const entry = DEMO_SURFACES[key]
    if (entry) {
      setActiveSurface(entry.surface)
      setActiveKey(key)
    }
  }, [])

  const handleAction = useCallback((surfaceId: string, name: string, context?: Record<string, unknown>) => {
    const logEntry = { surfaceId, action: name, context, timestamp: new Date().toISOString() }
    console.log('[DynamicApp Action]', logEntry)
    setActionLog((prev) => [logEntry, ...prev].slice(0, 20))
  }, [])

  const [actionLog, setActionLog] = useState<any[]>([])

  const handleEditAction = useCallback((action: EditAction): EditActionResult => {
    setActiveSurface((prev) => {
      const components = new Map(prev.components)

      switch (action.action) {
        case 'update': {
          if (!action.componentId || !action.changes) return prev
          const existing = components.get(action.componentId)
          if (!existing) return prev
          const updated = {
            ...existing,
            ...action.changes,
            id: action.componentId,
            component: (action.changes.component as any) || existing.component,
          } as ComponentDefinition
          components.set(action.componentId, updated)
          break
        }
        case 'add': {
          if (!action.component || !action.parentId) return prev
          const id = (action.component.id as string) || `comp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
          const newComp = { ...action.component, id } as ComponentDefinition
          components.set(id, newComp)
          const parent = components.get(action.parentId)
          if (parent) {
            const childIds = Array.isArray(parent.children) ? [...(parent.children as string[])] : []
            const idx = typeof action.index === 'number' ? Math.min(action.index, childIds.length) : childIds.length
            childIds.splice(idx, 0, id)
            components.set(action.parentId, { ...parent, children: childIds })
          }
          ;(action as any)._newComponentId = id
          break
        }
        case 'delete': {
          const ids = action.componentIds || (action.componentId ? [action.componentId] : [])
          const deletedSet = new Set(ids)
          for (const id of ids) {
            components.delete(id)
          }
          for (const [, comp] of components) {
            if (Array.isArray(comp.children)) {
              const filtered = (comp.children as string[]).filter((id) => !deletedSet.has(id))
              if (filtered.length !== (comp.children as string[]).length) {
                components.set(comp.id, { ...comp, children: filtered })
              }
            }
            if (comp.child && deletedSet.has(comp.child)) {
              const updated = { ...comp }
              delete updated.child
              components.set(comp.id, updated)
            }
          }
          break
        }
        case 'move': {
          if (!action.componentId || !action.newParentId) return prev
          for (const [, comp] of components) {
            if (Array.isArray(comp.children) && (comp.children as string[]).includes(action.componentId)) {
              components.set(comp.id, {
                ...comp,
                children: (comp.children as string[]).filter((id) => id !== action.componentId),
              })
              break
            }
          }
          const newParent = components.get(action.newParentId)
          if (newParent) {
            const childIds = Array.isArray(newParent.children) ? [...(newParent.children as string[])] : []
            const idx = typeof action.index === 'number' ? Math.min(action.index, childIds.length) : childIds.length
            childIds.splice(idx, 0, action.componentId!)
            components.set(action.newParentId, { ...newParent, children: childIds })
          }
          break
        }
      }

      return { ...prev, components, updatedAt: new Date().toISOString() }
    })

    return { ok: true, newComponentId: (action as any)._newComponentId }
  }, [])

  return (
    <EditModeProvider onEditAction={handleEditAction}>
      <View className="flex-1 flex-row bg-background text-foreground">
        {/* Sidebar */}
        <View className="w-56 border-r border-border bg-background shrink-0">
          <View className="p-3 border-b border-border flex-row items-center justify-between">
            <View className="flex-1 mr-2">
              <Text className="text-sm font-semibold">Dev Preview</Text>
              <Text className="text-xs text-muted-foreground mt-0.5">Canvas Editor</Text>
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
            <View className="p-2 gap-0.5">
              {Object.entries(DEMO_SURFACES).map(([key, { label }]) => (
                <Pressable
                  key={key}
                  onPress={() => selectDemo(key)}
                  className={`px-3 py-2 rounded-md ${
                    activeKey === key ? 'bg-primary' : ''
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
            </View>

            {actionLog.length > 0 && (
              <View className="border-t border-border p-2">
                <Text className="text-xs font-medium text-muted-foreground mb-1">Action Log</Text>
                <View className="gap-1">
                  {actionLog.map((entry, i) => (
                    <View key={i} className="bg-muted/50 rounded p-1.5">
                      <Text className="text-[10px] font-medium text-primary">{entry.action}</Text>
                    </View>
                  ))}
                </View>
              </View>
            )}
          </ScrollView>
        </View>

        {/* Main Content with Edit UI */}
        <CanvasArea surface={activeSurface} onAction={handleAction} />
      </View>
    </EditModeProvider>
  )
}

function CanvasArea({ surface, onAction }: { surface: SurfaceState; onAction: (surfaceId: string, name: string, context?: Record<string, unknown>) => void }) {
  const editMode = useEditModeOptional()
  const isEditMode = editMode?.isEditMode ?? false
  const showTreePanel = editMode?.showTreePanel ?? false

  return (
    <View className="flex-1">
      <EditToolbar surfaceId={surface.surfaceId} components={surface.components} />
      <View className="flex-1 flex-row">
        {isEditMode && showTreePanel && (
          <ComponentTreePanel surfaceId={surface.surfaceId} components={surface.components} />
        )}
        <ScrollView className="flex-1" contentContainerStyle={{ padding: 16 }}>
          <DynamicAppRenderer
            surface={surface}
            agentUrl={null}
            onAction={onAction}
          />
        </ScrollView>
        {isEditMode && (
          <InspectorPanel surfaceId={surface.surfaceId} components={surface.components} />
        )}
      </View>
    </View>
  )
}
