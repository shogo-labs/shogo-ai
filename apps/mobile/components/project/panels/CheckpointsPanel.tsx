// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useCallback, useMemo } from 'react'
import {
  View,
  Text,
  Pressable,
  ScrollView,
  TextInput,
  ActivityIndicator,
  Modal,
  Platform,
} from 'react-native'
import { cn } from '@shogo/shared-ui/primitives'
import {
  useCheckpoints,
  type Checkpoint,
  type CheckpointDiff,
} from '@shogo/shared-app/hooks'
import {
  BookmarkPlus,
  RotateCcw,
  GitCommit,
  FileCode,
  ChevronDown,
  ChevronRight,
  X,
  Clock,
  Zap,
  Database,
  AlertTriangle,
} from 'lucide-react-native'
import { API_URL } from '../../../lib/api'
import { authClient } from '../../../lib/auth-client'

interface CheckpointsPanelProps {
  projectId: string
  visible: boolean
}

function useNativeHeaders() {
  return useMemo(() => {
    if (Platform.OS === 'web') return undefined
    return (): Record<string, string> => {
      const cookie = (authClient as any).getCookie()
      return cookie ? { Cookie: cookie } : {}
    }
  }, [])
}

export function CheckpointsPanel({ projectId, visible }: CheckpointsPanelProps) {
  const nativeHeaders = useNativeHeaders()

  const {
    checkpoints,
    isLoading,
    isMutating,
    error,
    createCheckpoint,
    rollback,
    getDiff,
    refetch,
  } = useCheckpoints(projectId, {
    baseUrl: API_URL,
    credentials: Platform.OS === 'web' ? 'include' : undefined,
    headers: nativeHeaders,
  })

  const [showCreateModal, setShowCreateModal] = useState(false)
  const [showRollbackConfirm, setShowRollbackConfirm] = useState<string | null>(null)
  const [expandedDiff, setExpandedDiff] = useState<string | null>(null)
  const [diffData, setDiffData] = useState<Record<string, CheckpointDiff | null>>({})
  const [diffLoading, setDiffLoading] = useState<string | null>(null)

  const handleToggleDiff = useCallback(async (checkpointId: string) => {
    if (expandedDiff === checkpointId) {
      setExpandedDiff(null)
      return
    }
    setExpandedDiff(checkpointId)
    if (!diffData[checkpointId]) {
      setDiffLoading(checkpointId)
      const diff = await getDiff(checkpointId)
      setDiffData(prev => ({ ...prev, [checkpointId]: diff }))
      setDiffLoading(null)
    }
  }, [expandedDiff, diffData, getDiff])

  const handleRollback = useCallback(async (checkpointId: string) => {
    setShowRollbackConfirm(null)
    const success = await rollback(checkpointId)
    if (success) {
      refetch()
    }
  }, [rollback, refetch])

  if (!visible) return null

  return (
    <View className="absolute inset-0 flex-col bg-background" style={{ display: visible ? 'flex' : 'none' }}>
      {/* Header */}
      <View className="px-4 py-3 border-b border-border flex-row items-center justify-between">
        <View className="flex-row items-center gap-2">
          <GitCommit size={16} className="text-muted-foreground" />
          <Text className="text-sm font-semibold text-foreground">Checkpoints</Text>
          {checkpoints.length > 0 && (
            <View className="bg-muted rounded-full px-1.5 py-0.5">
              <Text className="text-[10px] font-medium text-muted-foreground">{checkpoints.length}</Text>
            </View>
          )}
        </View>
        <Pressable
          onPress={() => setShowCreateModal(true)}
          disabled={isMutating}
          className={cn(
            'flex-row items-center gap-1.5 rounded-lg px-3 py-1.5',
            isMutating ? 'bg-muted' : 'bg-primary active:opacity-80',
          )}
        >
          <BookmarkPlus size={14} className={isMutating ? 'text-muted-foreground' : 'text-primary-foreground'} />
          <Text className={cn('text-xs font-medium', isMutating ? 'text-muted-foreground' : 'text-primary-foreground')}>
            Create
          </Text>
        </Pressable>
      </View>

      {/* Content */}
      {isLoading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" />
          <Text className="text-muted-foreground text-sm mt-3">Loading checkpoints...</Text>
        </View>
      ) : error ? (
        <View className="flex-1 items-center justify-center px-6">
          <AlertTriangle size={24} className="text-destructive mb-2" />
          <Text className="text-sm text-destructive text-center">{error.message}</Text>
          <Pressable onPress={refetch} className="mt-3 px-4 py-2 rounded-lg border border-border active:bg-muted">
            <Text className="text-sm font-medium text-foreground">Retry</Text>
          </Pressable>
        </View>
      ) : checkpoints.length === 0 ? (
        <View className="flex-1 items-center justify-center px-6">
          <GitCommit size={32} className="text-muted-foreground mb-3" />
          <Text className="text-base font-semibold text-foreground mb-1">No checkpoints yet</Text>
          <Text className="text-sm text-muted-foreground text-center mb-4">
            Checkpoints are snapshots of your project. Create one before making major changes so you can always go back.
          </Text>
          <Pressable
            onPress={() => setShowCreateModal(true)}
            className="flex-row items-center gap-2 rounded-lg bg-primary px-4 py-2.5 active:opacity-80"
          >
            <BookmarkPlus size={16} className="text-primary-foreground" />
            <Text className="text-sm font-medium text-primary-foreground">Create First Checkpoint</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView className="flex-1" contentContainerClassName="pb-4">
          {isMutating && (
            <View className="mx-4 mt-3 flex-row items-center gap-2 bg-primary/10 rounded-lg px-3 py-2">
              <ActivityIndicator size="small" />
              <Text className="text-xs text-primary">Processing...</Text>
            </View>
          )}
          {checkpoints.map((cp, idx) => (
            <CheckpointRow
              key={cp.id}
              checkpoint={cp}
              isFirst={idx === 0}
              isLast={idx === checkpoints.length - 1}
              isExpanded={expandedDiff === cp.id}
              diff={diffData[cp.id] ?? null}
              isDiffLoading={diffLoading === cp.id}
              isMutating={isMutating}
              onToggleDiff={() => handleToggleDiff(cp.id)}
              onRollback={() => setShowRollbackConfirm(cp.id)}
            />
          ))}
        </ScrollView>
      )}

      {/* Create Checkpoint Modal */}
      <CreateCheckpointModal
        visible={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreate={async (opts) => {
          setShowCreateModal(false)
          await createCheckpoint(opts)
          refetch()
        }}
        isMutating={isMutating}
      />

      {/* Rollback Confirmation Modal */}
      <RollbackConfirmModal
        visible={showRollbackConfirm !== null}
        checkpoint={checkpoints.find(c => c.id === showRollbackConfirm) ?? null}
        onClose={() => setShowRollbackConfirm(null)}
        onConfirm={() => showRollbackConfirm && handleRollback(showRollbackConfirm)}
        isMutating={isMutating}
      />
    </View>
  )
}

function CheckpointRow({
  checkpoint,
  isFirst,
  isLast,
  isExpanded,
  diff,
  isDiffLoading,
  isMutating,
  onToggleDiff,
  onRollback,
}: {
  checkpoint: Checkpoint
  isFirst: boolean
  isLast: boolean
  isExpanded: boolean
  diff: CheckpointDiff | null
  isDiffLoading: boolean
  isMutating: boolean
  onToggleDiff: () => void
  onRollback: () => void
}) {
  const createdAt = new Date(checkpoint.createdAt)
  const timeStr = createdAt.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

  return (
    <View className="mx-4 mt-3">
      <View className={cn('border border-border rounded-lg overflow-hidden', isFirst && 'border-primary/30')}>
        {/* Main row */}
        <View className="px-3 py-3">
          <View className="flex-row items-start gap-3">
            {/* Timeline dot */}
            <View className="items-center pt-0.5">
              <View className={cn('w-2.5 h-2.5 rounded-full', isFirst ? 'bg-primary' : 'bg-muted-foreground/30')} />
            </View>

            {/* Content */}
            <View className="flex-1 min-w-0">
              <View className="flex-row items-center gap-2 mb-0.5">
                {checkpoint.name && (
                  <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
                    {checkpoint.name}
                  </Text>
                )}
                {checkpoint.isAutomatic && (
                  <View className="flex-row items-center gap-0.5 bg-muted rounded px-1 py-0.5">
                    <Zap size={9} className="text-muted-foreground" />
                    <Text className="text-[9px] text-muted-foreground">Auto</Text>
                  </View>
                )}
                {checkpoint.includesDb && (
                  <View className="flex-row items-center gap-0.5 bg-muted rounded px-1 py-0.5">
                    <Database size={9} className="text-muted-foreground" />
                    <Text className="text-[9px] text-muted-foreground">DB</Text>
                  </View>
                )}
              </View>
              <Text className="text-xs text-muted-foreground mb-1" numberOfLines={2}>
                {checkpoint.commitMessage}
              </Text>
              <View className="flex-row items-center gap-3">
                <View className="flex-row items-center gap-1">
                  <Clock size={10} className="text-muted-foreground" />
                  <Text className="text-[10px] text-muted-foreground">{timeStr}</Text>
                </View>
                <Text className="text-[10px] text-muted-foreground">
                  {checkpoint.filesChanged} file{checkpoint.filesChanged !== 1 ? 's' : ''}
                </Text>
                {(checkpoint.additions > 0 || checkpoint.deletions > 0) && (
                  <View className="flex-row items-center gap-1.5">
                    {checkpoint.additions > 0 && (
                      <Text className="text-[10px] text-emerald-600">+{checkpoint.additions}</Text>
                    )}
                    {checkpoint.deletions > 0 && (
                      <Text className="text-[10px] text-red-500">-{checkpoint.deletions}</Text>
                    )}
                  </View>
                )}
                <Text className="text-[10px] font-mono text-muted-foreground">
                  {checkpoint.commitSha.substring(0, 7)}
                </Text>
              </View>
            </View>
          </View>

          {/* Actions */}
          <View className="flex-row items-center gap-2 mt-2 ml-5">
            <Pressable
              onPress={onToggleDiff}
              className="flex-row items-center gap-1 px-2 py-1 rounded-md border border-border active:bg-muted"
            >
              {isExpanded ? (
                <ChevronDown size={12} className="text-muted-foreground" />
              ) : (
                <ChevronRight size={12} className="text-muted-foreground" />
              )}
              <FileCode size={12} className="text-muted-foreground" />
              <Text className="text-[10px] font-medium text-muted-foreground">Diff</Text>
            </Pressable>
            {!isFirst && (
              <Pressable
                onPress={onRollback}
                disabled={isMutating}
                className={cn(
                  'flex-row items-center gap-1 px-2 py-1 rounded-md border active:bg-muted',
                  isMutating ? 'border-border opacity-50' : 'border-amber-500/30',
                )}
              >
                <RotateCcw size={12} className="text-amber-600" />
                <Text className="text-[10px] font-medium text-amber-600">Rollback</Text>
              </Pressable>
            )}
          </View>
        </View>

        {/* Diff section */}
        {isExpanded && (
          <View className="border-t border-border bg-muted/30 px-3 py-2">
            {isDiffLoading ? (
              <View className="py-4 items-center">
                <ActivityIndicator size="small" />
                <Text className="text-xs text-muted-foreground mt-1">Loading diff...</Text>
              </View>
            ) : diff && diff.files?.length > 0 ? (
              <View className="gap-1">
                {diff.files.map((file, i) => (
                  <View key={i} className="flex-row items-center gap-2 py-1">
                    <View className={cn(
                      'w-1.5 h-1.5 rounded-full',
                      file.status === 'added' ? 'bg-emerald-500' :
                      file.status === 'deleted' ? 'bg-red-500' : 'bg-amber-500',
                    )} />
                    <Text className="text-xs text-foreground flex-1 font-mono" numberOfLines={1}>
                      {file.path}
                    </Text>
                    <View className="flex-row items-center gap-1">
                      {file.additions > 0 && (
                        <Text className="text-[10px] text-emerald-600">+{file.additions}</Text>
                      )}
                      {file.deletions > 0 && (
                        <Text className="text-[10px] text-red-500">-{file.deletions}</Text>
                      )}
                    </View>
                  </View>
                ))}
              </View>
            ) : (
              <Text className="text-xs text-muted-foreground text-center py-2">No changes in this checkpoint</Text>
            )}
          </View>
        )}
      </View>
    </View>
  )
}

function CreateCheckpointModal({
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

function RollbackConfirmModal({
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
