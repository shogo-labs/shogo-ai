// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import React, { useState, useCallback } from 'react'
import { View, Pressable, Platform } from 'react-native'
import { Text } from '@/components/ui/text'
import { Pencil, Eye, ListTree, Plus, Trash2 } from 'lucide-react-native'
import { useEditMode } from './EditModeContext'
import { AddComponentDialog } from './AddComponentDialog'
import type { ComponentDefinition } from '@shogo/shared-app/dynamic-app'

interface EditToolbarProps {
  surfaceId: string | null
  components?: Map<string, ComponentDefinition>
  trailing?: React.ReactNode
}

export function EditToolbar({ surfaceId, components, trailing }: EditToolbarProps) {
  if (Platform.OS !== 'web') return null

  const {
    isEditMode, toggleEditMode, selectedComponentId, selectComponent,
    showTreePanel, toggleTreePanel, deleteComponent,
  } = useEditMode()
  const [showAddDialog, setShowAddDialog] = useState(false)

  const selectedComponent = selectedComponentId && components?.get(selectedComponentId)
  const breadcrumb = selectedComponent
    ? `${(selectedComponent as ComponentDefinition).component}#${selectedComponentId}`
    : null

  const handleDelete = useCallback(() => {
    if (surfaceId && selectedComponentId && selectedComponentId !== 'root') {
      deleteComponent(surfaceId, selectedComponentId)
    }
  }, [surfaceId, selectedComponentId, deleteComponent])

  const rootComponent = components?.get('root')
  const addParentId = selectedComponentId || 'root'

  return (
    <>
      <View testID="edit-toolbar" className="flex-row items-center border-b border-border/50 bg-surface-1 px-3 py-1.5 gap-2">
        <Pressable
          testID="edit-mode-toggle"
          onPress={toggleEditMode}
          className={`flex-row items-center gap-1.5 px-2.5 py-1.5 rounded-md ${
            isEditMode ? 'bg-primary' : 'bg-muted'
          }`}
        >
          {isEditMode ? (
            <Eye size={14} className={isEditMode ? 'text-primary-foreground' : 'text-foreground'} />
          ) : (
            <Pencil size={14} className="text-foreground" />
          )}
          <Text
            className={`text-xs font-medium ${
              isEditMode ? 'text-primary-foreground' : 'text-foreground'
            }`}
          >
            {isEditMode ? 'Preview' : 'Edit'}
          </Text>
        </Pressable>

        {isEditMode && (
          <>
            <View className="w-px h-4 bg-border" />

            <Pressable
              testID="tree-panel-toggle"
              onPress={toggleTreePanel}
              className={`flex-row items-center gap-1.5 px-2.5 py-1.5 rounded-md ${
                showTreePanel ? 'bg-accent' : ''
              }`}
            >
              <ListTree size={14} className="text-muted-foreground" />
              <Text className="text-xs text-muted-foreground">Tree</Text>
            </Pressable>

            <Pressable
              testID="add-component-btn"
              onPress={() => setShowAddDialog(true)}
              className="flex-row items-center gap-1.5 px-2.5 py-1.5 rounded-md hover:bg-muted"
            >
              <Plus size={14} className="text-muted-foreground" />
              <Text className="text-xs text-muted-foreground">Add</Text>
            </Pressable>

            {selectedComponentId && selectedComponentId !== 'root' && (
              <Pressable
                testID="delete-component-btn"
                onPress={handleDelete}
                className="flex-row items-center gap-1.5 px-2.5 py-1.5 rounded-md hover:bg-destructive/10"
              >
                <Trash2 size={14} className="text-destructive" />
                <Text className="text-xs text-destructive">Delete</Text>
              </Pressable>
            )}

            {breadcrumb && (
              <>
                <View className="flex-1" />
                <Text testID="component-breadcrumb" className="text-xs text-muted-foreground font-mono">{breadcrumb}</Text>
              </>
            )}
          </>
        )}

        {trailing && (
          <>
            <View className="flex-1" />
            {trailing}
          </>
        )}
      </View>

      {surfaceId && (
        <AddComponentDialog
          visible={showAddDialog}
          onClose={() => setShowAddDialog(false)}
          surfaceId={surfaceId}
          parentId={addParentId}
        />
      )}
    </>
  )
}
