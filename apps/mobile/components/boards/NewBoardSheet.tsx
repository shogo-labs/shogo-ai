// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Add a board to a channel. The type picks the starting columns (a sales
 * pipeline gets Lead → Won/Lost, a problem board gets Detected → Resolved);
 * columns can be changed later, or by the workspace agent.
 */
import { useState } from 'react'
import { ActivityIndicator, Modal, Pressable, Text, TextInput, View } from 'react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { ITEM_TYPE_LABELS, workBoardsApi, type Board, type ItemType } from '../../lib/work-boards-api'

const api = workBoardsApi()

const TYPES: ItemType[] = ['task', 'ticket', 'deal', 'candidate', 'approval', 'content', 'problem']

export function NewBoardSheet({ workspaceId, conversationId, onCreated, onClose }: {
  workspaceId: string
  conversationId: string
  onCreated: (board: Board) => void
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [itemType, setItemType] = useState<ItemType>('task')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const title = name.trim() || ITEM_TYPE_LABELS[itemType]

  const create = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      onCreated(await api.create(workspaceId, { conversationId, name: title, itemType }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the board')
      setBusy(false)
    }
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable className="flex-1 items-center justify-center bg-black/40 p-6" onPress={onClose} accessibilityLabel="Close">
        <Pressable
          className="w-full max-w-sm gap-3 rounded-xl bg-card p-4"
          onPress={(event) => (event as { stopPropagation?: () => void }).stopPropagation?.()}
        >
          <Text className="text-base font-semibold text-foreground">New board</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            autoFocus
            placeholder={ITEM_TYPE_LABELS[itemType]}
            placeholderTextColor="#8a8a8a"
            accessibilityLabel="Board name"
            onSubmitEditing={() => void create()}
            className="rounded-md border border-border px-3 py-2.5 text-base text-foreground"
          />
          <View className="flex-row flex-wrap gap-1.5" accessibilityRole="radiogroup" accessibilityLabel="Board type">
            {TYPES.map((t) => (
              <Pressable
                key={t}
                accessibilityRole="radio"
                aria-checked={t === itemType}
                onPress={() => setItemType(t)}
                className={cn('rounded-full border px-3 py-1', t === itemType ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted')}
              >
                <Text className={cn('text-xs', t === itemType ? 'font-medium text-primary' : 'text-muted-foreground')}>{ITEM_TYPE_LABELS[t]}</Text>
              </Pressable>
            ))}
          </View>
          {error ? <Text className="text-xs text-destructive">{error}</Text> : null}
          <View className="flex-row justify-end gap-2">
            <Pressable accessibilityRole="button" onPress={onClose} className="rounded-md px-3 py-1.5">
              <Text className="text-sm text-muted-foreground">Cancel</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => void create()} disabled={busy} className="flex-row items-center gap-2 rounded-md bg-primary px-3 py-1.5" testID="create-board">
              {busy ? <ActivityIndicator size="small" /> : null}
              <Text className="text-sm text-primary-foreground">Create</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  )
}
