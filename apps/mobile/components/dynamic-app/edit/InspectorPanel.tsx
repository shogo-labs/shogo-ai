// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useMemo, useCallback, useState } from 'react'
import { View, ScrollView, Pressable, TextInput } from 'react-native'
import { Text } from '@/components/ui/text'
import { X, Trash2, GripVertical, AlertTriangle, ExternalLink, Zap } from 'lucide-react-native'
import { getComponentSchema, type PropDef } from '@shogo/shared-app/dynamic-app'
import type { ComponentDefinition } from '@shogo/shared-app/dynamic-app'
import { useEditMode } from './EditModeContext'
import { PropertyField } from './PropertyField'

interface InspectorPanelProps {
  surfaceId: string
  components: Map<string, ComponentDefinition>
}

export function InspectorPanel({ surfaceId, components }: InspectorPanelProps) {
  const { selectedComponentId, selectComponent, updateComponentProp, deleteComponent } = useEditMode()

  const selectedComponent = selectedComponentId ? components.get(selectedComponentId) : null

  if (!selectedComponent) {
    return (
      <View testID="inspector-panel" className="w-72 border-l border-border bg-background p-4 items-center justify-center">
        <Text testID="inspector-placeholder" className="text-sm text-muted-foreground text-center">
          Select a component on the canvas to inspect its properties
        </Text>
      </View>
    )
  }

  const schema = getComponentSchema(selectedComponent.component)

  return (
    <View testID="inspector-panel" className="w-72 border-l border-border bg-background">
      <InspectorHeader
        component={selectedComponent}
        surfaceId={surfaceId}
        onClose={() => selectComponent(null)}
        onDelete={() => deleteComponent(surfaceId, selectedComponent.id)}
      />
      <ScrollView className="flex-1">
        <View className="p-3 gap-4">
          {schema ? (
            <PropertiesSection
              component={selectedComponent}
              schema={schema.props}
              surfaceId={surfaceId}
              onPropChange={(key, value) => updateComponentProp(surfaceId, selectedComponent.id, key, value)}
            />
          ) : (
            <Text className="text-xs text-muted-foreground">No schema found for {selectedComponent.component}</Text>
          )}

          {selectedComponent.component === 'Button' && (
            <ButtonActionSection
              component={selectedComponent}
              surfaceId={surfaceId}
              onPropChange={(key, value) => updateComponentProp(surfaceId, selectedComponent.id, key, value)}
            />
          )}

          <ChildrenSection component={selectedComponent} components={components} />

          <DataBindingsSection component={selectedComponent} />
        </View>
      </ScrollView>
    </View>
  )
}

function InspectorHeader({
  component,
  surfaceId,
  onClose,
  onDelete,
}: {
  component: ComponentDefinition
  surfaceId: string
  onClose: () => void
  onDelete: () => void
}) {
  return (
    <View className="flex-row items-center justify-between border-b border-border px-3 py-2">
      <View className="flex-1 mr-2">
        <Text className="text-sm font-semibold text-foreground">{component.component}</Text>
        <Text className="text-xs text-muted-foreground font-mono">#{component.id}</Text>
      </View>
      <View className="flex-row gap-1">
        {component.id !== 'root' && (
          <Pressable onPress={onDelete} className="p-1.5 rounded-md hover:bg-destructive/10">
            <Trash2 size={14} className="text-destructive" />
          </Pressable>
        )}
        <Pressable onPress={onClose} className="p-1.5 rounded-md hover:bg-muted">
          <X size={14} className="text-muted-foreground" />
        </Pressable>
      </View>
    </View>
  )
}

function PropertiesSection({
  component,
  schema,
  surfaceId,
  onPropChange,
}: {
  component: ComponentDefinition
  schema: Record<string, PropDef>
  surfaceId: string
  onPropChange: (key: string, value: unknown) => void
}) {
  const entries = useMemo(() => {
    return Object.entries(schema).sort(([, a], [, b]) => {
      if (a.required && !b.required) return -1
      if (!a.required && b.required) return 1
      return 0
    })
  }, [schema])

  return (
    <View className="gap-3">
      <Text className="text-xs font-semibold text-foreground uppercase tracking-wide">Properties</Text>
      {entries.map(([key, propDef]) => (
        <PropertyField
          key={key}
          name={key}
          propDef={propDef}
          value={(component as any)[key]}
          onChange={(value) => onPropChange(key, value)}
        />
      ))}
    </View>
  )
}

function ChildrenSection({
  component,
  components,
}: {
  component: ComponentDefinition
  components: Map<string, ComponentDefinition>
}) {
  const childIds = useMemo(() => {
    if (Array.isArray(component.children)) return component.children as string[]
    if (component.child) return [component.child]
    return []
  }, [component.children, component.child])

  if (childIds.length === 0) return null

  return (
    <View className="gap-2">
      <Text className="text-xs font-semibold text-foreground uppercase tracking-wide">Children</Text>
      {childIds.map((childId) => {
        const child = components.get(childId)
        return (
          <View key={childId} className="flex-row items-center gap-2 py-1 px-2 bg-muted/50 rounded-md">
            <GripVertical size={12} className="text-muted-foreground" />
            <Text className="text-xs text-foreground flex-1">
              {child ? `${child.component}` : childId}
            </Text>
            <Text className="text-xs text-muted-foreground font-mono">#{childId}</Text>
          </View>
        )
      })}
    </View>
  )
}

const MUTATION_METHODS = ['OPEN', 'POST', 'PATCH', 'DELETE'] as const

function ButtonActionSection({
  component,
  surfaceId,
  onPropChange,
}: {
  component: ComponentDefinition
  surfaceId: string
  onPropChange: (key: string, value: unknown) => void
}) {
  const action = component.action as { name?: string; mutation?: { endpoint?: unknown; method?: string; body?: unknown } } | undefined
  const mutation = action?.mutation
  const method = mutation?.method?.toUpperCase()
  const endpoint = mutation?.endpoint
  const isDataBound = typeof endpoint === 'object' && endpoint !== null && 'path' in endpoint
  const endpointDisplay = isDataBound ? (endpoint as { path: string }).path : typeof endpoint === 'string' ? endpoint : ''
  const isOpen = method === 'OPEN'

  const [editingEndpoint, setEditingEndpoint] = useState(false)
  const [localEndpoint, setLocalEndpoint] = useState(endpointDisplay)
  const [editingName, setEditingName] = useState(false)
  const [localName, setLocalName] = useState(action?.name ?? '')

  const commitEndpoint = useCallback(() => {
    setEditingEndpoint(false)
    const trimmed = localEndpoint.trim()
    if (!trimmed) return
    const isPath = !trimmed.startsWith('http') && !trimmed.startsWith('/')
    const newEndpoint = isPath ? { path: trimmed } : trimmed
    onPropChange('action', {
      ...action,
      name: action?.name || 'open',
      mutation: { ...mutation, endpoint: newEndpoint, method: mutation?.method || 'OPEN' },
    })
  }, [localEndpoint, action, mutation, onPropChange])

  const commitName = useCallback(() => {
    setEditingName(false)
    if (!localName.trim()) return
    onPropChange('action', { ...action, name: localName.trim() })
  }, [localName, action, onPropChange])

  const setMethod = useCallback((m: string) => {
    onPropChange('action', {
      ...action,
      name: action?.name || 'action',
      mutation: { ...mutation, method: m },
    })
  }, [action, mutation, onPropChange])

  const addDefaultAction = useCallback(() => {
    onPropChange('action', {
      name: 'open',
      mutation: { endpoint: 'https://example.com', method: 'OPEN' },
    })
    setLocalEndpoint('https://example.com')
    setLocalName('open')
  }, [onPropChange])

  if (!action) {
    return (
      <View className="gap-2">
        <Text className="text-xs font-semibold text-foreground uppercase tracking-wide">Action</Text>
        <View className="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 p-3 gap-2">
          <View className="flex-row items-center gap-1.5">
            <AlertTriangle size={13} color="#d97706" />
            <Text className="text-xs font-medium text-amber-700 dark:text-amber-400">No action configured</Text>
          </View>
          <Text className="text-xs text-amber-600 dark:text-amber-500">
            This button does nothing when clicked.
          </Text>
          <Pressable
            onPress={addDefaultAction}
            className="mt-1 self-start rounded-md bg-amber-600 dark:bg-amber-700 px-3 py-1.5 active:opacity-80"
          >
            <Text className="text-xs font-medium text-white">Add action</Text>
          </Pressable>
        </View>
      </View>
    )
  }

  return (
    <View className="gap-2">
      <Text className="text-xs font-semibold text-foreground uppercase tracking-wide">Action</Text>

      <View className="rounded-lg border border-border bg-muted/30 p-3 gap-3">
        {/* Action name */}
        <View className="gap-1">
          <Text className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Name</Text>
          {editingName ? (
            <TextInput
              value={localName}
              onChangeText={setLocalName}
              onBlur={commitName}
              autoFocus
              className="border border-border rounded-md px-2 py-1 text-xs text-foreground bg-background font-mono"
            />
          ) : (
            <Pressable onPress={() => { setLocalName(action?.name ?? ''); setEditingName(true) }}>
              <Text className="text-xs text-foreground font-mono">{action?.name || '(none)'}</Text>
            </Pressable>
          )}
        </View>

        {/* Method selector */}
        {mutation && (
          <View className="gap-1">
            <Text className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Method</Text>
            <View className="flex-row gap-1">
              {MUTATION_METHODS.map((m) => (
                <Pressable
                  key={m}
                  onPress={() => setMethod(m)}
                  className={`px-2 py-1 rounded-md border ${
                    method === m
                      ? m === 'OPEN' ? 'bg-blue-100 dark:bg-blue-900/40 border-blue-400 dark:border-blue-600'
                        : m === 'DELETE' ? 'bg-red-100 dark:bg-red-900/40 border-red-400 dark:border-red-600'
                        : 'bg-primary/10 border-primary'
                      : 'border-border bg-background'
                  }`}
                >
                  <Text className={`text-[10px] font-semibold ${
                    method === m
                      ? m === 'OPEN' ? 'text-blue-700 dark:text-blue-300'
                        : m === 'DELETE' ? 'text-red-700 dark:text-red-300'
                        : 'text-primary'
                      : 'text-muted-foreground'
                  }`}>
                    {m}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        )}

        {/* Endpoint / URL */}
        {mutation && (
          <View className="gap-1">
            <View className="flex-row items-center gap-1">
              {isOpen ? <ExternalLink size={10} color="#3b82f6" /> : <Zap size={10} className="text-muted-foreground" />}
              <Text className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                {isOpen ? 'URL' : 'Endpoint'}
              </Text>
              {isDataBound && (
                <View className="rounded px-1 py-0.5 bg-blue-100 dark:bg-blue-900/40">
                  <Text className="text-[9px] font-semibold text-blue-600 dark:text-blue-400">DATA BOUND</Text>
                </View>
              )}
            </View>
            {editingEndpoint ? (
              <TextInput
                value={localEndpoint}
                onChangeText={setLocalEndpoint}
                onBlur={commitEndpoint}
                autoFocus
                placeholder={isOpen ? 'https://... or field name' : '/api/...'}
                className="border border-border rounded-md px-2 py-1 text-xs text-foreground bg-background font-mono"
                placeholderTextColor="#9ca3af"
              />
            ) : (
              <Pressable onPress={() => { setLocalEndpoint(endpointDisplay); setEditingEndpoint(true) }}>
                <Text
                  className={`text-xs font-mono ${
                    endpointDisplay
                      ? isDataBound
                        ? 'text-blue-600 dark:text-blue-400'
                        : isOpen ? 'text-blue-600 dark:text-blue-400' : 'text-foreground'
                      : 'text-destructive italic'
                  }`}
                  numberOfLines={2}
                >
                  {endpointDisplay || '(no endpoint — click to set)'}
                </Text>
              </Pressable>
            )}
            {isDataBound && (
              <Text className="text-[10px] text-muted-foreground">
                Reads "{(endpoint as { path: string }).path}" from each DataList item
              </Text>
            )}
          </View>
        )}

        {/* No mutation warning */}
        {!mutation && (
          <View className="rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 p-2">
            <View className="flex-row items-center gap-1.5">
              <AlertTriangle size={11} color="#d97706" />
              <Text className="text-[10px] text-amber-700 dark:text-amber-400 font-medium">
                No mutation — button will dispatch to agent but won't open a URL or call an API
              </Text>
            </View>
          </View>
        )}
      </View>
    </View>
  )
}

function DataBindingsSection({ component }: { component: ComponentDefinition }) {
  const bindings = useMemo(() => {
    const found: Array<{ key: string; path: string }> = []
    for (const [key, value] of Object.entries(component)) {
      if (key === 'id' || key === 'component' || key === 'children' || key === 'child') continue
      if (typeof value === 'object' && value !== null && 'path' in value) {
        found.push({ key, path: (value as any).path })
      }
    }
    return found
  }, [component])

  if (bindings.length === 0) return null

  return (
    <View className="gap-2">
      <Text className="text-xs font-semibold text-foreground uppercase tracking-wide">Data Bindings</Text>
      {bindings.map(({ key, path }) => (
        <View key={key} className="flex-row items-center gap-2 py-1 px-2 bg-blue-50 dark:bg-blue-950/30 rounded-md">
          <Text className="text-xs font-medium text-foreground">{key}</Text>
          <Text className="text-xs text-blue-600 dark:text-blue-400 font-mono">{path}</Text>
        </View>
      ))}
    </View>
  )
}
