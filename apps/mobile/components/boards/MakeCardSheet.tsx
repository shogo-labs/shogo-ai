// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * "Make a card" from a message: pick a board (this channel's first, then the
 * rest of the workspace) and the message becomes a card linked back to it.
 */
import { useEffect, useState } from 'react'
import { ActivityIndicator, Modal, Pressable, Text, View } from 'react-native'
import type { ChatMessage } from '../../lib/team-chat-api'
import { ITEM_TYPE_LABELS, workBoardsApi, type Board, type WorkItem } from '../../lib/work-boards-api'
import { OptionSheet } from './OptionSheet'

const api = workBoardsApi()

export function MakeCardSheet({ workspaceId, conversationId, message, onCreated, onError, onClose }: {
  workspaceId: string
  conversationId: string
  message: ChatMessage
  onCreated: (item: WorkItem) => void
  onError: (message: string) => void
  onClose: () => void
}) {
  const [boards, setBoards] = useState<Board[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    api.list(workspaceId)
      .then((all) => {
        if (!live) return
        const here = all.filter((b) => b.conversationId === conversationId)
        setBoards([...here, ...all.filter((b) => b.conversationId !== conversationId)])
      })
      .catch((err: Error) => live && setError(err.message))
    return () => {
      live = false
    }
  }, [workspaceId, conversationId])

  if (error || !boards || !boards.length) {
    return (
      <Modal visible transparent animationType="fade" onRequestClose={onClose}>
        <Pressable className="flex-1 items-center justify-center bg-black/40 p-6" onPress={onClose}>
          <View className="w-full max-w-sm items-center gap-3 rounded-xl bg-card p-5">
            {!boards && !error ? (
              <ActivityIndicator />
            ) : (
              <Text className="text-center text-sm text-muted-foreground">
                {error ?? 'There are no boards yet. Add one from a channel\u2019s tabs, or ask the workspace agent to set one up.'}
              </Text>
            )}
          </View>
        </Pressable>
      </Modal>
    )
  }

  return (
    <OptionSheet
      title="Make a card on"
      searchable={boards.length > 6}
      options={boards.map((b) => ({
        id: b.id,
        label: b.name,
        hint: b.conversationId === conversationId ? `This channel · ${ITEM_TYPE_LABELS[b.itemType]}` : b.channelName ? `#${b.channelName}` : ITEM_TYPE_LABELS[b.itemType],
      }))}
      onSelect={(boardId) => {
        api.cardFromMessage(message.id, { boardId })
          .then(onCreated)
          .catch((err: unknown) => onError(err instanceof Error ? err.message : 'Could not make a card'))
      }}
      onClose={onClose}
    />
  )
}
