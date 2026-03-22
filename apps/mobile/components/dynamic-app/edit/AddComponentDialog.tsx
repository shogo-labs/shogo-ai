// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useCallback } from 'react'
import { View, Pressable, ScrollView, Modal } from 'react-native'
import { Text } from '@/components/ui/text'
import { X, Plus, Layout, Type, BarChart3, MousePointer, Layers } from 'lucide-react-native'
import { COMPONENT_SCHEMA, COMPONENT_CATEGORIES, type ComponentSchema } from '@shogo/shared-app/dynamic-app'
import { useEditMode } from './EditModeContext'

interface AddComponentDialogProps {
  visible: boolean
  onClose: () => void
  surfaceId: string
  parentId: string
  index?: number
}

const CATEGORY_LABELS: Record<string, { label: string; Icon: any }> = {
  layout: { label: 'Layout', Icon: Layout },
  extended: { label: 'Extended', Icon: Layers },
  display: { label: 'Display', Icon: Type },
  data: { label: 'Data', Icon: BarChart3 },
  interactive: { label: 'Interactive', Icon: MousePointer },
}

export function AddComponentDialog({ visible, onClose, surfaceId, parentId, index }: AddComponentDialogProps) {
  const { addComponent, selectComponent } = useEditMode()
  const [selectedCategory, setSelectedCategory] = useState<string>('layout')

  const handleAdd = useCallback(async (componentType: string) => {
    const newId = await addComponent(surfaceId, parentId, componentType, index)
    if (newId) {
      selectComponent(newId)
    }
    onClose()
  }, [addComponent, surfaceId, parentId, index, selectComponent, onClose])

  const filteredComponents = COMPONENT_SCHEMA.filter((s) => s.category === selectedCategory)

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        className="flex-1 bg-black/40 items-center justify-center"
      >
        <Pressable
          onPress={(e) => e.stopPropagation()}
          className="w-[480px] max-h-[500px] bg-background rounded-xl border border-border shadow-xl"
        >
          <View testID="add-component-dialog" className="flex-row items-center justify-between px-4 py-3 border-b border-border">
            <Text className="text-sm font-semibold text-foreground">Add Component</Text>
            <Pressable onPress={onClose} className="p-1 rounded-md hover:bg-muted">
              <X size={16} className="text-muted-foreground" />
            </Pressable>
          </View>

          <View className="flex-row flex-1">
            <View className="w-36 border-r border-border py-2">
              {COMPONENT_CATEGORIES.map((cat) => {
                const entry = CATEGORY_LABELS[cat]
                if (!entry) return null
                const { label, Icon } = entry
                return (
                  <Pressable
                    key={cat}
                    onPress={() => setSelectedCategory(cat)}
                    className={`flex-row items-center gap-2 px-3 py-2 mx-1 rounded-md ${
                      selectedCategory === cat ? 'bg-primary/10' : ''
                    }`}
                  >
                    <Icon size={14} className={selectedCategory === cat ? 'text-primary' : 'text-muted-foreground'} />
                    <Text className={`text-xs ${selectedCategory === cat ? 'text-primary font-medium' : 'text-muted-foreground'}`}>
                      {label}
                    </Text>
                  </Pressable>
                )
              })}
            </View>

            <ScrollView className="flex-1 py-2">
              <View className="gap-1 px-2">
                {filteredComponents.map((schema) => (
                  <ComponentOption key={schema.type} schema={schema} onSelect={handleAdd} />
                ))}
              </View>
            </ScrollView>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

function ComponentOption({ schema, onSelect }: { schema: ComponentSchema; onSelect: (type: string) => void }) {
  return (
    <Pressable
      onPress={() => onSelect(schema.type)}
      className="flex-row items-center gap-3 px-3 py-2.5 rounded-md hover:bg-muted"
    >
      <View className="w-8 h-8 rounded-md bg-primary/10 items-center justify-center">
        <Plus size={14} className="text-primary" />
      </View>
      <View className="flex-1">
        <Text className="text-sm font-medium text-foreground">{schema.type}</Text>
        <Text className="text-xs text-muted-foreground" numberOfLines={1}>{schema.description}</Text>
      </View>
      {schema.hasChildren && (
        <View className="px-1.5 py-0.5 bg-muted rounded">
          <Text className="text-[10px] text-muted-foreground">container</Text>
        </View>
      )}
    </Pressable>
  )
}
