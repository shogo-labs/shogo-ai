// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useCallback, useMemo } from 'react'
import { View, Pressable, ScrollView } from 'react-native'
import { Text } from '@/components/ui/text'
import { ChevronRight, ChevronDown, Plus, Trash2, GripVertical, ArrowUp, ArrowDown } from 'lucide-react-native'
import type { ComponentDefinition } from '@shogo/shared-app/dynamic-app'
import { useEditMode } from './EditModeContext'
import { AddComponentDialog } from './AddComponentDialog'

interface ComponentTreePanelProps {
  surfaceId: string
  components: Map<string, ComponentDefinition>
}

export function ComponentTreePanel({ surfaceId, components }: ComponentTreePanelProps) {
  const rootComponent = components.get('root')

  if (!rootComponent) {
    return (
      <View className="w-56 border-r border-border bg-background p-3">
        <Text className="text-xs text-muted-foreground">No root component</Text>
      </View>
    )
  }

  return (
    <View testID="component-tree-panel" className="w-56 border-r border-border bg-background">
      <View className="px-3 py-2 border-b border-border">
        <Text className="text-xs font-semibold text-foreground uppercase tracking-wide">Component Tree</Text>
      </View>
      <ScrollView className="flex-1">
        <View className="py-1">
          <TreeNode
            componentId="root"
            components={components}
            surfaceId={surfaceId}
            depth={0}
          />
        </View>
      </ScrollView>
    </View>
  )
}

interface TreeNodeProps {
  componentId: string
  components: Map<string, ComponentDefinition>
  surfaceId: string
  depth: number
  parentId?: string
  indexInParent?: number
  siblingCount?: number
}

function TreeNode({ componentId, components, surfaceId, depth, parentId, indexInParent, siblingCount }: TreeNodeProps) {
  const { selectedComponentId, selectComponent, deleteComponent, moveComponent } = useEditMode()
  const [isExpanded, setIsExpanded] = useState(depth < 2)
  const [showAddDialog, setShowAddDialog] = useState(false)

  const component = components.get(componentId)
  if (!component) return null

  const childIds = useMemo(() => {
    if (Array.isArray(component.children)) return component.children as string[]
    if (component.child) return [component.child]
    return []
  }, [component.children, component.child])

  const hasChildren = childIds.length > 0
  const isSelected = selectedComponentId === componentId
  const isRoot = componentId === 'root'

  const handleMoveUp = useCallback(() => {
    if (parentId && typeof indexInParent === 'number' && indexInParent > 0) {
      moveComponent(surfaceId, componentId, parentId, indexInParent - 1)
    }
  }, [surfaceId, componentId, parentId, indexInParent, moveComponent])

  const handleMoveDown = useCallback(() => {
    if (parentId && typeof indexInParent === 'number' && typeof siblingCount === 'number' && indexInParent < siblingCount - 1) {
      moveComponent(surfaceId, componentId, parentId, indexInParent + 2)
    }
  }, [surfaceId, componentId, parentId, indexInParent, siblingCount, moveComponent])

  return (
    <>
      <Pressable
        onPress={() => selectComponent(isSelected ? null : componentId)}
        className={`flex-row items-center py-1 pr-2 ${isSelected ? 'bg-primary/10' : 'hover:bg-muted/50'}`}
        style={{ paddingLeft: depth * 16 + 4 }}
      >
        {hasChildren ? (
          <Pressable onPress={() => setIsExpanded(!isExpanded)} className="p-0.5">
            {isExpanded ? (
              <ChevronDown size={12} className="text-muted-foreground" />
            ) : (
              <ChevronRight size={12} className="text-muted-foreground" />
            )}
          </Pressable>
        ) : (
          <View style={{ width: 16 }} />
        )}

        <Text className={`text-xs flex-1 ml-1 ${isSelected ? 'text-primary font-medium' : 'text-foreground'}`} numberOfLines={1}>
          {component.component}
        </Text>
        <Text className="text-[10px] text-muted-foreground font-mono" numberOfLines={1}>
          {componentId.length > 8 ? `${componentId.slice(0, 8)}…` : componentId}
        </Text>

        {isSelected && !isRoot && (
          <View className="flex-row ml-1 gap-0.5">
            {typeof indexInParent === 'number' && indexInParent > 0 && (
              <Pressable onPress={handleMoveUp} className="p-0.5">
                <ArrowUp size={10} className="text-muted-foreground" />
              </Pressable>
            )}
            {typeof indexInParent === 'number' && typeof siblingCount === 'number' && indexInParent < siblingCount - 1 && (
              <Pressable onPress={handleMoveDown} className="p-0.5">
                <ArrowDown size={10} className="text-muted-foreground" />
              </Pressable>
            )}
            <Pressable onPress={() => setShowAddDialog(true)} className="p-0.5">
              <Plus size={10} className="text-primary" />
            </Pressable>
            <Pressable onPress={() => deleteComponent(surfaceId, componentId)} className="p-0.5">
              <Trash2 size={10} className="text-destructive" />
            </Pressable>
          </View>
        )}
      </Pressable>

      {isExpanded && hasChildren && childIds.map((childId, idx) => (
        <TreeNode
          key={childId}
          componentId={childId}
          components={components}
          surfaceId={surfaceId}
          depth={depth + 1}
          parentId={componentId}
          indexInParent={idx}
          siblingCount={childIds.length}
        />
      ))}

      {showAddDialog && (
        <AddComponentDialog
          visible={showAddDialog}
          onClose={() => setShowAddDialog(false)}
          surfaceId={surfaceId}
          parentId={componentId}
        />
      )}
    </>
  )
}
