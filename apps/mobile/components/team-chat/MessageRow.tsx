// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One message in a team chat timeline: author header (grouped), Markdown
 * body with mentions, attachments, reactions, thread summary, and live agent
 * replies (streaming text, the tool in use, Stop).
 */
import { memo, useState } from 'react'
import { ActionSheetIOS, Alert, Image, Linking, Platform, Pressable, Text, TextInput, View } from 'react-native'
import { AlarmClock, AlertCircle, Bookmark, Bot, CornerDownRight, FileText, Loader2, MessageSquare, Pencil, Pin, SmilePlus, Square, Trash2 } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { MarkdownText } from '../chat/MarkdownText'
import { absoluteApiUrl, teamChatApi, type ChatMessage, type LinkUnfurl } from '../../lib/team-chat-api'
import { renderMentions, type MentionNames } from '../../lib/team-chat-state'
import { useUserStatus } from '../../hooks/useChatPrefs'
import { PresenceDot } from './PresenceDot'
import { toggleSaved, useIsSaved } from '../../hooks/useChatItems'
import { customEmojiFor, jumboEmojiCodes, useCustomEmoji } from '../../hooks/useCustomEmoji'
import { useEditRequest } from '../../hooks/useChatShortcuts'

export const QUICK_REACTIONS = ['👍', '✅', '👀', '🎉', '❤️', '😂']

const api = teamChatApi()

export const REMIND_OPTIONS: Array<{ label: string; at: () => Date }> = [
  { label: 'In 20 minutes', at: () => new Date(Date.now() + 20 * 60_000) },
  { label: 'In 1 hour', at: () => new Date(Date.now() + 60 * 60_000) },
  { label: 'In 3 hours', at: () => new Date(Date.now() + 3 * 60 * 60_000) },
  {
    label: 'Tomorrow',
    at: () => {
      const d = new Date()
      d.setDate(d.getDate() + 1)
      d.setHours(9, 0, 0, 0)
      return d
    },
  },
]

export interface MessageRowProps {
  message: ChatMessage
  grouped: boolean
  me: string | null
  names: MentionNames
  streaming?: { text: string; tool: string | null }
  canManage: boolean
  /** Can pin (anyone who can post or reply here). */
  canPin?: boolean
  workspaceId?: string
  inThread?: boolean
  onReply?: (message: ChatMessage) => void
  onReact: (message: ChatMessage, emoji: string) => void
  onEdit: (message: ChatMessage, text: string) => Promise<void>
  onDelete: (message: ChatMessage) => void
  onStopAgent: (message: ChatMessage) => void
  onRetry: (message: ChatMessage) => void
  onDiscard: (message: ChatMessage) => void
  onOpenSession?: (message: ChatMessage) => void
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?'
}

function Avatar({ message }: { message: ChatMessage }) {
  if (message.authorType === 'agent') {
    return (
      <View className="h-8 w-8 items-center justify-center rounded-lg bg-primary/15">
        <Bot size={16} className="text-primary" />
      </View>
    )
  }
  if (message.authorType === 'system') {
    return <View className="h-8 w-8 items-center justify-center rounded-lg bg-muted" />
  }
  const name = message.author?.name ?? 'Someone'
  return (
    <View className="relative">
      {message.author?.image ? (
        <Image source={{ uri: message.author.image }} className="h-8 w-8 rounded-lg" accessibilityIgnoresInvertColors />
      ) : (
        <View className="h-8 w-8 items-center justify-center rounded-lg bg-secondary">
          <Text className="text-xs font-semibold text-secondary-foreground">{initials(name)}</Text>
        </View>
      )}
      <PresenceDot userId={message.authorUserId} size={10} badge />
    </View>
  )
}

function authorName(message: ChatMessage): string {
  if (message.authorType === 'agent') return message.authorAgent?.name ?? 'Agent'
  if (message.authorType === 'system') return 'Shogo'
  if (message.authorType === 'bot') return 'Bot'
  return message.author?.name ?? 'Someone'
}

function AuthorStatus({ userId }: { userId: string | null | undefined }) {
  const status = useUserStatus(undefined, userId)
  if (!status?.emoji && !status?.dnd) return null
  const label = [status.text, status.dnd ? 'Do not disturb' : null].filter(Boolean).join(' · ')
  return (
    <Text className="text-xs" accessibilityLabel={label || 'Status'} {...({ title: label } as object)}>
      {status.emoji ?? ''}
      {status.dnd ? <Text className="text-[10px] text-muted-foreground"> 🔕</Text> : null}
    </Text>
  )
}

function UnfurlCards({ message }: { message: ChatMessage }) {
  const unfurls = (message.blocks as { unfurls?: LinkUnfurl[] } | null)?.unfurls
  if (!Array.isArray(unfurls)) return null
  const live = unfurls.filter((u) => message.text.includes(u.url))
  if (!live.length) return null
  return (
    <View className="mt-1.5 gap-1.5">
      {live.map((u) => (
        <Pressable
          key={u.url}
          onPress={() => Linking.openURL(u.url)}
          accessibilityRole="link"
          accessibilityLabel={`Link preview: ${u.title}`}
          className="max-w-[520px] flex-row gap-3 rounded-md border-l-4 border-border bg-muted/30 py-2 pl-3 pr-2 active:bg-muted"
        >
          <View className="min-w-0 flex-1">
            {u.siteName ? <Text className="text-[11px] text-muted-foreground" numberOfLines={1}>{u.siteName}</Text> : null}
            <Text className="text-sm font-semibold text-primary" numberOfLines={2}>{u.title}</Text>
            {u.description ? <Text className="mt-0.5 text-xs text-muted-foreground" numberOfLines={3}>{u.description}</Text> : null}
          </View>
          {u.image ? (
            <Image source={{ uri: u.image }} className="h-16 w-16 rounded" resizeMode="cover" accessibilityIgnoresInvertColors />
          ) : null}
        </Pressable>
      ))}
    </View>
  )
}

function ReactionGlyph({ emoji, size = 12 }: { emoji: string; size?: number }) {
  const custom = customEmojiFor(emoji, useCustomEmoji())
  if (custom) {
    return <Image source={{ uri: custom.url }} style={{ width: size + 4, height: size + 4 }} accessibilityLabel={emoji} />
  }
  return <Text style={{ fontSize: size }}>{emoji}</Text>
}

function MessageRowImpl(props: MessageRowProps) {
  const { message, grouped, me, names, streaming, canManage, inThread } = props
  const [hovered, setHovered] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [remindOpen, setRemindOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const saved = useIsSaved(message.id)
  const customEmoji = useCustomEmoji()
  const [draft, setDraft] = useState(message.text)
  const mine = !!me && message.authorUserId === me
  const deleted = !!message.deletedAt
  const running = message.authorType === 'agent' && message.agentStatus === 'running'
  const body = running ? streaming?.text ?? '' : message.text
  const isWeb = Platform.OS === 'web'
  useEditRequest(message.id, () => {
    if (!mine || deleted || message.authorType !== 'user') return
    setDraft(message.text)
    setEditing(true)
  })

  const pin = () => void api.pin(message.id, !message.pinned).catch(() => {})
  const save = () => void toggleSaved(message.id, !saved).catch(() => {})
  const remind = (at: Date) => {
    setRemindOpen(false)
    if (!props.workspaceId) return
    void api.createReminder(props.workspaceId, { messageId: message.id, remindAt: at.toISOString() }).catch(() => {})
  }
  const canAct = !deleted && !message.pending && message.authorType !== 'system'

  const openActions = () => {
    if (deleted || message.pending) return
    const options: Array<{ label: string; run: () => void; destructive?: boolean }> = [
      ...QUICK_REACTIONS.slice(0, 4).map((emoji) => ({ label: emoji, run: () => props.onReact(message, emoji) })),
    ]
    if (props.onReply && !inThread) options.push({ label: 'Reply in thread', run: () => props.onReply!(message) })
    options.push({ label: saved ? 'Remove from saved' : 'Save for later', run: save })
    if (props.workspaceId) options.push({ label: 'Remind me in 1 hour', run: () => remind(REMIND_OPTIONS[1].at()) })
    if (props.canPin) options.push({ label: message.pinned ? 'Unpin' : 'Pin to conversation', run: pin })
    if (mine && message.authorType === 'user') options.push({ label: 'Edit', run: () => { setDraft(message.text); setEditing(true) } })
    if (mine || canManage) options.push({ label: 'Delete', run: () => props.onDelete(message), destructive: true })
    if (Platform.OS === 'ios') {
      const labels = [...options.map((o) => o.label), 'Cancel']
      ActionSheetIOS.showActionSheetWithOptions(
        { options: labels, cancelButtonIndex: labels.length - 1, destructiveButtonIndex: options.findIndex((o) => o.destructive) },
        (i) => options[i]?.run(),
      )
    } else {
      Alert.alert('Message', undefined, [
        ...options.map((o) => ({ text: o.label, onPress: o.run, style: o.destructive ? ('destructive' as const) : ('default' as const) })),
        { text: 'Cancel', style: 'cancel' as const },
      ])
    }
  }

  const saveEdit = async () => {
    const text = draft.trim()
    if (!text || text === message.text) {
      setEditing(false)
      return
    }
    await props.onEdit(message, text)
    setEditing(false)
  }

  if (message.authorType === 'system' && message.blocks?.type === 'activity') {
    const canDiscuss = !!props.onReply && !inThread
    return (
      <Pressable
        onPress={canDiscuss && !isWeb ? () => props.onReply!(message) : undefined}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        className={cn('flex-row items-start gap-2 px-4 py-1.5', hovered && 'bg-muted/40')}
      >
        <View className="mt-1.5 h-1.5 w-1.5 rounded-full bg-primary/60" />
        <View className="min-w-0 flex-1">
          <MarkdownText>{renderMentions(message.text, names)}</MarkdownText>
          {message.replyCount > 0 && canDiscuss && (
            <Pressable onPress={() => props.onReply!(message)} className="mt-0.5 flex-row items-center gap-1 self-start">
              <MessageSquare size={11} className="text-primary" />
              <Text className="text-xs font-medium text-primary">
                {message.replyCount} {message.replyCount === 1 ? 'reply' : 'replies'}
              </Text>
            </Pressable>
          )}
        </View>
        {isWeb && hovered && canDiscuss ? (
          <Pressable onPress={() => props.onReply!(message)} accessibilityLabel="Discuss in thread" className="rounded px-1.5 py-0.5 hover:bg-muted">
            <Text className="text-[11px] text-muted-foreground">Discuss</Text>
          </Pressable>
        ) : (
          <Text className="text-[11px] text-muted-foreground">{formatTime(message.createdAt)}</Text>
        )}
      </Pressable>
    )
  }

  return (
    <Pressable
      onLongPress={isWeb ? undefined : openActions}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => {
        setHovered(false)
        setPickerOpen(false)
        setRemindOpen(false)
      }}
      className={cn(
        'relative flex-row gap-3 px-4',
        grouped ? 'py-0.5' : 'pt-2.5 pb-0.5',
        message.pinned && !deleted ? 'bg-amber-500/5' : null,
        hovered && 'bg-muted/40',
      )}
      accessibilityLabel={`${authorName(message)}: ${message.text}`}
    >
      <View className="w-8">
        {grouped ? (
          hovered ? <Text className="pt-1 text-[10px] text-muted-foreground">{formatTime(message.createdAt)}</Text> : null
        ) : (
          <Avatar message={message} />
        )}
      </View>
      <View className="min-w-0 flex-1">
        {!grouped && (
          <View className="flex-row items-baseline gap-2">
            <Text className="text-sm font-semibold text-foreground">{authorName(message)}</Text>
            {message.authorType === 'user' ? <AuthorStatus userId={message.authorUserId} /> : null}
            {message.authorType === 'agent' && (
              <View className="rounded bg-primary/10 px-1.5 py-px">
                <Text className="text-[10px] font-medium text-primary">AGENT</Text>
              </View>
            )}
            <Text className="text-[11px] text-muted-foreground">{formatTime(message.createdAt)}</Text>
          </View>
        )}

        {message.pinned && !deleted && (
          <View className="flex-row items-center gap-1">
            <Pin size={10} className="text-amber-600" />
            <Text className="text-[11px] text-amber-700 dark:text-amber-400">Pinned</Text>
          </View>
        )}
        {saved && !deleted && (
          <View className="flex-row items-center gap-1">
            <Bookmark size={10} className="text-primary" />
            <Text className="text-[11px] text-primary">Saved for later</Text>
          </View>
        )}

        {message.threadRootId && message.alsoSentToChannel && !inThread && (
          <View className="flex-row items-center gap-1">
            <CornerDownRight size={11} className="text-muted-foreground" />
            <Text className="text-[11px] text-muted-foreground">replied to a thread</Text>
          </View>
        )}

        {deleted ? (
          <Text className="text-sm italic text-muted-foreground">This message was deleted.</Text>
        ) : editing ? (
          <View className="mt-1 rounded-lg border border-border bg-background p-2">
            <TextInput
              value={draft}
              onChangeText={setDraft}
              multiline
              autoFocus
              className="min-h-[40px] text-sm text-foreground"
              onKeyPress={(e: any) => {
                if (!isWeb) return
                if (e.nativeEvent.key === 'Escape') setEditing(false)
                if (e.nativeEvent.key === 'Enter' && !e.nativeEvent.shiftKey) {
                  e.preventDefault?.()
                  void saveEdit()
                }
              }}
            />
            <View className="mt-2 flex-row justify-end gap-2">
              <Pressable onPress={() => setEditing(false)} className="rounded-md px-3 py-1.5 active:bg-muted">
                <Text className="text-xs text-muted-foreground">Cancel</Text>
              </Pressable>
              <Pressable onPress={saveEdit} className="rounded-md bg-primary px-3 py-1.5">
                <Text className="text-xs font-medium text-primary-foreground">Save</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <>
            {!!body && (() => {
              const jumbo = running ? null : jumboEmojiCodes(body, customEmoji)
              return (
                <View className={cn(message.pending && 'opacity-60')}>
                  {jumbo ? (
                    <View className="flex-row flex-wrap gap-1 py-0.5">
                      {jumbo.map((code, i) => <ReactionGlyph key={`${code}-${i}`} emoji={code} size={32} />)}
                    </View>
                  ) : (
                    <MarkdownText isStreaming={running}>{renderMentions(body, names)}</MarkdownText>
                  )}
                </View>
              )
            })()}
            {!running && <UnfurlCards message={message} />}
            {running && (
              <View className="mt-1 flex-row items-center gap-2">
                <Loader2 size={12} className="text-muted-foreground" />
                <Text className="text-xs text-muted-foreground">
                  {streaming?.tool ? `Using ${streaming.tool}…` : body ? 'Writing…' : 'Thinking…'}
                </Text>
                <Pressable
                  onPress={() => props.onStopAgent(message)}
                  accessibilityLabel="Stop agent"
                  className="flex-row items-center gap-1 rounded-md border border-border px-2 py-0.5 active:bg-muted"
                >
                  <Square size={10} className="text-muted-foreground" />
                  <Text className="text-[11px] text-muted-foreground">Stop</Text>
                </Pressable>
              </View>
            )}
            {message.authorType === 'agent' && message.agentStatus === 'error' && (
              <View className="mt-1 flex-row items-center gap-1">
                <AlertCircle size={12} className="text-destructive" />
                <Text className="text-xs text-destructive">The agent hit an error.</Text>
              </View>
            )}
            {message.authorType === 'agent' && message.agentSessionId && message.authorAgent?.projectId && !running && props.onOpenSession && (
              <Pressable onPress={() => props.onOpenSession!(message)} className="mt-1 self-start">
                <Text className="text-[11px] text-primary">Open full session</Text>
              </Pressable>
            )}
            {message.editedAt && <Text className="text-[10px] text-muted-foreground">(edited)</Text>}
          </>
        )}

        {!deleted && message.attachments.length > 0 && (
          <View className="mt-1.5 flex-row flex-wrap gap-2">
            {message.attachments.map((a) =>
              a.mimeType.startsWith('image/') ? (
                <Pressable key={a.id} onPress={() => Linking.openURL(absoluteApiUrl(a.url))}>
                  <Image
                    source={{ uri: absoluteApiUrl(a.url) }}
                    className="rounded-lg border border-border"
                    style={{ width: 220, height: a.width && a.height ? Math.min(260, (220 * a.height) / a.width) : 160 }}
                    resizeMode="cover"
                    accessibilityLabel={a.name}
                  />
                </Pressable>
              ) : (
                <Pressable
                  key={a.id}
                  onPress={() => Linking.openURL(absoluteApiUrl(a.url))}
                  className="flex-row items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 active:bg-muted"
                >
                  <FileText size={16} className="text-muted-foreground" />
                  <View>
                    <Text className="text-xs font-medium text-foreground" numberOfLines={1}>{a.name}</Text>
                    <Text className="text-[10px] text-muted-foreground">{formatBytes(a.size)}</Text>
                  </View>
                </Pressable>
              ),
            )}
          </View>
        )}

        {message.pending === 'failed' && (
          <View className="mt-1 flex-row items-center gap-3">
            <Text className="text-xs text-destructive">Not sent.</Text>
            <Pressable onPress={() => props.onRetry(message)}>
              <Text className="text-xs font-medium text-primary">Retry</Text>
            </Pressable>
            <Pressable onPress={() => props.onDiscard(message)}>
              <Text className="text-xs text-muted-foreground">Discard</Text>
            </Pressable>
          </View>
        )}

        {!deleted && message.reactions.length > 0 && (
          <View className="mt-1 flex-row flex-wrap gap-1">
            {message.reactions.map((r) => {
              const reacted = !!me && r.userIds.includes(me)
              return (
                <Pressable
                  key={r.emoji}
                  onPress={() => props.onReact(message, r.emoji)}
                  accessibilityLabel={`${r.emoji} ${r.count}`}
                  className={cn(
                    'flex-row items-center gap-1 rounded-full border px-2 py-0.5',
                    reacted ? 'border-primary/50 bg-primary/10' : 'border-border bg-card',
                  )}
                >
                  <ReactionGlyph emoji={r.emoji} />
                  <Text className={cn('text-[11px]', reacted ? 'text-primary' : 'text-muted-foreground')}>{r.count}</Text>
                </Pressable>
              )
            })}
          </View>
        )}

        {!inThread && message.replyCount > 0 && props.onReply && (
          <Pressable onPress={() => props.onReply!(message)} className="mt-1 flex-row items-center gap-1.5 self-start rounded-md py-0.5">
            <MessageSquare size={12} className="text-primary" />
            <Text className="text-xs font-medium text-primary">
              {message.replyCount} {message.replyCount === 1 ? 'reply' : 'replies'}
            </Text>
            {message.lastReplyAt && (
              <Text className="text-[11px] text-muted-foreground">Last reply {formatTime(message.lastReplyAt)}</Text>
            )}
          </Pressable>
        )}
      </View>

      {isWeb && hovered && !deleted && !message.pending && !editing && (
        <View className="absolute right-3 -top-3 flex-row items-center rounded-lg border border-border bg-card px-1 py-0.5 shadow-sm">
          {QUICK_REACTIONS.slice(0, 3).map((emoji) => (
            <Pressable key={emoji} onPress={() => props.onReact(message, emoji)} className="rounded px-1.5 py-1 hover:bg-muted">
              <Text className="text-sm">{emoji}</Text>
            </Pressable>
          ))}
          <Pressable onPress={() => { setRemindOpen(false); setPickerOpen((open) => !open) }} accessibilityLabel="More reactions" className="rounded px-1.5 py-1 hover:bg-muted">
            <SmilePlus size={14} className="text-muted-foreground" />
          </Pressable>
          {props.onReply && !inThread && (
            <Pressable onPress={() => props.onReply!(message)} accessibilityLabel="Reply in thread" className="rounded px-1.5 py-1 hover:bg-muted">
              <MessageSquare size={14} className="text-muted-foreground" />
            </Pressable>
          )}
          {canAct && (
            <Pressable onPress={save} accessibilityLabel={saved ? 'Remove from saved' : 'Save for later'} className="rounded px-1.5 py-1 hover:bg-muted">
              <Bookmark size={14} className={saved ? 'text-primary' : 'text-muted-foreground'} fill={saved ? 'currentColor' : 'none'} />
            </Pressable>
          )}
          {canAct && props.workspaceId && (
            <Pressable onPress={() => { setPickerOpen(false); setRemindOpen((v) => !v) }} accessibilityLabel="Remind me about this" className="rounded px-1.5 py-1 hover:bg-muted">
              <AlarmClock size={14} className="text-muted-foreground" />
            </Pressable>
          )}
          {canAct && props.canPin && (
            <Pressable onPress={pin} accessibilityLabel={message.pinned ? 'Unpin' : 'Pin to conversation'} className="rounded px-1.5 py-1 hover:bg-muted">
              <Pin size={14} className={message.pinned ? 'text-amber-600' : 'text-muted-foreground'} />
            </Pressable>
          )}
          {mine && message.authorType === 'user' && (
            <Pressable onPress={() => { setDraft(message.text); setEditing(true) }} accessibilityLabel="Edit message" className="rounded px-1.5 py-1 hover:bg-muted">
              <Pencil size={14} className="text-muted-foreground" />
            </Pressable>
          )}
          {(mine || canManage) && (
            <Pressable onPress={() => props.onDelete(message)} accessibilityLabel="Delete message" className="rounded px-1.5 py-1 hover:bg-muted">
              <Trash2 size={14} className="text-muted-foreground" />
            </Pressable>
          )}
        </View>
      )}
      {isWeb && hovered && remindOpen && (
        <View className="absolute right-3 top-6 z-10 w-44 rounded-lg border border-border bg-card py-1 shadow-md">
          <Text className="px-3 pb-1 pt-1 text-[11px] font-semibold uppercase text-muted-foreground">Remind me</Text>
          {REMIND_OPTIONS.map((o) => (
            <Pressable key={o.label} onPress={() => remind(o.at())} className="px-3 py-1.5 hover:bg-muted">
              <Text className="text-sm text-foreground">{o.label}</Text>
            </Pressable>
          ))}
        </View>
      )}
      {isWeb && hovered && pickerOpen && (
        <View className="absolute right-3 top-6 z-10 w-56 flex-row flex-wrap rounded-lg border border-border bg-card p-1 shadow-md">
          {[...customEmoji.values()].slice(0, 24).map((e) => (
            <Pressable
              key={e.id}
              accessibilityLabel={`:${e.name}:`}
              onPress={() => {
                setPickerOpen(false)
                props.onReact(message, `:${e.name}:`)
              }}
              className="rounded px-1.5 py-1 hover:bg-muted"
            >
              <Image source={{ uri: e.url }} style={{ width: 20, height: 20 }} />
            </Pressable>
          ))}
          {MORE_REACTIONS.map((emoji) => (
            <Pressable
              key={emoji}
              onPress={() => {
                setPickerOpen(false)
                props.onReact(message, emoji)
              }}
              className="rounded px-1.5 py-1 hover:bg-muted"
            >
              <Text className="text-base">{emoji}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </Pressable>
  )
}

const MORE_REACTIONS = ['👍', '👎', '✅', '❌', '👀', '🎉', '❤️', '😂', '🙌', '🔥', '🚀', '🤔', '💯', '🙏', '⚠️', '📌']

export const MessageRow = memo(MessageRowImpl)
