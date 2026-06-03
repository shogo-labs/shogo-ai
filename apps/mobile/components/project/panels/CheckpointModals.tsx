// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Shared checkpoint modals (create + rollback confirm). Extracted from
// CheckpointsPanel so the IDE commit-graph view (web) and the native
// checkpoint graph can both reuse them. These are React Native components,
// so they render on both web (react-native-web) and native.
import { useState } from 'react'
import { View, Text, Pressable, TextInput, ActivityIndicator, Modal } from 'react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { type Checkpoint } from '@shogo/shared-app/hooks'
import { BookmarkPlus, X, AlertTriangle } from 'lucide-react-native'

export function CreateCheckpointModal({
  visible,
  onClose,
  onCreate,
  isMutating,
}: {
  visible: boolean
  onClose: () => void
  onCreate: (opts: { message: string; name?: string; description?: string }) => Promise<void>
  isMutating: boolean
}) {
  const [name, setName] = useState('')
  const [message, setMessage] = useState('')
  const [description, setDescription] = useState('')

  const canSubmit = message.trim().length > 0 && !isMutating

  const handleCreate = () => {
    if (!canSubmit) return
    onCreate({
      message: message.trim(),
      name: name.trim() || undefined,
      description: description.trim() || undefined,
    })
    setName('')
    setMessage('')
    setDescription('')
  }

  const handleClose = () => {
    setName('')
    setMessage('')
    setDescription('')
    onClose()
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={handleClose}>
      <Pressable onPress={handleClose} className="flex-1 bg-black/50 items-center justify-center px-6">
        <Pressable onPress={(e) => e.stopPropagation()} className="bg-background rounded-xl w-full max-w-md shadow-xl overflow-hidden">
          <View className="flex-row items-center justify-between px-5 pt-5 pb-3">
            <View className="flex-row items-center gap-2">
              <BookmarkPlus size={18} className="text-primary" />
              <Text className="text-base font-semibold text-foreground">Create Checkpoint</Text>
            </View>
            <Pressable onPress={handleClose} className="p-1 -mr-1 rounded-md active:bg-muted">
              <X size={18} className="text-muted-foreground" />
            </Pressable>
          </View>

          <View className="px-5 pb-2 gap-3">
            <View>
              <Text className="text-xs font-medium text-muted-foreground mb-1">Name (optional)</Text>
              <TextInput
                value={name}
                onChangeText={setName}
                placeholder="e.g. Before auth refactor"
                placeholderTextColor="#9ca3af"
                className="border border-border rounded-lg px-3 py-2.5 text-sm text-foreground web:outline-none"
              />
            </View>
            <View>
              <Text className="text-xs font-medium text-muted-foreground mb-1">
                Message <Text className="text-destructive">*</Text>
              </Text>
              <TextInput
                value={message}
                onChangeText={setMessage}
                placeholder="What changed? e.g. Added user authentication"
                placeholderTextColor="#9ca3af"
                className="border border-border rounded-lg px-3 py-2.5 text-sm text-foreground web:outline-none"
                multiline
                numberOfLines={2}
                autoFocus
              />
            </View>
            <View>
              <Text className="text-xs font-medium text-muted-foreground mb-1">Description (optional)</Text>
              <TextInput
                value={description}
                onChangeText={setDescription}
                placeholder="Additional notes about this checkpoint"
                placeholderTextColor="#9ca3af"
                className="border border-border rounded-lg px-3 py-2.5 text-sm text-foreground web:outline-none"
                multiline
                numberOfLines={2}
              />
            </View>
          </View>

          <View className="px-5 pb-5 pt-2 flex-row justify-end gap-2">
            <Pressable onPress={handleClose} className="px-4 py-2 rounded-lg border border-border active:bg-muted">
              <Text className="text-sm font-medium text-foreground">Cancel</Text>
            </Pressable>
            <Pressable
              onPress={handleCreate}
              disabled={!canSubmit}
              className={cn('px-4 py-2 rounded-lg', canSubmit ? 'bg-primary active:opacity-80' : 'bg-muted')}
            >
              {isMutating ? (
                <ActivityIndicator size="small" color="white" />
              ) : (
                <Text className={cn('text-sm font-medium', canSubmit ? 'text-primary-foreground' : 'text-muted-foreground')}>
                  Create Checkpoint
                </Text>
              )}
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

export function RollbackConfirmModal({
  visible,
  checkpoint,
  onClose,
  onConfirm,
  isMutating,
}: {
  visible: boolean
  checkpoint: Checkpoint | null
  onClose: () => void
  onConfirm: () => void
  isMutating: boolean
}) {
  if (!checkpoint) return null

  const timeStr = new Date(checkpoint.createdAt).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable onPress={onClose} className="flex-1 bg-black/50 items-center justify-center px-6">
        <Pressable onPress={(e) => e.stopPropagation()} className="bg-background rounded-xl w-full max-w-sm shadow-xl overflow-hidden">
          <View className="flex-row items-center justify-between px-5 pt-5 pb-3">
            <View className="flex-row items-center gap-2">
              <AlertTriangle size={18} className="text-amber-500" />
              <Text className="text-base font-semibold text-foreground">Rollback to Checkpoint</Text>
            </View>
            <Pressable onPress={onClose} className="p-1 -mr-1 rounded-md active:bg-muted">
              <X size={18} className="text-muted-foreground" />
            </Pressable>
          </View>

          <View className="px-5 pb-4">
            <View className="bg-muted/50 rounded-lg p-3 mb-3">
              <Text className="text-sm font-medium text-foreground mb-0.5">
                {checkpoint.name || checkpoint.commitSha.substring(0, 7)}
              </Text>
              <Text className="text-xs text-muted-foreground">{timeStr}</Text>
              {checkpoint.commitMessage && (
                <Text className="text-xs text-muted-foreground mt-1" numberOfLines={2}>
                  {checkpoint.commitMessage}
                </Text>
              )}
            </View>
            <Text className="text-sm text-muted-foreground">
              This will restore your project files to this checkpoint. Your current state will be auto-saved first so you can always go forward again.
            </Text>
          </View>

          <View className="px-5 pb-5 flex-row justify-end gap-2">
            <Pressable onPress={onClose} className="px-4 py-2 rounded-lg border border-border active:bg-muted">
              <Text className="text-sm font-medium text-foreground">Cancel</Text>
            </Pressable>
            <Pressable
              onPress={onConfirm}
              disabled={isMutating}
              className={cn('px-4 py-2 rounded-lg', isMutating ? 'bg-muted' : 'bg-amber-600 active:opacity-80')}
            >
              {isMutating ? (
                <ActivityIndicator size="small" color="white" />
              ) : (
                <Text className="text-sm font-medium text-white">Rollback</Text>
              )}
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  )
}
