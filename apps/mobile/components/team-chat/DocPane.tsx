// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The channel doc: one shared markdown document per channel, shown beside
 * the timeline on wide screens and in its place on phones. Edited in place
 * with a rich text editor (chips for people, agents, channels, projects and
 * dates) that autosaves. Unrelated to project canvases.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useColorScheme } from 'nativewind'
import * as Clipboard from 'expo-clipboard'
import { Check, Copy, FileText, History, Lock, LockOpen, X } from 'lucide-react-native'
import { MarkdownText } from '../chat/MarkdownText'
import { useConversationDoc } from '../../hooks/useConversationDoc'
import { describeAuthor } from '../../lib/channel-doc-state'
import { normalizeDocMarkdown } from '../../lib/doc-lexical'
import { localTimeZone, parseDocToken } from '../../lib/doc-tokens'
import { privateMemberIds } from '../../lib/mention-menu'
import { teamChatApi, type ChannelDocRevision, type ConversationDetail, type Mentionables } from '../../lib/team-chat-api'
import { docLink } from '../../lib/team-chat-links'
import { mentionNames, renderMentionsMarkdown } from '../../lib/team-chat-state'
import { relativeTime } from '../../lib/activity-feed'
import DocEditor from './doc-editor/DocEditor'
import type { DocChipPress, DocEditorData, DocEditorHandle } from './doc-editor/types'
import { AgentProfileCard } from './AgentProfileCard'
import { DateChipCard } from './DateChipCard'
import { DatePickerModal } from './DatePickerModal'
import { PersonProfileCard } from './PersonProfileCard'

const api = teamChatApi()

export interface DocPaneProps {
  conversation: ConversationDetail
  workspaceId: string
  mentionables: Mentionables | null
  me?: string | null
  onClose: () => void
  /** Show a project beside the conversation (wide screens); otherwise projects open full screen. */
  onOpenProjectPane?: (projectId: string, name: string) => void
}

type DatePickerState = { mode: 'insert' } | { mode: 'edit'; nodeKey: string; value: string }

export function DocPane({ conversation, workspaceId, mentionables, me = null, onClose, onOpenProjectPane }: DocPaneProps) {
  const router = useRouter()
  const { colorScheme } = useColorScheme()
  const { state, doc, dirty, edit, flush, resolve, setLocked, restore } = useConversationDoc(workspaceId, conversation.id)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [chip, setChip] = useState<DocChipPress | null>(null)
  const [datePicker, setDatePicker] = useState<DatePickerState | null>(null)
  const editorRef = useRef<DocEditorHandle>(null)
  /** Normalised markdown the editor is showing, to tell remote changes from our own echoes. */
  const shown = useRef<string | null>(null)
  const serverContent = state.server?.content ?? ''
  const serverContentRef = useRef(serverContent)
  serverContentRef.current = serverContent
  const names = mentionNames(mentionables)
  const exists = !!state.server
  const canEdit = state.canEdit && !conversation.archivedAt
  const channelLabel = conversation.name ? `#${conversation.name}` : 'channel'

  const editorData = useMemo<DocEditorData>(
    () => ({
      people: mentionables?.people ?? [],
      agents: mentionables?.agents ?? [],
      channels: mentionables?.channels ?? [],
      projects: mentionables?.projects ?? [],
      statuses: mentionables?.statuses,
      meId: me,
      memberIds: privateMemberIds(conversation),
      membersOnly: conversation.kind === 'private',
      timeZone: localTimeZone(),
    }),
    [mentionables, me, conversation],
  )

  useEffect(() => () => void flush(), [flush])
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])

  // Someone else's save (or a restore, or "view theirs"): show it, unless it's what we already show.
  useEffect(() => {
    if (!state.loaded || state.draft) return
    const target = normalizeDocMarkdown(serverContent)
    if (shown.current === null || target === shown.current) {
      shown.current = target
      return
    }
    shown.current = target
    editorRef.current?.setMarkdown(serverContent)
  }, [state.loaded, state.draft, serverContent])

  const onEditorChange = useCallback(
    (markdown: string) => {
      shown.current = markdown
      const base = serverContentRef.current
      // Formatting-only differences from the saved doc aren't edits.
      edit({ content: markdown === normalizeDocMarkdown(base) ? base : markdown })
    },
    [edit],
  )

  const onChipPress = useCallback((press: DocChipPress) => {
    const ref = parseDocToken(press.token)
    if (!ref) return
    if (ref.kind === 'channel') {
      router.push({ pathname: '/(app)/c/[conversationId]', params: { conversationId: ref.id } } as any)
      return
    }
    if (ref.kind === 'project') {
      const project = mentionables?.projects?.find((p) => p.id === ref.id)
      if (onOpenProjectPane) onOpenProjectPane(ref.id, project?.name ?? 'Project')
      else router.push({ pathname: '/(app)/projects/[id]', params: { id: ref.id } } as any)
      return
    }
    setChip(press)
  }, [router, mentionables, onOpenProjectPane])

  const onPickDate = useCallback(
    (value: string) => {
      const picker = datePicker
      setDatePicker(null)
      const token = `<!date:${value}>`
      if (picker?.mode === 'edit') editorRef.current?.replaceToken(picker.nodeKey, token)
      else editorRef.current?.insertToken(token)
    },
    [datePicker],
  )

  const copyLink = () => void Clipboard.setStringAsync(docLink(conversation.id)).then(() => setCopied(true)).catch(() => {})
  const runAction = async (fn: () => Promise<unknown>) => {
    try {
      setActionError(null)
      await fn()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Something went wrong')
    }
  }

  const status = state.saving
    ? 'Saving…'
    : dirty
      ? 'Unsaved changes'
      : state.server?.updatedBy
        ? `Edited by ${describeAuthor(state.server.updatedBy)} · ${relativeTime(new Date(state.server.updatedAt).getTime()) || 'now'}`
        : null

  const chipRef = chip ? parseDocToken(chip.token) : null
  const chipPerson = chipRef?.kind === 'user' ? mentionables?.people.find((p) => p.id === chipRef.id) : undefined
  const chipAgent = chipRef?.kind === 'agent' ? mentionables?.agents.find((a) => a.projectId === chipRef.projectId) : undefined

  return (
    <View className="flex-1 bg-background" testID="channel-doc-pane">
      <View className="flex-row items-center gap-2 border-b border-border px-4 py-2.5">
        <FileText size={16} className="text-muted-foreground" />
        <View className="min-w-0 flex-1">
          {canEdit ? (
            <TextInput
              value={doc.title}
              onChangeText={(title) => edit({ title })}
              placeholder={`${channelLabel} doc`}
              placeholderTextColor="#8a8a8a"
              accessibilityLabel="Doc title"
              maxLength={200}
              className="text-base font-semibold text-foreground"
            />
          ) : (
            <Text className="text-base font-semibold text-foreground" numberOfLines={1}>
              {doc.title || `${channelLabel} doc`}
            </Text>
          )}
          {status ? (
            <Text className="text-[11px] text-muted-foreground" numberOfLines={1} testID="doc-status">
              {status}
            </Text>
          ) : null}
        </View>
        {state.server?.locked ? (
          <View className="flex-row items-center gap-1 rounded bg-muted px-1.5 py-0.5">
            <Lock size={10} className="text-muted-foreground" />
            <Text className="text-[10px] font-medium uppercase text-muted-foreground">Locked</Text>
          </View>
        ) : null}
        {exists ? (
          <PaneButton label="Version history" onPress={() => setHistoryOpen(true)}>
            <History size={16} className="text-muted-foreground" />
          </PaneButton>
        ) : null}
        {exists && state.canManage ? (
          <PaneButton
            label={state.server?.locked ? 'Unlock doc' : 'Lock doc'}
            onPress={() => void runAction(() => setLocked(!state.server?.locked))}
          >
            {state.server?.locked ? <LockOpen size={16} className="text-muted-foreground" /> : <Lock size={16} className="text-muted-foreground" />}
          </PaneButton>
        ) : null}
        {exists ? (
          <PaneButton label={copied ? 'Link copied' : 'Copy link'} onPress={copyLink}>
            {copied ? <Check size={16} className="text-primary" /> : <Copy size={16} className="text-muted-foreground" />}
          </PaneButton>
        ) : null}
        <PaneButton label="Close doc" onPress={onClose}>
          <X size={16} className="text-muted-foreground" />
        </PaneButton>
      </View>

      {state.conflict ? (
        <View className="gap-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2.5" testID="doc-conflict">
          <Text className="text-sm text-foreground">
            This doc was updated by {describeAuthor(state.conflict.theirs?.updatedBy)} while you were editing.
          </Text>
          <View className="flex-row flex-wrap gap-2">
            <BannerButton label="View theirs" onPress={() => resolve('theirs')} />
            <BannerButton label="Overwrite with mine" onPress={() => resolve('overwrite')} />
            <BannerButton
              label="Copy mine"
              onPress={() => {
                void Clipboard.setStringAsync(doc.content).catch(() => {})
                resolve('theirs')
              }}
            />
          </View>
        </View>
      ) : null}
      {state.error || actionError ? (
        <Text className="border-b border-border px-4 py-1.5 text-xs text-destructive">{actionError ?? state.error}</Text>
      ) : null}

      {!state.loaded ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator />
        </View>
      ) : !exists && !canEdit ? (
        <View className="flex-1 items-center justify-center gap-3 px-8">
          <FileText size={28} className="text-muted-foreground" />
          <Text className="text-center text-base font-semibold text-foreground">No doc yet</Text>
          <Text className="text-center text-sm text-muted-foreground">
            Keep the channel's plans, decisions, and checklists in one place everyone (and every agent) can read.
          </Text>
        </View>
      ) : (
        <View className="min-h-0 flex-1">
          <DocEditor
            ref={editorRef}
            markdown={doc.content}
            editable={canEdit}
            workspaceId={workspaceId}
            data={editorData}
            dark={colorScheme === 'dark'}
            onChange={onEditorChange}
            onChipPress={onChipPress}
            onRequestDatePicker={() => setDatePicker({ mode: 'insert' })}
            dom={{ useExpoDOMWebView: false, style: { flex: 1, backgroundColor: 'transparent' }, keyboardDisplayRequiresUserAction: false }}
          />
        </View>
      )}

      {historyOpen ? (
        <HistoryModal
          conversationId={conversation.id}
          canRestore={canEdit}
          names={names}
          onClose={() => setHistoryOpen(false)}
          onRestore={(id) =>
            runAction(async () => {
              await restore(id)
              setHistoryOpen(false)
            })
          }
        />
      ) : null}

      {chip && chipRef?.kind === 'date' ? (
        <DateChipCard
          workspaceId={workspaceId}
          conversationId={conversation.id}
          value={chipRef.value}
          context={doc.title || `${channelLabel} doc`}
          editable={chip.editable}
          onClose={() => setChip(null)}
          onEdit={() => {
            setDatePicker({ mode: 'edit', nodeKey: chip.nodeKey, value: chipRef.value })
            setChip(null)
          }}
          onRemove={() => {
            editorRef.current?.replaceToken(chip.nodeKey, null)
            setChip(null)
          }}
        />
      ) : null}
      {chip && chipPerson ? (
        <PersonProfileCard
          workspaceId={workspaceId}
          person={chipPerson}
          status={mentionables?.statuses?.[chipPerson.id]}
          me={me}
          onClose={() => setChip(null)}
        />
      ) : null}
      {chip && chipRef?.kind === 'agent' ? (
        <AgentProfileCard
          workspaceId={workspaceId}
          projectId={chipRef.projectId}
          name={chipAgent?.name ?? 'Agent'}
          iconUrl={chipAgent?.image}
          onClose={() => setChip(null)}
          onOpenChannel={(id) => router.push({ pathname: '/(app)/c/[conversationId]', params: { conversationId: id } } as any)}
          onOpenProjectPane={onOpenProjectPane}
        />
      ) : null}
      <DatePickerModal
        visible={!!datePicker}
        initial={datePicker?.mode === 'edit' ? datePicker.value : null}
        title={datePicker?.mode === 'edit' ? 'Change date' : 'Insert a date'}
        onCancel={() => setDatePicker(null)}
        onPick={onPickDate}
      />
    </View>
  )
}

function HistoryModal({
  conversationId,
  canRestore,
  names,
  onClose,
  onRestore,
}: {
  conversationId: string
  canRestore: boolean
  names: ReturnType<typeof mentionNames>
  onClose: () => void
  onRestore: (revisionId: string) => void
}) {
  const [revisions, setRevisions] = useState<ChannelDocRevision[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<ChannelDocRevision | null>(null)

  useEffect(() => {
    api.listDocRevisions(conversationId).then(setRevisions).catch((err) => setError(err?.message ?? 'Could not load history'))
  }, [conversationId])

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable className="flex-1 items-center justify-center bg-black/40 p-6" onPress={onClose}>
        <Pressable className="max-h-[85%] w-full max-w-2xl rounded-xl bg-card p-5" onPress={() => {}}>
          <View className="mb-3 flex-row items-center gap-2">
            <History size={16} className="text-muted-foreground" />
            <Text className="flex-1 text-base font-semibold text-foreground">{selected ? `Version ${selected.version}` : 'Version history'}</Text>
            {selected ? (
              <Pressable onPress={() => setSelected(null)} className="rounded-md px-2 py-1 active:bg-muted hover:bg-muted">
                <Text className="text-xs text-muted-foreground">All versions</Text>
              </Pressable>
            ) : null}
            <Pressable onPress={onClose} accessibilityLabel="Close">
              <X size={16} className="text-muted-foreground" />
            </Pressable>
          </View>
          {error ? <Text className="text-sm text-destructive">{error}</Text> : null}
          {!revisions && !error ? <ActivityIndicator /> : null}
          {selected ? (
            <>
              <ScrollView className="max-h-[60vh] rounded-md border border-border p-3">
                <MarkdownText>{selected.content ? renderMentionsMarkdown(selected.content, names) : '_Empty_'}</MarkdownText>
              </ScrollView>
              {canRestore ? (
                <View className="mt-3 flex-row justify-end">
                  <Pressable
                    onPress={() => onRestore(selected.id)}
                    accessibilityRole="button"
                    accessibilityLabel="Restore this version"
                    className="rounded-md bg-primary px-3 py-1.5"
                  >
                    <Text className="text-sm font-medium text-primary-foreground">Restore this version</Text>
                  </Pressable>
                </View>
              ) : null}
            </>
          ) : (
            <ScrollView>
              {revisions?.map((r, i) => (
                <Pressable
                  key={r.id}
                  onPress={() => setSelected(r)}
                  accessibilityRole="button"
                  accessibilityLabel={`Version ${r.version}`}
                  className="flex-row items-center gap-2 rounded-md px-2 py-2 active:bg-muted hover:bg-muted"
                >
                  <Text className="flex-1 text-sm text-foreground" numberOfLines={1}>
                    {describeAuthor(r.updatedBy)}
                    {i === 0 ? <Text className="text-xs text-muted-foreground">{'  current'}</Text> : null}
                  </Text>
                  <Text className="text-xs text-muted-foreground">{new Date(r.updatedAt).toLocaleString()}</Text>
                </Pressable>
              ))}
              {revisions && !revisions.length ? <Text className="text-sm text-muted-foreground">No history yet.</Text> : null}
            </ScrollView>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  )
}

function PaneButton({ label, onPress, children }: { label: string; onPress: () => void; children: React.ReactNode }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} className="rounded-md p-1.5 active:bg-muted hover:bg-muted">
      {children}
    </Pressable>
  )
}

function BannerButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} className="rounded-md border border-border bg-background px-2.5 py-1 active:bg-muted hover:bg-muted">
      <Text className="text-xs font-medium text-foreground">{label}</Text>
    </Pressable>
  )
}
