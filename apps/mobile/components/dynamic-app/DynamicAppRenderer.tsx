// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * DynamicAppRenderer (React Native)
 *
 * Core rendering engine for the Dynamic App canvas. Takes a surface's
 * component map and data model, then recursively renders from the "root"
 * component, resolving data bindings and dispatching user actions.
 *
 * Supports two data binding modes:
 * - { path: "/some/pointer" } -- resolves against in-memory dataModel
 * - { api: "/api/todos" }     -- fetches from managed API runtime
 *
 * Supports two action modes:
 * - Actions with a `mutation` key are handled by the frontend directly
 * - Actions without `mutation` dispatch to the agent via canvas_action_wait
 */

import { useMemo, useCallback, useEffect, useRef, type ReactNode } from 'react'
import { View, ActivityIndicator } from 'react-native'
import { Text } from '@/components/ui/text'
import type { SurfaceState, ComponentDefinition } from '@shogo/shared-app/dynamic-app'
import { isApiBinding, getByPointer } from '@shogo/shared-app/dynamic-app'
import { useApiDataSource, type ApiDataSourceResult } from '@shogo/shared-app/dynamic-app'
import { resolveValue, sanitizeForRender, RESERVED_KEYS } from '@shogo/shared-app/dynamic-app'
import { COMPONENT_CATALOG } from './catalog'
import { applySmartDefaults, type SmartDefaultsContext } from './smart-defaults'
import { EditableWrapper } from './edit/EditableWrapper'
import { useEditModeOptional } from './edit/EditModeContext'

interface RendererProps {
  surface: SurfaceState
  agentUrl: string | null
  onAction: (surfaceId: string, name: string, context?: Record<string, unknown>) => void
  onDataChange?: (surfaceId: string, path: string, value: unknown) => void
  authHeaders?: () => Record<string, string>
}

export function DynamicAppRenderer({ surface, agentUrl, onAction, onDataChange, authHeaders }: RendererProps) {
  const apiDataSource = useApiDataSource(agentUrl, surface.surfaceId, authHeaders ? { headers: authHeaders } : undefined)

  const handleAction = useCallback(
    async (name: string, context?: Record<string, unknown>) => {
      onAction(surface.surfaceId, name, context)
    },
    [surface.surfaceId, onAction],
  )

  const handleDataChange = useCallback(
    (path: string, value: unknown, options?: { persist?: boolean }) => {
      if (onDataChange) {
        onDataChange(surface.surfaceId, path, value, options)
      }
    },
    [surface.surfaceId, onDataChange],
  )

  const rootComponent = surface.components.get('root')
  if (!rootComponent) {
    return (
      <View className="flex-row items-center justify-center h-32 gap-2">
        <ActivityIndicator size="small" />
        <Text className="text-muted-foreground text-sm">Loading...</Text>
      </View>
    )
  }

  return (
    <View className="p-4">
      <ComponentNode
        definition={rootComponent}
        components={surface.components}
        dataModel={surface.dataModel}
        onAction={handleAction}
        onDataChange={handleDataChange}
        apiDataSource={apiDataSource}
        isRoot
      />
    </View>
  )
}


// ---------------------------------------------------------------------------
// Recursive Component Node
// ---------------------------------------------------------------------------

interface ComponentNodeProps {
  definition: ComponentDefinition
  components: Map<string, ComponentDefinition>
  dataModel: Record<string, unknown>
  onAction: (name: string, context?: Record<string, unknown>) => void
  onDataChange?: (path: string, value: unknown, options?: { persist?: boolean }) => void
  apiDataSource: ApiDataSourceResult
  scopeData?: Record<string, unknown>
  scopePath?: string
  isRoot?: boolean
  parentComponent?: string
}

function ComponentNode({ definition, components, dataModel, onAction, onDataChange, apiDataSource, scopeData, scopePath, isRoot, parentComponent }: ComponentNodeProps) {
  const editMode = useEditModeOptional()
  const catalogEntry = COMPONENT_CATALOG[definition.component]
  if (!catalogEntry) {
    return (
      <View className="border border-red-200 rounded px-2 py-1">
        <Text className="text-xs text-red-500">Unknown component: {definition.component}</Text>
      </View>
    )
  }

  const smartCtx: SmartDefaultsContext = { isRoot: !!isRoot, parentComponent, components }
  const enhancedDefinition = applySmartDefaults(definition, smartCtx)

  let resolvedProps = useResolvedProps(enhancedDefinition, dataModel, apiDataSource, scopeData, scopePath)

  // Auto-derive tabs from TabPanel children when `tabs` prop is missing
  if (enhancedDefinition.component === 'Tabs' && !resolvedProps.tabs && Array.isArray(enhancedDefinition.children)) {
    const childIds = enhancedDefinition.children as string[]
    const autoTabs = childIds.map((childId) => {
      const childDef = components.get(childId)
      const label = childDef?.title ?? childDef?.label
      return label ? { id: childId, label: String(label) } : null
    }).filter((t): t is { id: string; label: string } => t !== null)
    if (autoTabs.length > 0) {
      resolvedProps = { ...resolvedProps, tabs: autoTabs }
    }
  }

  // Auto-inject __delete_item__ action for delete buttons inside DataList scopes
  if (resolvedProps.deleteAction && scopeData && scopePath) {
    const itemId = (scopeData as any).id
    if (itemId) {
      const lastSlash = scopePath.lastIndexOf('/')
      const collectionPath = lastSlash > 0 ? scopePath.substring(0, lastSlash) : scopePath
      resolvedProps = {
        ...resolvedProps,
        action: {
          name: '__delete_item__',
          context: { collectionPath, itemId: String(itemId) },
        },
      }
    }
  }

  const suppressActions = editMode?.isEditMode
  const noopAction = useCallback(() => {}, [])
  const effectiveOnAction = suppressActions ? noopAction : onAction
  const effectiveOnDataChange = suppressActions ? undefined : onDataChange

  // Scope-aware onDataChange that joins scopePath for DataList items
  const scopedOnDataChange = useCallback(
    (path: string, value: unknown, options?: { persist?: boolean }) => {
      if (!effectiveOnDataChange) return
      if (scopePath && !path.startsWith('/')) {
        effectiveOnDataChange(`${scopePath}/${path}`, value, options)
      } else {
        effectiveOnDataChange(path, value, options)
      }
    },
    [effectiveOnDataChange, scopePath],
  )

  const children = useRenderedChildren(enhancedDefinition, components, dataModel, effectiveOnAction, effectiveOnDataChange, apiDataSource, scopeData, scopePath, definition.component)

  const Component = catalogEntry.component

  const rendered = (
    <Component
      {...resolvedProps}
      onAction={effectiveOnAction}
      onDataChange={scopedOnDataChange}
    >
      {children}
    </Component>
  )

  return (
    <EditableWrapper componentId={definition.id} componentType={definition.component}>
      {rendered}
    </EditableWrapper>
  )
}

// ---------------------------------------------------------------------------
// Prop Resolution (data binding)
// ---------------------------------------------------------------------------

function useResolvedProps(
  definition: ComponentDefinition,
  dataModel: Record<string, unknown>,
  apiDataSource: ApiDataSourceResult,
  scopeData?: Record<string, unknown>,
  scopePath?: string,
) {
  const apiBindings = useMemo(() => {
    const bindings: Array<{ key: string; api: string; params?: Record<string, unknown>; refreshInterval?: number }> = []
    function scan(val: unknown, keyPath: string) {
      if (isApiBinding(val)) {
        bindings.push({ key: `${definition.id}:${keyPath}`, ...val })
        return
      }
      if (Array.isArray(val)) {
        val.forEach((item, i) => scan(item, `${keyPath}[${i}]`))
        return
      }
      if (typeof val === 'object' && val !== null) {
        for (const [k, v] of Object.entries(val)) {
          scan(v, keyPath ? `${keyPath}.${k}` : k)
        }
      }
    }
    for (const [key, value] of Object.entries(definition)) {
      if (RESERVED_KEYS.has(key)) continue
      scan(value, key)
    }
    return bindings
  }, [definition])

  const registeredRef = useRef<Set<string>>(new Set())

  const resolvedApiBindings = useMemo(() => {
    return apiBindings.map((binding) => {
      if (!binding.params || Object.keys(binding.params).length === 0) return binding
      const resolvedParams: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(binding.params)) {
        resolvedParams[k] = resolveValue(v, dataModel, null, scopeData, scopePath)
      }
      return { ...binding, params: resolvedParams }
    })
  }, [apiBindings, dataModel, scopeData, scopePath])

  useEffect(() => {
    const currentKeys = new Set<string>()
    for (const binding of resolvedApiBindings) {
      currentKeys.add(binding.key)
      apiDataSource.registerBinding(binding.key, {
        api: binding.api,
        params: binding.params,
        refreshInterval: binding.refreshInterval,
      })
    }
    for (const key of registeredRef.current) {
      if (!currentKeys.has(key)) {
        apiDataSource.unregisterBinding(key)
      }
    }
    registeredRef.current = currentKeys
    return () => {
      for (const key of currentKeys) {
        apiDataSource.unregisterBinding(key)
      }
    }
  }, [resolvedApiBindings, apiDataSource])

  return useMemo(() => {
    const resolved: Record<string, unknown> = {}

    for (const [key, value] of Object.entries(definition)) {
      if (RESERVED_KEYS.has(key)) continue
      resolved[key] = resolveValue(value, dataModel, apiDataSource, scopeData, scopePath)
    }

    return sanitizeForRender(resolved)
  }, [definition, dataModel, apiDataSource, scopeData, scopePath])
}

// ---------------------------------------------------------------------------
// Children Resolution
// ---------------------------------------------------------------------------

function useRenderedChildren(
  definition: ComponentDefinition,
  components: Map<string, ComponentDefinition>,
  dataModel: Record<string, unknown>,
  onAction: (name: string, context?: Record<string, unknown>) => void,
  onDataChange: ((path: string, value: unknown, options?: { persist?: boolean }) => void) | undefined,
  apiDataSource: ApiDataSourceResult,
  scopeData?: Record<string, unknown>,
  scopePath?: string,
  parentComponent?: string,
): ReactNode {
  return useMemo(() => {
    if (definition.child) {
      const childDef = components.get(definition.child)
      if (!childDef) return null
      return (
        <ComponentNode
          key={definition.child}
          definition={childDef}
          components={components}
          dataModel={dataModel}
          onAction={onAction}
          onDataChange={onDataChange}
          apiDataSource={apiDataSource}
          scopeData={scopeData}
          scopePath={scopePath}
          parentComponent={parentComponent}
        />
      )
    }

    if (definition.children) {
      if (typeof definition.children === 'object' && !Array.isArray(definition.children)) {
        const tmpl = definition.children as { path: string; templateId: string }
        let items = getByPointer(dataModel, tmpl.path)
        if (!Array.isArray(items)) return null

        const templateDef = components.get(tmpl.templateId)
        if (!templateDef) return null

        // Exact-value filtering: show only items matching all where conditions
        const where = definition.where as Record<string, unknown> | undefined
        if (where && typeof where === 'object') {
          items = items.filter((item: unknown) => {
            if (typeof item !== 'object' || item === null) return false
            const rec = item as Record<string, unknown>
            return Object.entries(where).every(([k, v]) => rec[k] === v)
          })
        }

        // Text search filtering: substring match across specified fields
        const filterPath = definition.filterPath as string | undefined
        const filterFields = definition.filterFields as string[] | undefined
        if (filterPath && filterFields?.length) {
          const term = getByPointer(dataModel, filterPath)
          if (typeof term === 'string' && term.length > 0) {
            const lower = term.toLowerCase()
            items = items.filter((item: unknown) => {
              if (typeof item !== 'object' || item === null) return false
              const rec = item as Record<string, unknown>
              return filterFields.some((field) => {
                const val = rec[field]
                return typeof val === 'string' && val.toLowerCase().includes(lower)
              })
            })
          }
        }

        return items.map((item, index) => (
          <ComponentNode
            key={`${tmpl.templateId}-${index}`}
            definition={templateDef}
            components={components}
            dataModel={dataModel}
            onAction={onAction}
            onDataChange={onDataChange}
            apiDataSource={apiDataSource}
            scopeData={typeof item === 'object' && item !== null ? item as Record<string, unknown> : { value: item }}
            scopePath={`${tmpl.path}/${index}`}
            parentComponent={parentComponent}
          />
        ))
      }

      const childIds = definition.children as string[]
      return childIds.map((childId) => {
        const childDef = components.get(childId)
        if (!childDef) return null
        return (
          <ComponentNode
            key={childId}
            definition={childDef}
            components={components}
            dataModel={dataModel}
            onAction={onAction}
            onDataChange={onDataChange}
            apiDataSource={apiDataSource}
            scopeData={scopeData}
            scopePath={scopePath}
            parentComponent={definition.component}
          />
        )
      })
    }

    return null
  }, [definition, components, dataModel, onAction, onDataChange, apiDataSource, scopeData, scopePath, parentComponent])
}

// ---------------------------------------------------------------------------
// Multi-Surface Renderer
// ---------------------------------------------------------------------------

interface MultiSurfaceRendererProps {
  surfaces: Map<string, SurfaceState>
  activeSurfaceId?: string | null
  agentUrl: string | null
  onAction: (surfaceId: string, name: string, context?: Record<string, unknown>) => void
  onDataChange?: (surfaceId: string, path: string, value: unknown, options?: { persist?: boolean }) => void
}

export function MultiSurfaceRenderer({ surfaces, activeSurfaceId, agentUrl, onAction, onDataChange }: MultiSurfaceRendererProps) {
  if (activeSurfaceId) {
    const active = surfaces.get(activeSurfaceId)
    if (active) {
      return <DynamicAppRenderer surface={active} agentUrl={agentUrl} onAction={onAction} onDataChange={onDataChange} />
    }
  }

  const surfaceList = Array.from(surfaces.values())

  if (surfaceList.length === 0) {
    return null
  }

  if (surfaceList.length === 1) {
    return <DynamicAppRenderer surface={surfaceList[0]} agentUrl={agentUrl} onAction={onAction} onDataChange={onDataChange} />
  }

  return (
    <View className="flex flex-col gap-6 p-4">
      {surfaceList.map((surface) => (
        <View key={surface.surfaceId}>
          {surface.title && (
            <Text className="text-lg font-semibold mb-3">{surface.title}</Text>
          )}
          <DynamicAppRenderer surface={surface} agentUrl={agentUrl} onAction={onAction} onDataChange={onDataChange} />
        </View>
      ))}
    </View>
  )
}
