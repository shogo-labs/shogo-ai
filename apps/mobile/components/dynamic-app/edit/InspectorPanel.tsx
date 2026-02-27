import { useMemo, useCallback } from 'react'
import { View, ScrollView, Pressable } from 'react-native'
import { Text } from '@/components/ui/text'
import { X, Trash2, GripVertical } from 'lucide-react-native'
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
