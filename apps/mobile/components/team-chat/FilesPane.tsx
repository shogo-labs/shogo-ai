// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Files shared in a conversation: search by name, filter by kind, open a
 * file, or jump to the message that shared it.
 */
import { useState } from 'react'
import { ActivityIndicator, FlatList, Image, Linking, Pressable, Text, TextInput, View } from 'react-native'
import { Download, MessageSquare, Paperclip, Search, X } from 'lucide-react-native'
import { SegmentedFilter } from '../phone/SegmentedFilter'
import { useConversationFiles } from '../../hooks/useConversationFiles'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'
import { formatFileSize } from '../../lib/composer-attachments'
import { absoluteApiUrl, type ConversationFile, type ConversationFileKind } from '../../lib/team-chat-api'
import { downloadAttachment } from '../../lib/attachment-download'
import { fileTypeMeta } from '../../lib/file-type'

type KindFilter = 'all' | ConversationFileKind

const KINDS = [
  { value: 'all', label: 'All' },
  { value: 'image', label: 'Images' },
  { value: 'document', label: 'Documents' },
  { value: 'other', label: 'Other' },
] as const

export interface FilesPaneProps {
  workspaceId: string
  conversationId: string
  title: string
  onClose: () => void
  onShowInChat: (file: ConversationFile) => void
}

export function FilesPane({ workspaceId, conversationId, title, onClose, onShowInChat }: FilesPaneProps) {
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<KindFilter>('all')
  const q = useDebouncedValue(query)
  const { files, loading, loadingMore, error, hasMore, loadMore } = useConversationFiles(workspaceId, conversationId, {
    q,
    kind: kind === 'all' ? undefined : kind,
  })
  const filtered = !!q.trim() || kind !== 'all'

  return (
    <View className="flex-1 bg-background" testID="files-pane">
      <View className="flex-row items-center gap-2 border-b border-border px-3 py-2">
        <Paperclip size={16} className="text-muted-foreground" />
        <Text className="min-w-0 flex-1 text-sm font-semibold text-foreground" numberOfLines={1}>
          Files in {title}
        </Text>
        <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close files" className="rounded-md p-1 active:bg-muted">
          <X size={16} className="text-muted-foreground" />
        </Pressable>
      </View>
      <View className="gap-2 border-b border-border px-3 py-2">
        <View className="flex-row items-center gap-2 rounded-md border border-border bg-card px-2">
          <Search size={14} className="text-muted-foreground" />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search files by name"
            placeholderTextColor="#9ca3af"
            className="min-w-0 flex-1 py-1.5 text-sm text-foreground"
            accessibilityLabel="Search files"
            testID="files-search"
          />
        </View>
        <SegmentedFilter options={KINDS} value={kind} onChange={setKind} equalWidth testID="files-kind" />
      </View>
      {error ? <Text className="px-3 py-2 text-xs text-destructive">{error}</Text> : null}
      <FlatList
        data={files}
        keyExtractor={(f) => f.id}
        renderItem={({ item }) => <FileRow file={item} onShowInChat={() => onShowInChat(item)} />}
        onEndReached={hasMore ? () => void loadMore() : undefined}
        onEndReachedThreshold={0.5}
        ListEmptyComponent={
          loading ? (
            <View className="items-center py-10"><ActivityIndicator /></View>
          ) : (
            <Text className="px-6 py-10 text-center text-sm text-muted-foreground">
              {filtered ? 'No files match.' : 'No files have been shared here yet.'}
            </Text>
          )
        }
        ListFooterComponent={loadingMore ? <View className="items-center py-3"><ActivityIndicator size="small" /></View> : null}
      />
    </View>
  )
}

function FileRow({ file, onShowInChat }: { file: ConversationFile; onShowInChat: () => void }) {
  const url = absoluteApiUrl(file.url)
  const meta = fileTypeMeta(file.name, file.mimeType)
  const date = new Date(file.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return (
    <View className="flex-row items-center gap-3 border-b border-border/60 px-3 py-2" testID={`file-row-${file.id}`}>
      <Pressable onPress={() => void Linking.openURL(url)} accessibilityRole="link" accessibilityLabel={`Open ${file.name}`} className="min-w-0 flex-1 flex-row items-center gap-3">
        {file.kind === 'image' ? (
          <Image source={{ uri: url }} className="rounded border border-border" style={{ width: 36, height: 36 }} resizeMode="cover" />
        ) : (
          <View className="items-center justify-center rounded" style={{ width: 36, height: 36, backgroundColor: meta.color }}>
            <Text className="text-[10px] font-bold text-white" numberOfLines={1}>{meta.glyph}</Text>
          </View>
        )}
        <View className="min-w-0 flex-1">
          <Text className="text-sm font-medium text-foreground" numberOfLines={1}>{file.name}</Text>
          <Text className="text-[11px] text-muted-foreground" numberOfLines={1}>
            {file.uploadedBy.name} · {date} · {formatFileSize(file.size)}
          </Text>
        </View>
      </Pressable>
      <Pressable onPress={() => void downloadAttachment(url, file.name)} accessibilityRole="button" accessibilityLabel={`Download ${file.name}`} className="rounded-md p-1.5 active:bg-muted">
        <Download size={15} className="text-muted-foreground" />
      </Pressable>
      <Pressable onPress={onShowInChat} accessibilityRole="button" accessibilityLabel={`Show ${file.name} in chat`} className="rounded-md p-1.5 active:bg-muted">
        <MessageSquare size={15} className="text-muted-foreground" />
      </Pressable>
    </View>
  )
}
