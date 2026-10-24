// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The channel doc: one shared markdown document per channel, shown beside
 * the timeline on wide screens and in its place on phones. View mode renders
 * markdown with tappable task items; edit mode is a markdown editor with a
 * formatting toolbar that autosaves. Unrelated to project canvases.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { useRouter } from 'expo-router'
import {
  Archive,
  ArchiveRestore,
  AtSign,
  Bold,
  Check,
  Code,
  Copy,
  FileText,
  Heading1,
  Heading2,
  Heading3,
  History,
  Italic,
  Link2,
  List,
  ListOrdered,
  ListTodo,
  Lock,
  LockOpen,
  Pencil,
  Quote,
  SeparatorHorizontal,
  Square,
  SquareCheck,
  Strikethrough,
  Table2,
  X,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { MarkdownText } from '../chat/MarkdownText'
import type { MentionTarget } from '../chat/file-links'
import { useConversationDoc } from '../../hooks/useConversationDoc'
import { describeAuthor, docBudgetFor, docSections, formatDocBudget } from '../../lib/channel-doc-state'
import { applyFormat, insertAt, splitTaskSegments, toggleTask, type DocFormat, type Selection } from '../../lib/doc-markdown'
import {
  teamChatApi,
  type ChannelDocArchive,
  type ChannelDocRevision,
  type ConversationDetail,
  type Mentionables,
} from '../../lib/team-chat-api'
import { docLink } from '../../lib/team-chat-links'
import { mentionNames, renderMentionsMarkdown } from '../../lib/team-chat-state'
import { relativeTime } from '../../lib/activity-feed'

const api = teamChatApi()

export interface DocPaneProps {
  conversation: ConversationDetail
  workspaceId: string
  mentionables: Mentionables | null
  onClose: () => void
  /** Opens a person's profile. Absent hosts leave mentions as plain highlights. */
  onOpenProfile?: (userId: string) => void
}

const TOOLBAR: Array<{ format: DocFormat; label: string; Icon: typeof Bold }> = [
  { format: 'h1', label: 'Heading', Icon: Heading1 },
  { format: 'h2', label: 'Subheading', Icon: Heading2 },
  { format: 'h3', label: 'Minor heading', Icon: Heading3 },
  { format: 'bold', label: 'Bold', Icon: Bold },
  { format: 'italic', label: 'Italic', Icon: Italic },
  { format: 'strike', label: 'Strikethrough', Icon: Strikethrough },
  { format: 'bullet', label: 'Bulleted list', Icon: List },
  { format: 'numbered', label: 'Numbered list', Icon: ListOrdered },
  { format: 'task', label: 'Checklist', Icon: ListTodo },
  { format: 'quote', label: 'Quote', Icon: Quote },
  { format: 'code', label: 'Code', Icon: Code },
  { format: 'table', label: 'Table', Icon: Table2 },
  { format: 'divider', label: 'Divider', Icon: SeparatorHorizontal },
  { format: 'link', label: 'Link', Icon: Link2 },
]

export function DocPane({ conversation, workspaceId, mentionables, onClose, onOpenProfile }: DocPaneProps) {
  const router = useRouter()
  const { state, doc, dirty, edit, flush, resolve, setLocked, restore, archiveSection, restoreArchive } =
    useConversationDoc(workspaceId, conversation.id)
  const [editing, setEditing] = useState(false)
  const [selection, setSelection] = useState<Selection>({ start: 0, end: 0 })
  const [historyOpen, setHistoryOpen] = useState(false)
  const [archivePickerOpen, setArchivePickerOpen] = useState(false)
  const [archivesOpen, setArchivesOpen] = useState(false)
  const [mentionOpen, setMentionOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const pendingSelection = useRef<Selection | null>(null)
  const names = mentionNames(mentionables)
  /**
   * What tapping an @-mention in the doc does — identical to the timeline: a
   * person opens their profile through the host, an agent opens its own profile
   * page. A host that offers no profile leaves mentions as plain highlights.
   */
  const mentionPress = useMemo(() => {
    if (!onOpenProfile) return undefined
    return (target: MentionTarget) => {
      if (target.kind === 'u') return onOpenProfile(target.id)
      if (target.kind === 'a') {
        router.push({ pathname: '/(app)/agents/[key]', params: { key: target.id } } as any)
      }
    }
  }, [onOpenProfile, router])
  const exists = !!state.server
  const canEdit = state.canEdit && !conversation.archivedAt
  const budget = docBudgetFor(doc.content)

  useEffect(() => () => void flush(), [flush])
  useEffect(() => {
    if (!canEdit && editing) setEditing(false)
  }, [canEdit, editing])
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])

  const format = (f: DocFormat) => {
    const result = applyFormat(doc.content, selection, f)
    pendingSelection.current = result.selection
    setSelection(result.selection)
    edit({ content: result.text })
  }
  const insertMention = (key: string) => {
    const result = insertAt(doc.content, selection, `<@${key}> `)
    pendingSelection.current = result.selection
    setSelection(result.selection)
    edit({ content: result.text })
    setMentionOpen(false)
  }
  const toggle = (line: number) => {
    if (!canEdit) return
    edit({ content: toggleTask(doc.content, line) })
  }
  const done = () => {
    setEditing(false)
    void flush()
  }
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

  return (
    <View className="flex-1 bg-background" testID="channel-doc-pane">
      <View className="flex-row items-center gap-2 border-b border-border px-4 py-2.5">
        <FileText size={16} className="text-muted-foreground" />
        <View className="min-w-0 flex-1">
          {editing ? (
            <TextInput
              value={doc.title}
              onChangeText={(title) => edit({ title })}
              placeholder="Untitled doc"
              placeholderTextColor="#8a8a8a"
              accessibilityLabel="Doc title"
              maxLength={200}
              className="text-base font-semibold text-foreground"
            />
          ) : (
            <Text className="text-base font-semibold text-foreground" numberOfLines={1}>
              {doc.title || `#${conversation.name ?? 'channel'} doc`}
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
        {canEdit && (exists || editing) ? (
          editing ? (
            <PaneButton label="Done editing" onPress={done}>
              <Check size={16} className="text-primary" />
            </PaneButton>
          ) : (
            <PaneButton label="Edit doc" onPress={() => setEditing(true)}>
              <Pencil size={16} className="text-muted-foreground" />
            </PaneButton>
          )
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
                const mine = doc.content
                void Clipboard.setStringAsync(mine).catch(() => {})
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
      ) : editing ? (
        <View className="flex-1">
          <ScrollView horizontal showsHorizontalScrollIndicator={false} className="max-h-11 grow-0 border-b border-border" contentContainerClassName="items-center gap-0.5 px-2 py-1">
            {TOOLBAR.map(({ format: f, label, Icon }) => (
              <PaneButton key={f} label={label} onPress={() => format(f)}>
                <Icon size={16} className="text-muted-foreground" />
              </PaneButton>
            ))}
            <PaneButton label="Mention" onPress={() => setMentionOpen(true)}>
              <AtSign size={16} className="text-muted-foreground" />
            </PaneButton>
          </ScrollView>
          <TextInput
            value={doc.content}
            onChangeText={(content) => edit({ content })}
            selection={pendingSelection.current ?? undefined}
            onSelectionChange={(e) => {
              pendingSelection.current = null
              setSelection(e.nativeEvent.selection)
            }}
            multiline
            autoFocus
            textAlignVertical="top"
            placeholder={'Write notes, decisions, checklists…\n\nMarkdown works: # headings, **bold**, - [ ] tasks'}
            placeholderTextColor="#8a8a8a"
            accessibilityLabel="Doc content"
            className="flex-1 px-4 py-3 font-mono text-sm leading-6 text-foreground"
          />
        </View>
      ) : !exists && !doc.content ? (
        <View className="flex-1 items-center justify-center gap-3 px-8">
          <FileText size={28} className="text-muted-foreground" />
          <Text className="text-center text-base font-semibold text-foreground">No doc yet</Text>
          <Text className="text-center text-sm text-muted-foreground">
            Keep the channel's plans, decisions, and checklists in one place everyone (and every agent) can read.
          </Text>
          {canEdit ? (
            <Pressable onPress={() => setEditing(true)} accessibilityRole="button" accessibilityLabel="Create doc" className="rounded-md bg-primary px-3 py-1.5">
              <Text className="text-sm font-medium text-primary-foreground">Create doc</Text>
            </Pressable>
          ) : null}
        </View>
      ) : (
        <ScrollView className="flex-1" contentContainerClassName="px-4 py-3">
          <DocView
            content={doc.content}
            names={names}
            canToggle={canEdit}
            onToggle={toggle}
            onMentionPress={mentionPress}
          />
        </ScrollView>
      )}

      {exists ? (
        <View className="flex-row items-center gap-2 border-t border-border px-4 py-1.5" testID="doc-budget">
          <View className="h-1 w-14 overflow-hidden rounded-full bg-muted">
            <View
              className={cn(
                'h-1 rounded-full',
                budget.level === 'critical' ? 'bg-destructive' : budget.level === 'warn' ? 'bg-amber-500' : 'bg-primary',
              )}
              style={{ width: `${Math.min(100, Math.max(1, Math.round(budget.pct)))}%` }}
            />
          </View>
          <Text
            testID="doc-budget-text"
            className={cn(
              'text-[11px]',
              budget.level === 'critical' ? 'text-destructive' : budget.level === 'warn' ? 'text-amber-600' : 'text-muted-foreground',
            )}
          >
            {formatDocBudget(budget)}
          </Text>
          <View className="min-w-0 flex-1" />
          {canEdit ? (
            <PaneButton label="Archive a section" onPress={() => setArchivePickerOpen(true)}>
              <Archive size={14} className="text-muted-foreground" />
            </PaneButton>
          ) : null}
          <PaneButton label="Archived sections" onPress={() => setArchivesOpen(true)}>
            <ArchiveRestore size={14} className="text-muted-foreground" />
          </PaneButton>
        </View>
      ) : null}

      {historyOpen ? (
        <HistoryModal
          conversationId={conversation.id}
          canRestore={canEdit}
          onClose={() => setHistoryOpen(false)}
          onRestore={(id) =>
            runAction(async () => {
              await restore(id)
              setHistoryOpen(false)
              setEditing(false)
            })
          }
        />
      ) : null}
      {mentionOpen ? <MentionModal mentionables={mentionables} onPick={insertMention} onClose={() => setMentionOpen(false)} /> : null}
      {archivePickerOpen ? (
        <ArchiveSectionModal
          sections={docSections(doc.content)}
          onArchive={(heading) =>
            runAction(async () => {
              await archiveSection(heading)
              setArchivePickerOpen(false)
              setEditing(false)
            })
          }
          onClose={() => setArchivePickerOpen(false)}
        />
      ) : null}
      {archivesOpen ? (
        <ArchivesModal
          conversationId={conversation.id}
          canRestore={canEdit}
          onClose={() => setArchivesOpen(false)}
          onRestore={(id) =>
            runAction(async () => {
              await restoreArchive(id)
              setArchivesOpen(false)
              setEditing(false)
            })
          }
        />
      ) : null}
    </View>
  )
}

function ArchiveSectionModal({
  sections,
  onArchive,
  onClose,
}: {
  sections: Array<{ heading: string; chars: number }>
  onArchive: (heading: string) => void
  onClose: () => void
}) {
  const [picked, setPicked] = useState<string | null>(null)
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable className="flex-1 items-center justify-center bg-black/40 p-6" onPress={onClose}>
        <Pressable className="max-h-[80%] w-full max-w-xl rounded-xl bg-card p-5" onPress={() => {}}>
          <View className="mb-2 flex-row items-center gap-2">
            <Archive size={16} className="text-muted-foreground" />
            <Text className="flex-1 text-base font-semibold text-foreground">Archive a section</Text>
            <Pressable onPress={onClose} accessibilityLabel="Close">
              <X size={16} className="text-muted-foreground" />
            </Pressable>
          </View>
          <Text className="mb-3 text-xs text-muted-foreground">
            Every agent woken in this channel reads the whole doc, so finished work belongs in its card thread. Archiving
            moves a section out of the doc and leaves a one-line pointer behind; you can read or restore it from the archive.
          </Text>
          <ScrollView testID="archive-section-list">
            {sections.map((s) => (
              <Pressable
                key={s.heading}
                onPress={() => setPicked(s.heading)}
                accessibilityRole="button"
                accessibilityLabel={`Archive ${s.heading}`}
                className={cn('flex-row items-center gap-2 rounded-md px-2 py-2 active:bg-muted hover:bg-muted', picked === s.heading && 'bg-muted')}
              >
                <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
                  {s.heading}
                </Text>
                <Text className="text-xs text-muted-foreground">{s.chars.toLocaleString('en-US')}</Text>
              </Pressable>
            ))}
            {!sections.length ? <Text className="text-sm text-muted-foreground">This doc has no sections yet.</Text> : null}
          </ScrollView>
          {picked ? (
            <View className="mt-3 flex-row items-center justify-end gap-2">
              <Text className="flex-1 text-xs text-muted-foreground" numberOfLines={2}>
                “{picked}” moves to the archive.
              </Text>
              <Pressable
                onPress={() => onArchive(picked)}
                accessibilityRole="button"
                accessibilityLabel="Archive section"
                className="rounded-md bg-primary px-3 py-1.5"
              >
                <Text className="text-sm font-medium text-primary-foreground">Archive</Text>
              </Pressable>
            </View>
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  )
}

function ArchivesModal({
  conversationId,
  canRestore,
  onClose,
  onRestore,
}: {
  conversationId: string
  canRestore: boolean
  onClose: () => void
  onRestore: (archiveId: string) => void
}) {
  const [archives, setArchives] = useState<ChannelDocArchive[] | null>(null)
  const [selected, setSelected] = useState<ChannelDocArchive | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.listDocArchives(conversationId).then(setArchives).catch((err) => setError(err?.message ?? 'Could not load the archive'))
  }, [conversationId])

  const open = async (archive: ChannelDocArchive) => {
    try {
      setError(null)
      setSelected(await api.getDocArchive(conversationId, archive.id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open that section')
    }
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable className="flex-1 items-center justify-center bg-black/40 p-6" onPress={onClose}>
        <Pressable className="max-h-[85%] w-full max-w-2xl rounded-xl bg-card p-5" onPress={() => {}}>
          <View className="mb-3 flex-row items-center gap-2">
            <ArchiveRestore size={16} className="text-muted-foreground" />
            <Text className="flex-1 text-base font-semibold text-foreground">{selected ? selected.heading : 'Archived sections'}</Text>
            {selected ? (
              <Pressable onPress={() => setSelected(null)} className="rounded-md px-2 py-1 active:bg-muted hover:bg-muted">
                <Text className="text-xs text-muted-foreground">All archived</Text>
              </Pressable>
            ) : null}
            <Pressable onPress={onClose} accessibilityLabel="Close">
              <X size={16} className="text-muted-foreground" />
            </Pressable>
          </View>
          {error ? <Text className="text-sm text-destructive">{error}</Text> : null}
          {!archives && !error ? <ActivityIndicator /> : null}
          {selected ? (
            <>
              <ScrollView className="max-h-[60vh] rounded-md border border-border p-3" testID="archive-body">
                <MarkdownText>{selected.content || '_Empty_'}</MarkdownText>
              </ScrollView>
              {canRestore ? (
                <View className="mt-3 flex-row justify-end">
                  <Pressable
                    onPress={() => onRestore(selected.id)}
                    accessibilityRole="button"
                    accessibilityLabel="Restore this section"
                    className="rounded-md bg-primary px-3 py-1.5"
                  >
                    <Text className="text-sm font-medium text-primary-foreground">Restore to the doc</Text>
                  </Pressable>
                </View>
              ) : null}
            </>
          ) : (
            <ScrollView testID="archive-list">
              {archives?.map((a) => (
                <Pressable
                  key={a.id}
                  onPress={() => void open(a)}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${a.heading}`}
                  className="flex-row items-center gap-2 rounded-md px-2 py-2 active:bg-muted hover:bg-muted"
                >
                  <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
                    {a.heading}
                  </Text>
                  <Text className="text-xs text-muted-foreground">{a.chars.toLocaleString('en-US')} chars</Text>
                </Pressable>
              ))}
              {archives && !archives.length ? (
                <Text className="text-sm text-muted-foreground">Nothing archived from this doc.</Text>
              ) : null}
            </ScrollView>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  )
}

function DocView({
  content,
  names,
  canToggle,
  onToggle,
  onMentionPress,
}: {
  content: string
  names: ReturnType<typeof mentionNames>
  canToggle: boolean
  onToggle: (line: number) => void
  onMentionPress?: (target: MentionTarget) => void
}) {
  const segments = splitTaskSegments(content)
  return (
    <View className="gap-1" testID="doc-view">
      {segments.map((s, i) =>
        s.type === 'markdown' ? (
          <MarkdownText key={`m${i}`} onMentionPress={onMentionPress}>
            {renderMentionsMarkdown(s.text, names)}
          </MarkdownText>
        ) : (
          <Pressable
            key={`t${s.line}`}
            disabled={!canToggle}
            onPress={() => onToggle(s.line)}
            accessibilityRole="checkbox"
            aria-checked={s.checked}
            accessibilityLabel={s.text}
            className="flex-row items-start gap-2 py-0.5"
            style={{ paddingLeft: s.indent * 16 }}
          >
            <View className="pt-0.5">
              {s.checked ? <SquareCheck size={16} className="text-primary" /> : <Square size={16} className="text-muted-foreground" />}
            </View>
            <View className={cn('min-w-0 flex-1', s.checked && 'opacity-60')}>
              <MarkdownText onMentionPress={onMentionPress}>
                {renderMentionsMarkdown(s.checked ? `~~${s.text}~~` : s.text, names)}
              </MarkdownText>
            </View>
          </Pressable>
        ),
      )}
    </View>
  )
}

function HistoryModal({
  conversationId,
  canRestore,
  onClose,
  onRestore,
}: {
  conversationId: string
  canRestore: boolean
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
                <MarkdownText>{selected.content || '_Empty_'}</MarkdownText>
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

function MentionModal({ mentionables, onPick, onClose }: { mentionables: Mentionables | null; onPick: (key: string) => void; onClose: () => void }) {
  const [filter, setFilter] = useState('')
  const q = filter.trim().toLowerCase()
  const entries = [
    ...(mentionables?.people ?? []).map((p) => ({ key: `u:${p.id}`, name: p.name })),
    ...(mentionables?.agents ?? []).map((a) => ({ key: `a:${a.key}`, name: a.name })),
  ].filter((e) => !q || e.name.toLowerCase().includes(q))
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable className="flex-1 items-center justify-center bg-black/40 p-6" onPress={onClose}>
        <Pressable className="max-h-[70%] w-full max-w-sm rounded-xl bg-card p-4" onPress={() => {}}>
          <TextInput
            value={filter}
            onChangeText={setFilter}
            autoFocus
            placeholder="Mention a person or agent"
            placeholderTextColor="#8a8a8a"
            className="mb-2 rounded-md border border-border px-3 py-2 text-sm text-foreground"
          />
          <ScrollView>
            {entries.map((e) => (
              <Pressable key={e.key} onPress={() => onPick(e.key)} className="rounded-md px-2 py-1.5 active:bg-muted hover:bg-muted">
                <Text className="text-sm text-foreground">{e.name}</Text>
              </Pressable>
            ))}
          </ScrollView>
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
