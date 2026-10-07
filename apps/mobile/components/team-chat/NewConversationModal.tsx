// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The "new message" / "create channel" dialog for wide screens. On phones the
 * same content is the full-screen `/c/new` route (see `NewConversationScreen`),
 * never a modal.
 */
import { Modal, Pressable, Text, View } from 'react-native'
import { X } from 'lucide-react-native'
import type { ConversationSummary, Mentionables } from '../../lib/team-chat-api'
import { NewChannelForm } from './NewChannelForm'
import { NewMessagePicker } from './NewMessagePicker'

/**
 * `message` lists people and agents together. `agent` is the same picker with
 * agents listed first, for entry points that are specifically "message an agent".
 */
export type NewConversationMode = 'channel' | 'message' | 'agent'

export interface NewConversationModalProps {
  workspaceId: string
  mode: NewConversationMode
  mentionables: Mentionables | null
  me: string | null
  onClose: () => void
  onCreated: (conversation: ConversationSummary) => void
}

export const NEW_CONVERSATION_TITLES: Record<NewConversationMode, string> = {
  channel: 'Create a channel',
  message: 'New message',
  agent: 'New message',
}

export function NewConversationModal({ workspaceId, mode, mentionables, me, onClose, onCreated }: NewConversationModalProps) {
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable className="flex-1 items-center justify-center bg-black/40 p-6" onPress={onClose}>
        <Pressable className="max-h-[80%] w-full max-w-md rounded-xl bg-card p-5" onPress={() => {}}>
          <View className="mb-4 flex-row items-center">
            <Text className="flex-1 text-base font-semibold text-foreground">{NEW_CONVERSATION_TITLES[mode]}</Text>
            <Pressable onPress={onClose} accessibilityLabel="Close">
              <X size={16} className="text-muted-foreground" />
            </Pressable>
          </View>

          {mode === 'channel' ? (
            <NewChannelForm workspaceId={workspaceId} autoFocus onCreated={onCreated} />
          ) : (
            <NewMessagePicker
              workspaceId={workspaceId}
              mentionables={mentionables}
              me={me}
              initialFilter={mode === 'agent' ? 'agents' : 'all'}
              autoFocus
              listClassName="max-h-80"
              onCreated={onCreated}
            />
          )}
        </Pressable>
      </Pressable>
    </Modal>
  )
}
