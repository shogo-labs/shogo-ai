// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useCallback, type ReactNode } from 'react'
import { View, Pressable, Platform } from 'react-native'
import { Text } from '@/components/ui/text'
import { useEditModeOptional } from './EditModeContext'

interface EditableWrapperProps {
  componentId: string
  componentType: string
  children: ReactNode
}

export function EditableWrapper({ componentId, componentType, children }: EditableWrapperProps) {
  const editMode = useEditModeOptional()
  const [isHovered, setIsHovered] = useState(false)
  const isEditMode = editMode?.isEditMode ?? false
  const isSelected = isEditMode && editMode?.selectedComponentId === componentId

  const handlePress = useCallback(() => {
    editMode?.selectComponent(isSelected ? null : componentId)
  }, [editMode, componentId, isSelected])

  const onHoverIn = useCallback(() => setIsHovered(true), [])
  const onHoverOut = useCallback(() => setIsHovered(false), [])

  if (!isEditMode || Platform.OS !== 'web') {
    return <>{children}</>
  }

  return (
    <Pressable
      onPress={handlePress}
      onHoverIn={onHoverIn}
      onHoverOut={onHoverOut}
      style={{ position: 'relative' }}
    >
      <View
        style={[
          {
            borderWidth: isSelected ? 2 : isHovered ? 1 : 0,
            borderColor: isSelected ? '#3b82f6' : '#93c5fd',
            borderStyle: isSelected ? 'solid' : 'dashed',
            borderRadius: 4,
            minHeight: 8,
          },
          { pointerEvents: 'box-none' },
        ]}
      >
        {children}
      </View>

      {(isSelected || isHovered) && (
        <View
          style={{
            position: 'absolute',
            top: -18,
            left: 0,
            backgroundColor: isSelected ? '#3b82f6' : '#93c5fd',
            borderTopLeftRadius: 4,
            borderTopRightRadius: 4,
            paddingHorizontal: 6,
            paddingVertical: 1,
            zIndex: 50,
          }}
        >
          <Text style={{ fontSize: 10, color: '#fff', fontWeight: '500' }}>
            {componentType}
          </Text>
        </View>
      )}
    </Pressable>
  )
}
