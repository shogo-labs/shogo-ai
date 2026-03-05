/**
 * DynamicAppDevPreview (React Native)
 *
 * Standalone dev preview for the Dynamic App renderer.
 * Renders all demo surfaces with a sidebar selector for switching between them.
 * Includes visual editing mode for testing the canvas editor.
 *
 * Live mode: pass agentUrl prop to connect to a running agent runtime via SSE.
 * Surfaces come from the runtime instead of static demos, and actions dispatch real mutations.
 */

import { useState, useCallback, useEffect, useMemo } from 'react'
import { View, Pressable, ScrollView } from 'react-native'
import { useColorScheme } from 'nativewind'
import { Text } from '@/components/ui/text'
import { DynamicAppRenderer } from './DynamicAppRenderer'
import { DEMO_SURFACES, getAllDemoSurfaces } from './demo-surfaces'
import type { SurfaceState, ComponentDefinition } from './types'
import { Moon, Sun, Wifi, WifiOff } from 'lucide-react-native'
import { useTheme } from '../../contexts/theme'
import { EditModeProvider, useEditModeOptional, type EditAction, type EditActionResult } from './edit/EditModeContext'
import { EditToolbar } from './edit/EditToolbar'
import { InspectorPanel } from './edit/InspectorPanel'
import { ComponentTreePanel } from './edit/ComponentTreePanel'
import { CanvasThemeProvider, CanvasThemedContainer } from './CanvasThemeContext'
import { CanvasThemePicker } from './CanvasThemePicker'
import { useDynamicAppStream } from './use-dynamic-app-stream'
import { setByPointer, getByPointer } from '@shogo/shared-app/dynamic-app'

/**
 * After a collection changes, find summary objects in the dataModel and
 * recompute total / boolean field counts / inverse counts automatically.
 */
function recomputeSummaries(dataModel: Record<string, unknown>, _collectionPath: string, items: unknown[]): void {
  const boolFields = new Map<string, number>()
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue
    for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
      if (typeof v === 'boolean') {
        boolFields.set(k, (boolFields.get(k) ?? 0) + (v ? 1 : 0))
      }
    }
  }

  for (const [key, value] of Object.entries(dataModel)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const summary = value as Record<string, unknown>
    if (typeof summary.total !== 'number') continue

    // Snapshot old values before mutating so inverse detection works
    const oldSnapshot = { ...summary } as Record<string, number>
    const oldTotal = oldSnapshot.total

    summary.total = items.length

    for (const [sumKey, sumVal] of Object.entries(oldSnapshot)) {
      if (sumKey === 'total' || typeof sumVal !== 'number') continue

      if (boolFields.has(sumKey)) {
        summary[sumKey] = boolFields.get(sumKey)!
      } else {
        for (const [bf, trueCount] of boolFields) {
          const oldBoolCount = oldSnapshot[bf]
          if (typeof oldBoolCount === 'number' && sumVal === oldTotal - oldBoolCount) {
            summary[sumKey] = items.length - trueCount
            break
          }
        }
      }
    }
  }
}

export function DynamicAppDevPreview({ agentUrl }: { agentUrl?: string | null } = {}) {
  const isLive = Boolean(agentUrl)
  const stream = useDynamicAppStream(agentUrl ?? null)

  const [activeSurface, setActiveSurface] = useState<SurfaceState>(
    () => {
      const first = Object.values(DEMO_SURFACES)[0]
      return first.surface
    }
  )
  const [activeKey, setActiveKey] = useState<string>(Object.keys(DEMO_SURFACES)[0])
  const [activeLiveSurfaceId, setActiveLiveSurfaceId] = useState<string | null>(null)
  const { colorScheme } = useColorScheme()
  const { theme, setTheme } = useTheme()
  const isDark = theme === 'system' ? colorScheme === 'dark' : theme === 'dark'

  const liveSurfaces = useMemo(() => {
    if (!isLive) return []
    return Array.from(stream.surfaces.entries()).map(([id, s]) => ({ id, surface: s }))
  }, [isLive, stream.surfaces])

  const currentLiveSurface = useMemo(() => {
    if (!activeLiveSurfaceId) return liveSurfaces[0]?.surface ?? null
    return stream.surfaces.get(activeLiveSurfaceId) ?? null
  }, [activeLiveSurfaceId, stream.surfaces, liveSurfaces])

  useEffect(() => {
    if (isLive && liveSurfaces.length > 0 && !activeLiveSurfaceId) {
      setActiveLiveSurfaceId(liveSurfaces[0].id)
    }
  }, [isLive, liveSurfaces, activeLiveSurfaceId])

  const toggleTheme = useCallback(() => {
    setTheme(isDark ? 'light' : 'dark')
  }, [isDark, setTheme])

  const selectDemo = useCallback((key: string) => {
    const entry = DEMO_SURFACES[key]
    if (entry) {
      setActiveSurface(entry.surface)
      setActiveKey(key)
      setActiveLiveSurfaceId(null)
    }
  }, [])

  const selectLiveSurface = useCallback((surfaceId: string) => {
    setActiveLiveSurfaceId(surfaceId)
    setActiveKey('')
  }, [])

  const handleAction = useCallback((surfaceId: string, name: string, context?: Record<string, unknown>) => {
    const logEntry = { surfaceId, action: name, context, timestamp: new Date().toISOString() }
    console.log('[DynamicApp Action]', logEntry)
    setActionLog((prev) => [logEntry, ...prev].slice(0, 20))

    if (isLive) {
      stream.dispatchAction(surfaceId, name, context)
    }

    if (!isLive && name === '__delete_item__' && context?.collectionPath && context?.itemId) {
      setActiveSurface((prev) => {
        const newDataModel = { ...prev.dataModel }
        const path = context.collectionPath as string
        const items = (newDataModel as any)[path.replace(/^\//, '')]
        if (Array.isArray(items)) {
          const updated = items.filter(
            (item: any) => String(item?.id) !== String(context.itemId),
          );
          (newDataModel as any)[path.replace(/^\//, '')] = updated
          recomputeSummaries(newDataModel, path, updated)
        }
        return { ...prev, dataModel: newDataModel, updatedAt: new Date().toISOString() }
      })
    }
  }, [isLive, stream])

  const handleDataChange = useCallback((surfaceId: string, path: string, value: unknown, options?: { persist?: boolean }) => {
    const logEntry = { surfaceId, type: 'dataChange', path, value, persist: options?.persist, timestamp: new Date().toISOString() }
    console.log('[DynamicApp DataChange]', logEntry)
    setActionLog((prev) => [logEntry, ...prev].slice(0, 20))

    if (isLive) {
      stream.updateLocalData(surfaceId, path, value, options)
    } else {
      setActiveSurface((prev) => {
        const newDataModel = { ...prev.dataModel }
        setByPointer(newDataModel, path, value)

        // Find which collection this path belongs to and recompute summaries
        const segments = path.replace(/^\//, '').split('/')
        if (segments.length >= 2) {
          const collectionKey = segments[0]
          const collection = (newDataModel as any)[collectionKey]
          if (Array.isArray(collection)) {
            recomputeSummaries(newDataModel, `/${collectionKey}`, collection)
          }
        }

        return { ...prev, dataModel: newDataModel, updatedAt: new Date().toISOString() }
      })
    }
  }, [isLive, stream])

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

  const displaySurface = (isLive && currentLiveSurface) ? currentLiveSurface : activeSurface
  const displayAgentUrl = isLive ? agentUrl : null

  return (
    <CanvasThemeProvider>
    <EditModeProvider onEditAction={handleEditAction}>
      <View className="flex-1 flex-row bg-background text-foreground">
        {/* Sidebar */}
        <View className="w-56 border-r border-border bg-background shrink-0">
          <View className="p-3 border-b border-border flex-row items-center justify-between">
            <View className="flex-1 mr-2">
              <Text className="text-sm font-semibold">Dev Preview</Text>
              <Text className="text-xs text-muted-foreground mt-0.5">
                {isLive ? 'Live Mode' : 'Canvas Editor'}
              </Text>
            </View>
            <View className="flex-row items-center gap-1">
              {isLive && (
                <View className="w-8 h-8 items-center justify-center">
                  {stream.connected
                    ? <Wifi size={14} className="text-emerald-500" />
                    : <WifiOff size={14} className="text-destructive" />
                  }
                </View>
              )}
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
          </View>
          <ScrollView className="flex-1">
            {/* Live surfaces */}
            {isLive && liveSurfaces.length > 0 && (
              <View className="p-2 gap-0.5">
                <Text className="text-xs font-medium text-muted-foreground px-3 pb-1">Live Surfaces</Text>
                {liveSurfaces.map(({ id, surface }) => (
                  <Pressable
                    key={id}
                    onPress={() => selectLiveSurface(id)}
                    className={`px-3 py-2 rounded-md ${
                      activeLiveSurfaceId === id ? 'bg-primary' : ''
                    }`}
                  >
                    <Text
                      className={`text-sm ${
                        activeLiveSurfaceId === id
                          ? 'text-primary-foreground font-medium'
                          : 'text-foreground'
                      }`}
                    >
                      {surface.title || id}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}

            {/* Demo surfaces */}
            <View className="p-2 gap-0.5">
              {isLive && <Text className="text-xs font-medium text-muted-foreground px-3 pb-1">Demo Surfaces</Text>}
              {Object.entries(DEMO_SURFACES).map(([key, { label }]) => (
                <Pressable
                  key={key}
                  onPress={() => selectDemo(key)}
                  className={`px-3 py-2 rounded-md ${
                    activeKey === key && !activeLiveSurfaceId ? 'bg-primary' : ''
                  }`}
                >
                  <Text
                    className={`text-sm ${
                      activeKey === key && !activeLiveSurfaceId
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
                <Text className="text-xs font-medium text-muted-foreground mb-1">Event Log</Text>
                <View className="gap-1">
                  {actionLog.map((entry, i) => (
                    <View key={i} className="bg-muted/50 rounded p-1.5">
                      {entry.type === 'dataChange' ? (
                        <>
                          <Text className="text-[10px] font-medium text-blue-500">
                            DATA {entry.persist ? '(persist)' : '(local)'}
                          </Text>
                          <Text className="text-[10px] text-muted-foreground" numberOfLines={1}>
                            {entry.path} = {JSON.stringify(entry.value)}
                          </Text>
                        </>
                      ) : (
                        <>
                          <Text className="text-[10px] font-medium text-primary">{entry.action}</Text>
                          {entry.context && Object.keys(entry.context).length > 0 && (
                            <Text className="text-[10px] text-muted-foreground" numberOfLines={1}>
                              {JSON.stringify(entry.context)}
                            </Text>
                          )}
                        </>
                      )}
                    </View>
                  ))}
                </View>
              </View>
            )}
          </ScrollView>
        </View>

        {/* Main Content with Edit UI */}
        <CanvasArea surface={displaySurface} agentUrl={displayAgentUrl} onAction={handleAction} onDataChange={handleDataChange} />
      </View>
    </EditModeProvider>
    </CanvasThemeProvider>
  )
}

function CanvasArea({ surface, agentUrl, onAction, onDataChange }: {
  surface: SurfaceState
  agentUrl?: string | null
  onAction: (surfaceId: string, name: string, context?: Record<string, unknown>) => void
  onDataChange?: (surfaceId: string, path: string, value: unknown, options?: { persist?: boolean }) => void
}) {
  const editMode = useEditModeOptional()
  const isEditMode = editMode?.isEditMode ?? false
  const showTreePanel = editMode?.showTreePanel ?? false

  return (
    <View className="flex-1">
      <EditToolbar surfaceId={surface.surfaceId} components={surface.components} trailing={<CanvasThemePicker />} />
      <View className="flex-1 flex-row">
        {isEditMode && showTreePanel && (
          <ComponentTreePanel surfaceId={surface.surfaceId} components={surface.components} />
        )}
        <View className="flex-1 p-3">
          <CanvasThemedContainer>
            <ScrollView className="flex-1" contentContainerStyle={{ padding: 16 }}>
              <DynamicAppRenderer
                surface={surface}
                agentUrl={agentUrl ?? null}
                onAction={onAction}
                onDataChange={onDataChange}
              />
            </ScrollView>
          </CanvasThemedContainer>
        </View>
        {isEditMode && (
          <InspectorPanel surfaceId={surface.surfaceId} components={surface.components} />
        )}
      </View>
    </View>
  )
}
