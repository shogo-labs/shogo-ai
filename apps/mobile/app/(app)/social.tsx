// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Social management on the phone (SHO-71 P7).
 *
 * One screen for the six things the suite does, because the phone is where a
 * comment gets answered, not where a campaign gets planned: the accounts a
 * workspace has connected, a composer, the calendar, the inbox, the comment
 * board and the comment→DM automations. Every call goes to the same
 * `/api/workspaces/:id/social/...` routes the desktop and the agent use — this
 * screen owns no logic of its own.
 *
 * Gated by the `socialManagementEnabled` capability: a workspace may manage its
 * connected accounts without paying for public lookups, which live behind
 * `socialMediaEnabled` and are not on this screen.
 */

import { useCallback, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useFocusEffect } from 'expo-router'
import { openAuthFlow, preCreateAuthWindow } from '@shogo/ui-kit/platform'
import {
  CalendarDays,
  CheckCheck,
  Instagram,
  MessageCircle,
  Music2,
  Pause,
  Play,
  RefreshCw,
  Send,
  Trash2,
  Workflow,
} from 'lucide-react-native'
import { useDomainHttp } from '../../contexts/domain'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'

type Tab = 'accounts' | 'compose' | 'calendar' | 'inbox' | 'comments' | 'automations'

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'accounts', label: 'Accounts' },
  { key: 'compose', label: 'Compose' },
  { key: 'calendar', label: 'Calendar' },
  { key: 'inbox', label: 'Inbox' },
  { key: 'comments', label: 'Comments' },
  { key: 'automations', label: 'Automations' },
]

function errorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message) return cause.message
  if (typeof cause === 'string' && cause) return cause
  return fallback
}

/**
 * Platforms that can be connected from this screen. Zernio accepts any platform
 * slug, but these are the two Russell asked for and the two whose sign-in we can
 * describe accurately ("professional account", "creator inbox").
 */
const CONNECTABLE: Array<{ platform: string; label: string; icon: typeof Instagram }> = [
  { platform: 'instagram', label: 'Instagram', icon: Instagram },
  { platform: 'tiktok', label: 'TikTok', icon: Music2 },
]

export default function SocialScreen() {
  const http = useDomainHttp()
  const workspace = useActiveWorkspace()
  const workspaceId = workspace?.id ?? ''

  const [tab, setTab] = useState<Tab>('accounts')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [accounts, setAccounts] = useState<any[]>([])
  const [automations, setAutomations] = useState<any[]>([])
  const [analytics, setAnalytics] = useState<any | null>(null)
  const [calendar, setCalendar] = useState<any[]>([])
  const [conversations, setConversations] = useState<any[]>([])
  const [comments, setComments] = useState<any[]>([])
  const [thread, setThread] = useState<{ id: string; messages: any[] } | null>(null)
  const [connecting, setConnecting] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const base = `/api/workspaces/${workspaceId}/social`

  const call = useCallback(
    async (path: string, init?: { method?: string; body?: unknown }) => {
      const res = await http.request<any>(`${base}${path}`, {
        method: (init?.method ?? 'GET') as any,
        ...(init?.body ? { body: init.body } : {}),
      })
      return res as any
    },
    [base, http],
  )

  /**
   * Ask the provider what this workspace now has connected, then fall back to
   * the rows we already hold. A connect that finished in the browser writes
   * nothing locally until something syncs, so the sync is what makes a
   * just-connected account appear; when the sync itself cannot run (no Shogo
   * Cloud on desktop) its plain-language reason is worth showing.
   */
  const syncAccounts = useCallback(async (): Promise<any[] | null> => {
    try {
      const res = await call('/accounts/sync', { method: 'POST' })
      if (Array.isArray(res?.accounts)) return res.accounts
    } catch (cause) {
      setNotice(errorMessage(cause, 'Could not refresh your connected accounts'))
    }
    try {
      const res = await call('/accounts')
      if (Array.isArray(res?.accounts)) return res.accounts
    } catch {}
    return null
  }, [call])

  const load = useCallback(
    async (refresh = false) => {
      if (!workspaceId) return
      if (refresh) setRefreshing(true)
      else setLoading(true)
      try {
        setError(null)
        const [synced, automationRes, analyticsRes] = await Promise.all([
          syncAccounts(),
          call('/automations?limit=50').catch(() => null),
          call('/analytics').catch(() => null),
        ])
        if (synced) setAccounts(synced)
        setAutomations(Array.isArray(automationRes?.automations) ? automationRes.automations : [])
        setAnalytics(analyticsRes ?? null)
      } catch (cause) {
        setError(errorMessage(cause, 'Could not load your social accounts'))
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    },
    [call, syncAccounts, workspaceId],
  )

  /**
   * Mint a sign-in link and hand it to the user's browser. The link is the only
   * thing that crosses this boundary — the person signs in on the platform's own
   * page, and their password never reaches Shogo.
   *
   * The tab is created before the API call (see `preCreateAuthWindow`) so a
   * mobile browser's popup blocker does not eat it, and the account list is
   * reconciled once the sign-in window goes away.
   *
   * `reconnectAccountId` is set when the row already exists but its token died,
   * so the platform re-authorises that account instead of adding a second one.
   */
  const connectAccount = useCallback(
    async (platform: string, reconnectAccountId?: string) => {
      if (connecting) return
      setConnecting(reconnectAccountId ?? platform)
      setNotice(null)
      const preWindow = Platform.OS === 'web' ? preCreateAuthWindow() : null
      try {
        const res = await call('/connect', {
          method: 'POST',
          body: { platform, ...(reconnectAccountId ? { reconnectAccountId } : {}) },
        })
        const url = typeof res?.url === 'string' ? res.url.trim() : ''
        if (!url) throw new Error('The platform did not return a sign-in link. Try again in a moment.')
        await openAuthFlow(url, { preCreatedWindow: preWindow })
        // The sign-in happens in another window, so whatever came back is
        // already stale — reconcile before showing the list again.
        const synced = await syncAccounts()
        if (synced) setAccounts(synced)
      } catch (cause) {
        setNotice(errorMessage(cause, `Could not start the ${platform} sign-in`))
      } finally {
        setConnecting(null)
        try {
          if (preWindow && !preWindow.closed) {
            const location = preWindow.location.href
            if (location === 'about:blank' || location === '') preWindow.close()
          }
        } catch {
          /* COOP severs the reference — nothing to clean up */
        }
      }
    },
    [call, connecting, syncAccounts],
  )

  const loadTab = useCallback(
    async (next: Tab) => {
      setTab(next)
      setThread(null)
      try {
        setError(null)
        if (next === 'calendar') {
          const res = await call('/calendar')
          setCalendar(Array.isArray(res?.posts) ? res.posts : [])
        } else if (next === 'inbox') {
          const res = await call('/inbox?limit=50')
          setConversations(Array.isArray(res?.conversations) ? res.conversations : [])
        } else if (next === 'comments') {
          const res = await call('/comments?limit=50')
          setComments(Array.isArray(res?.comments) ? res.comments : [])
        } else if (next === 'automations') {
          const res = await call('/automations?limit=50')
          setAutomations(Array.isArray(res?.automations) ? res.automations : [])
        }
      } catch (cause) {
        setError(errorMessage(cause, `Could not load ${next}`))
      }
    },
    [call],
  )

  useFocusEffect(
    useCallback(() => {
      void load()
    }, [load]),
  )

  return (
    <SafeAreaView className="flex-1 bg-background">
      <View className="px-4 pt-3 pb-2">
        <Text className="text-foreground text-xl font-semibold">Social</Text>
        <View className="flex-row flex-wrap gap-2 mt-3">
          {TABS.map((entry) => (
            <Pressable
              key={entry.key}
              onPress={() => void loadTab(entry.key)}
              className={`px-3 py-1.5 rounded-full border ${
                tab === entry.key ? 'bg-primary border-primary' : 'border-border'
              }`}
            >
              <Text
                className={`text-xs font-medium ${
                  tab === entry.key ? 'text-primary-foreground' : 'text-muted-foreground'
                }`}
              >
                {entry.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {error ? (
        <Text className="px-4 pb-2 text-xs text-red-600">{error}</Text>
      ) : null}
      {notice ? (
        <Text className="px-4 pb-2 text-xs text-amber-600">{notice}</Text>
      ) : null}

      {loading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator />
        </View>
      ) : (
        <ScrollView
          className="flex-1"
          contentContainerClassName="p-4 gap-3"
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                void load(true)
                void loadTab(tab)
              }}
            />
          }
        >
          {tab === 'accounts' ? (
            <AccountsTab
              accounts={accounts}
              analytics={analytics}
              connecting={connecting}
              onConnect={connectAccount}
            />
          ) : null}
          {tab === 'compose' ? <ComposeTab accounts={accounts} call={call} onSent={() => void load(true)} /> : null}
          {tab === 'calendar' ? (
            <CalendarTab posts={calendar} call={call} onChanged={() => void loadTab('calendar')} />
          ) : null}
          {tab === 'inbox' ? (
            <InboxTab
              conversations={conversations}
              thread={thread}
              onOpen={async (id: string) => {
                const res = await call(`/inbox/conversations/${encodeURIComponent(id)}`)
                setThread({ id, messages: Array.isArray(res?.messages) ? res.messages : [] })
              }}
              onReply={async (text: string) => {
                if (!thread) return
                await call(`/inbox/conversations/${encodeURIComponent(thread.id)}/messages`, {
                  method: 'POST',
                  body: { text },
                })
                const res = await call(`/inbox/conversations/${encodeURIComponent(thread.id)}`)
                setThread({ id: thread.id, messages: Array.isArray(res?.messages) ? res.messages : [] })
              }}
            />
          ) : null}
          {tab === 'comments' ? (
            <CommentsTab
              comments={comments}
              onReply={async (id: string, text: string) => {
                await call(`/comments/${encodeURIComponent(id)}/reply`, {
                  method: 'POST',
                  body: { text },
                })
                const res = await call('/comments?limit=50')
                setComments(Array.isArray(res?.comments) ? res.comments : [])
              }}
            />
          ) : null}
          {tab === 'automations' ? (
            <AutomationsTab
              accounts={accounts}
              automations={automations}
              call={call}
              onChanged={async () => {
                const res = await call('/automations?limit=50')
                setAutomations(Array.isArray(res?.automations) ? res.automations : [])
              }}
            />
          ) : null}
        </ScrollView>
      )}
    </SafeAreaView>
  )
}

function Card({ children }: { children: React.ReactNode }) {
  return <View className="rounded-xl border border-border p-3 gap-1">{children}</View>
}

function AccountsTab({
  accounts,
  analytics,
  connecting,
  onConnect,
}: {
  accounts: any[]
  analytics: any | null
  /** The platform or account id whose sign-in is currently being opened. */
  connecting: string | null
  onConnect: (platform: string, reconnectAccountId?: string) => void
}) {
  return (
    <>
      <Card>
        <Text className="text-foreground font-medium">Connect an account</Text>
        <View className="flex-row flex-wrap gap-2 mt-1">
          {CONNECTABLE.map((entry) => {
            const Icon = entry.icon
            const busy = connecting === entry.platform
            return (
              <Pressable
                key={entry.platform}
                disabled={!!connecting}
                onPress={() => onConnect(entry.platform)}
                className={`flex-row items-center gap-1.5 px-3 py-2 rounded-lg border ${
                  connecting ? 'border-border opacity-60' : 'border-border'
                }`}
              >
                {busy ? (
                  <ActivityIndicator size="small" />
                ) : (
                  <Icon size={14} className="text-foreground" />
                )}
                <Text className="text-xs font-medium text-foreground">
                  Connect {entry.label}
                </Text>
              </Pressable>
            )
          })}
        </View>
        <Text className="text-[11px] text-muted-foreground mt-1">
          You sign in on the platform's own page — Shogo never sees your password.
          Instagram needs a professional (Business or Creator) account, and it
          switches your account over during that sign-in.
        </Text>
      </Card>

      {accounts.length === 0 ? (
        <Card>
          <Text className="text-foreground font-medium">No accounts connected yet</Text>
          <Text className="text-xs text-muted-foreground">
            Use one of the buttons above, then pull to refresh once you are back.
            On desktop, Shogo Cloud has to be connected first — social accounts go
            through it.
          </Text>
        </Card>
      ) : (
        accounts.map((account) => {
          const needsAttention = !account.isActive || account.needsReconnect
          const busy = connecting === account.id || connecting === account.platform
          const Icon =
            CONNECTABLE.find((entry) => entry.platform === account.platform)?.icon ?? Instagram
          return (
            <Card key={account.id}>
              <View className="flex-row items-center gap-2">
                <Icon size={16} className="text-muted-foreground" />
                <Text className="text-foreground font-medium flex-1">
                  {account.platform} @{account.username}
                </Text>
              </View>
              <Text className="text-xs text-muted-foreground">
                {account.isActive ? 'Connected' : 'Needs reconnecting'}
                {account.needsReconnect ? ' — token expired' : ''}
              </Text>
              {needsAttention ? (
                <Pressable
                  disabled={!!connecting}
                  onPress={() => onConnect(account.platform, account.id)}
                  className="flex-row items-center gap-1.5 self-start px-2.5 py-1.5 mt-1 rounded-lg border border-border"
                >
                  {busy ? (
                    <ActivityIndicator size="small" />
                  ) : (
                    <RefreshCw size={12} className="text-foreground" />
                  )}
                  <Text className="text-xs font-medium text-foreground">Reconnect</Text>
                </Pressable>
              ) : null}
            </Card>
          )
        })
      )}

      {analytics?.engagement ? (
        <Card>
          <Text className="text-foreground font-medium">Last 30 days</Text>
          <Text className="text-xs text-muted-foreground">
            {analytics.publishing?.published ?? 0} published · {analytics.engagement?.comments ?? 0} comments ·{' '}
            {analytics.engagement?.automationRuns ?? 0} automation runs
          </Text>
        </Card>
      ) : null}
    </>
  )
}

function ComposeTab({
  accounts,
  call,
  onSent,
}: {
  accounts: any[]
  call: (path: string, init?: { method?: string; body?: unknown }) => Promise<any>
  onSent: () => void
}) {
  const [picked, setPicked] = useState<string[]>([])
  const [text, setText] = useState('')
  const [scheduledFor, setScheduledFor] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const toggle = (id: string) =>
    setPicked((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    )

  const submit = async (draft: boolean) => {
    if (busy) return
    setBusy(true)
    setNote(null)
    try {
      await call('/posts', {
        method: 'POST',
        body: {
          accountIds: picked,
          content: text,
          draft,
          ...(scheduledFor.trim() ? { scheduledFor: new Date(scheduledFor.trim()).toISOString() } : {}),
        },
      })
      setText('')
      setScheduledFor('')
      setNote(draft ? 'Saved as a draft.' : 'Sent.')
      onSent()
    } catch (cause) {
      setNote(errorMessage(cause, 'Could not publish'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Card>
        <Text className="text-foreground font-medium">Send to</Text>
        <View className="flex-row flex-wrap gap-2 mt-1">
          {accounts.map((account) => (
            <Pressable
              key={account.id}
              onPress={() => toggle(account.id)}
              className={`px-3 py-1.5 rounded-full border ${
                picked.includes(account.id) ? 'bg-primary border-primary' : 'border-border'
              }`}
            >
              <Text
                className={`text-xs ${
                  picked.includes(account.id) ? 'text-primary-foreground' : 'text-muted-foreground'
                }`}
              >
                {account.platform} @{account.username}
              </Text>
            </Pressable>
          ))}
        </View>
      </Card>

      <Card>
        <TextInput
          value={text}
          onChangeText={setText}
          multiline
          placeholder="What are you posting?"
          placeholderTextColor="#8b8b8b"
          className="text-foreground min-h-[96px]"
        />
        <TextInput
          value={scheduledFor}
          onChangeText={setScheduledFor}
          placeholder="Schedule for (optional) — 2026-10-20 09:00"
          placeholderTextColor="#8b8b8b"
          className="text-foreground text-xs mt-2"
        />
      </Card>

      <View className="flex-row gap-2">
        <Pressable
          onPress={() => void submit(true)}
          disabled={busy || !text.trim()}
          className="flex-1 rounded-xl border border-border py-3 items-center"
        >
          <Text className="text-foreground text-sm">Save draft</Text>
        </Pressable>
        <Pressable
          onPress={() => void submit(false)}
          disabled={busy || (!text.trim() && picked.length === 0)}
          className="flex-1 rounded-xl bg-primary py-3 items-center flex-row justify-center gap-2"
        >
          <Send size={14} className="text-primary-foreground" />
          <Text className="text-primary-foreground text-sm">{scheduledFor.trim() ? 'Schedule' : 'Publish'}</Text>
        </Pressable>
      </View>
      {note ? <Text className="text-xs text-muted-foreground">{note}</Text> : null}
    </>
  )
}

function CalendarTab({
  posts,
  call,
  onChanged,
}: {
  posts: any[]
  call: (path: string, init?: { method?: string; body?: unknown }) => Promise<any>
  onChanged: () => void
}) {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [manual, setManual] = useState<any[]>([])

  const remove = async (id: string) => {
    if (busyId) return
    setBusyId(id)
    setNote(null)
    setManual([])
    try {
      const res = await call(`/posts/${encodeURIComponent(id)}`, { method: 'DELETE' })
      const removed = Array.isArray(res?.removed) ? res.removed : []
      const left = Array.isArray(res?.manual) ? res.manual : []
      setManual(left)
      setNote(
        res?.deleted
          ? 'Deleted — nothing was live, so there was nothing to take down.'
          : `Removed from ${removed.length} target${removed.length === 1 ? '' : 's'}.`,
      )
      onChanged()
    } catch (cause) {
      setNote(errorMessage(cause, 'Could not delete the post'))
    } finally {
      setBusyId(null)
    }
  }

  const confirmRemove = (post: any) => {
    // A published post is live on someone's account, so the dialog says what
    // will happen to it rather than asking a bare "delete?".
    const live = post.status === 'published' || post.status === 'partial'
    const targets: any[] = Array.isArray(post.targets) ? post.targets : []
    const stuck = targets
      .filter((target) => target.status === 'published')
      .map((target) => target.platform)
    Alert.alert(
      live ? 'Take this post down?' : 'Delete this post?',
      live
        ? `It is published on ${stuck.join(', ') || 'its accounts'}. It comes down wherever the platform allows it; Instagram, TikTok and Snapchat posts have to be removed in the app.`
        : 'This removes it here and at the provider, so it will not publish.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: live ? 'Take down' : 'Delete', style: 'destructive', onPress: () => void remove(post.id) },
      ],
    )
  }

  if (posts.length === 0) {
    return (
      <Card>
        <Text className="text-foreground font-medium">Nothing scheduled</Text>
        <Text className="text-xs text-muted-foreground">Scheduled and recently published posts land here.</Text>
      </Card>
    )
  }
  return (
    <>
      {note ? <Text className="text-xs text-muted-foreground">{note}</Text> : null}
      {manual.map((entry, index) => (
        <Card key={`manual-${index}`}>
          <Text className="text-foreground text-sm font-medium">
            Remove this in {entry.platform}
            {entry.account ? ` (@${entry.account})` : ''}
          </Text>
          <Text className="text-xs text-muted-foreground">{entry.reason}</Text>
          {entry.url ? (
            <Pressable onPress={() => void Linking.openURL(entry.url)} className="mt-1">
              <Text className="text-xs text-primary" numberOfLines={1}>
                {entry.url}
              </Text>
            </Pressable>
          ) : null}
        </Card>
      ))}
      {posts.map((post) => (
        <Card key={post.id}>
          <View className="flex-row items-center gap-2">
            <CalendarDays size={14} className="text-muted-foreground" />
            <Text className="text-foreground text-sm font-medium">{post.status}</Text>
            <View className="flex-1" />
            <Pressable
              onPress={() => confirmRemove(post)}
              disabled={busyId === post.id}
              className="flex-row items-center gap-1 px-2 py-1 rounded-lg border border-border"
            >
              <Trash2 size={12} className="text-muted-foreground" />
              <Text className="text-[11px] text-muted-foreground">
                {busyId === post.id ? 'Working…' : 'Delete'}
              </Text>
            </Pressable>
          </View>
          <Text className="text-xs text-muted-foreground">
            {post.scheduledFor ? new Date(post.scheduledFor).toLocaleString() : 'Published'}
          </Text>
          <Text className="text-foreground text-sm" numberOfLines={3}>
            {post.content}
          </Text>
        </Card>
      ))}
    </>
  )
}

function InboxTab({
  conversations,
  thread,
  onOpen,
  onReply,
}: {
  conversations: any[]
  thread: { id: string; messages: any[] } | null
  onOpen: (id: string) => Promise<void>
  onReply: (text: string) => Promise<void>
}) {
  const [draft, setDraft] = useState('')

  if (thread) {
    return (
      <>
        <Card>
          {thread.messages.map((message) => (
            <View key={message.id} className="py-1">
              <Text className="text-[11px] text-muted-foreground">
                {message.direction === 'outgoing' ? 'You' : message.authorName ?? 'Them'} ·{' '}
                {message.sentAt ? new Date(message.sentAt).toLocaleString() : ''}
              </Text>
              <Text className="text-foreground text-sm">{message.text}</Text>
            </View>
          ))}
        </Card>
        <View className="flex-row gap-2 items-center">
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="Reply…"
            placeholderTextColor="#8b8b8b"
            className="flex-1 rounded-xl border border-border px-3 py-2 text-foreground text-sm"
          />
          <Pressable
            onPress={async () => {
              if (!draft.trim()) return
              const text = draft.trim()
              setDraft('')
              await onReply(text)
            }}
            className="rounded-xl bg-primary px-4 py-2"
          >
            <Text className="text-primary-foreground text-sm">Send</Text>
          </Pressable>
        </View>
      </>
    )
  }

  if (conversations.length === 0) {
    return (
      <Card>
        <Text className="text-foreground font-medium">No conversations</Text>
        <Text className="text-xs text-muted-foreground">DM threads land here once an account is connected.</Text>
      </Card>
    )
  }

  return (
    <>
      {conversations.map((conversation) => (
        <Pressable key={conversation.id} onPress={() => void onOpen(conversation.id)}>
          <Card>
            <View className="flex-row items-center justify-between">
              <Text className="text-foreground text-sm font-medium">
                {conversation.participantName ?? conversation.participantUsername ?? 'Conversation'}
              </Text>
              {conversation.unreadCount ? (
                <Text className="text-[10px] text-primary-foreground bg-primary rounded-full px-2">
                  {conversation.unreadCount}
                </Text>
              ) : null}
            </View>
            <Text className="text-xs text-muted-foreground" numberOfLines={2}>
              {conversation.lastMessageText ?? ''}
            </Text>
          </Card>
        </Pressable>
      ))}
    </>
  )
}

function CommentsTab({
  comments,
  onReply,
}: {
  comments: any[]
  onReply: (id: string, text: string) => Promise<void>
}) {
  const [openId, setOpenId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  if (comments.length === 0) {
    return (
      <Card>
        <Text className="text-foreground font-medium">No comments yet</Text>
        <Text className="text-xs text-muted-foreground">Comments on your published posts show up here.</Text>
      </Card>
    )
  }

  return (
    <>
      {comments.map((comment) => (
        <Card key={comment.id}>
          <View className="flex-row items-center gap-2">
            <MessageCircle size={14} className="text-muted-foreground" />
            <Text className="text-foreground text-xs font-medium">
              @{comment.authorUsername ?? comment.authorName ?? 'someone'} · {comment.platform}
            </Text>
          </View>
          <Text className="text-foreground text-sm">{comment.text}</Text>
          {openId === comment.id ? (
            <View className="flex-row gap-2 items-center mt-2">
              <TextInput
                value={draft}
                onChangeText={setDraft}
                placeholder="Public reply…"
                placeholderTextColor="#8b8b8b"
                className="flex-1 rounded-xl border border-border px-3 py-2 text-foreground text-sm"
              />
              <Pressable
                onPress={async () => {
                  if (!draft.trim()) return
                  const text = draft.trim()
                  setDraft('')
                  setOpenId(null)
                  await onReply(comment.id, text)
                }}
                className="rounded-xl bg-primary px-4 py-2"
              >
                <Text className="text-primary-foreground text-sm">Reply</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable onPress={() => setOpenId(comment.id)} className="mt-1">
              <Text className="text-xs text-primary">Reply</Text>
            </Pressable>
          )}
        </Card>
      ))}
    </>
  )
}

function AutomationsTab({
  accounts,
  automations,
  call,
  onChanged,
}: {
  accounts: any[]
  automations: any[]
  call: (path: string, init?: { method?: string; body?: unknown }) => Promise<any>
  onChanged: () => Promise<void>
}) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const [name, setName] = useState('')
  const [keywords, setKeywords] = useState('')
  const [dmMessage, setDmMessage] = useState('')
  const [commentReply, setCommentReply] = useState('')
  const [note, setNote] = useState<string | null>(null)

  const create = async () => {
    setNote(null)
    try {
      await call('/automations', {
        method: 'POST',
        body: {
          accountId: accountId || accounts[0]?.id,
          name: name.trim() || 'Comment automation',
          keywords: keywords
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean),
          dmMessage: dmMessage.trim() || undefined,
          commentReply: commentReply.trim() || undefined,
        },
      })
      setName('')
      setKeywords('')
      setDmMessage('')
      setCommentReply('')
      setNote('Automation created.')
      await onChanged()
    } catch (cause) {
      setNote(errorMessage(cause, 'Could not create the automation'))
    }
  }

  return (
    <>
      {automations.map((automation) => (
        <Card key={automation.id}>
          <View className="flex-row items-center gap-2">
            <Workflow size={14} className="text-muted-foreground" />
            <Text className="text-foreground text-sm font-medium">{automation.name}</Text>
            <Text className="text-[10px] text-muted-foreground">{automation.status}</Text>
          </View>
          <Text className="text-xs text-muted-foreground">
            {automation.kind} · {automation.platform} · {automation.runCount} runs · keywords:{' '}
            {(automation.keywords ?? []).join(', ') || 'any'}
          </Text>
          <View className="flex-row gap-2 mt-1">
            <Pressable
              onPress={async () => {
                await call(`/automations/${encodeURIComponent(automation.id)}`, {
                  method: 'PATCH',
                  body: { status: automation.status === 'active' ? 'paused' : 'active' },
                })
                await onChanged()
              }}
              className="flex-row items-center gap-1 px-2 py-1 rounded-lg border border-border"
            >
              {automation.status === 'active' ? (
                <Pause size={12} className="text-muted-foreground" />
              ) : (
                <Play size={12} className="text-muted-foreground" />
              )}
              <Text className="text-[11px] text-muted-foreground">
                {automation.status === 'active' ? 'Pause' : 'Resume'}
              </Text>
            </Pressable>
            <Pressable
              onPress={async () => {
                await call(`/automations/${encodeURIComponent(automation.id)}`, { method: 'DELETE' })
                await onChanged()
              }}
              className="flex-row items-center gap-1 px-2 py-1 rounded-lg border border-border"
            >
              <Trash2 size={12} className="text-muted-foreground" />
              <Text className="text-[11px] text-muted-foreground">Delete</Text>
            </Pressable>
          </View>
        </Card>
      ))}

      <Card>
        <Text className="text-foreground font-medium">New comment→DM</Text>
        <View className="flex-row flex-wrap gap-2 mt-1">
          {accounts.map((account) => (
            <Pressable
              key={account.id}
              onPress={() => setAccountId(account.id)}
              className={`px-3 py-1.5 rounded-full border ${
                (accountId || accounts[0]?.id) === account.id ? 'bg-primary border-primary' : 'border-border'
              }`}
            >
              <Text
                className={`text-[11px] ${
                  (accountId || accounts[0]?.id) === account.id
                    ? 'text-primary-foreground'
                    : 'text-muted-foreground'
                }`}
              >
                {account.platform}
              </Text>
            </Pressable>
          ))}
        </View>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Name — Merge funnel"
          placeholderTextColor="#8b8b8b"
          className="text-foreground text-sm mt-2"
        />
        <TextInput
          value={keywords}
          onChangeText={setKeywords}
          placeholder="Keywords — merge,link"
          placeholderTextColor="#8b8b8b"
          className="text-foreground text-sm mt-1"
        />
        <TextInput
          value={dmMessage}
          onChangeText={setDmMessage}
          placeholder="DM to send"
          placeholderTextColor="#8b8b8b"
          className="text-foreground text-sm mt-1"
        />
        <TextInput
          value={commentReply}
          onChangeText={setCommentReply}
          placeholder="Public reply (required where DMs are unavailable)"
          placeholderTextColor="#8b8b8b"
          className="text-foreground text-sm mt-1"
        />
        <Pressable onPress={() => void create()} className="mt-2 rounded-xl bg-primary py-2 items-center">
          <Text className="text-primary-foreground text-sm">Create</Text>
        </Pressable>
        {note ? <Text className="text-[11px] text-muted-foreground">{note}</Text> : null}
        <View className="flex-row items-center gap-1 mt-1">
          <CheckCheck size={12} className="text-muted-foreground" />
          <Text className="text-[10px] text-muted-foreground">
            Instagram and Facebook can DM the commenter; TikTok, Threads, LinkedIn and YouTube answer publicly.
          </Text>
        </View>
      </Card>
    </>
  )
}
