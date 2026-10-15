// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Questions inbox: what agents are waiting on you for, across channels, with
 * each one answerable in place. Approvals waiting on you sit at the top.
 */
import { useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { ShieldAlert } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useActiveWorkspace } from '../../../hooks/useActiveWorkspace'
import { useWorkspaceExperience } from '../../../hooks/useWorkspaceExperience'
import { useMentionables, useMyUserId } from '../../../hooks/useTeamChat'
import { useOpenQuestions, type QuestionTab } from '../../../hooks/useOpenQuestions'
import { mentionNames } from '../../../lib/team-chat-state'
import type { QuestionListItem } from '../../../lib/team-chat-api'
import { QuestionCardView } from '../../../components/team-chat/QuestionCard'
import { AgentAvatar } from '../../../components/team-chat/AgentAvatar'

const TABS: Array<{ id: QuestionTab; label: string }> = [
  { id: 'open', label: 'Open' },
  { id: 'answered', label: 'Answered' },
  { id: 'all', label: 'All' },
]

function relativeTime(iso: string, now = Date.now()): string {
  const diff = Math.max(0, now - new Date(iso).getTime())
  const min = Math.floor(diff / 60_000)
  if (min < 1) return 'now'
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function where(item: QuestionListItem): string {
  const c = item.conversation
  if (c.kind === 'dm' || c.kind === 'group_dm') return 'Direct message'
  return `#${c.name ?? c.slug ?? 'channel'}`
}

export default function QuestionsInbox() {
  const router = useRouter()
  const workspace = useActiveWorkspace()
  const experience = useWorkspaceExperience()
  const workspaceId: string | null = experience.kind === 'team' ? workspace?.id ?? null : null
  const me = useMyUserId()
  const names = mentionNames(useMentionables(workspaceId))
  const [tab, setTab] = useState<QuestionTab>('open')
  const [everyone, setEveryone] = useState(false)
  const { questions, approvals, openCount, loading, error } = useOpenQuestions(workspaceId, { status: tab, scope: everyone ? 'all' : 'mine' })

  const openThread = (item: { conversationId: string; messageId: string; threadRootId?: string | null }) =>
    router.push({
      pathname: '/(app)/c/[conversationId]',
      params: { conversationId: item.conversationId, msg: item.messageId, ...(item.threadRootId ? { thread: item.threadRootId } : {}) },
    } as any)

  if (experience.resolved && experience.kind !== 'team') {
    return (
      <View className="flex-1 items-center justify-center bg-background px-8">
        <Text className="text-center text-sm text-muted-foreground">Team chat is available in team workspaces.</Text>
      </View>
    )
  }

  const showApprovals = tab !== 'answered' && approvals.length > 0
  return (
    <View className="flex-1 bg-background">
      <View className="w-full self-center px-6 pt-6" style={{ maxWidth: 820 }}>
        <View className="flex-row items-center gap-2">
          <Text className="text-2xl font-semibold text-foreground">Questions</Text>
          {openCount ? (
            <View className="rounded-full bg-amber-500/20 px-2 py-0.5">
              <Text className="text-xs font-semibold text-amber-700 dark:text-amber-400" testID="questions-open-count">{`${openCount} waiting on you`}</Text>
            </View>
          ) : null}
        </View>
        <View className="mt-3 flex-row flex-wrap items-center gap-2">
          {TABS.map((t) => (
            <Pressable
              key={t.id}
              accessibilityRole="button"
              accessibilityState={{ selected: tab === t.id }}
              onPress={() => setTab(t.id)}
              className={cn('rounded-full border px-3 py-1', tab === t.id ? 'border-primary bg-primary/10' : 'border-border')}
            >
              <Text className={cn('text-xs', tab === t.id ? 'text-primary' : 'text-muted-foreground')}>{t.label}</Text>
            </Pressable>
          ))}
          <View className="mx-1 h-4 w-px bg-border" />
          <Pressable
            accessibilityRole="switch"
            accessibilityState={{ checked: everyone }}
            onPress={() => setEveryone((v) => !v)}
            className={cn('rounded-full border px-3 py-1', everyone ? 'border-primary bg-primary/10' : 'border-border')}
          >
            <Text className={cn('text-xs', everyone ? 'text-primary' : 'text-muted-foreground')}>Include other people's</Text>
          </Pressable>
          {loading ? <ActivityIndicator size="small" /> : null}
        </View>
        {error ? <Text className="mt-3 text-sm text-destructive">{error}</Text> : null}
      </View>

      <FlatList
        data={questions}
        keyExtractor={(i) => `${i.messageId}:${i.question.id}`}
        contentContainerStyle={{ paddingHorizontal: 24, paddingVertical: 16, maxWidth: 820, width: '100%', alignSelf: 'center' }}
        ListHeaderComponent={
          showApprovals ? (
            <View className="mb-4 gap-2">
              <Text className="text-xs font-semibold uppercase text-muted-foreground">Approvals waiting on you</Text>
              {approvals.map((a) => (
                <Pressable
                  key={a.messageId}
                  onPress={() => openThread({ conversationId: a.conversationId, messageId: a.messageId })}
                  accessibilityRole="link"
                  className="flex-row items-center gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 px-4 py-3 active:bg-muted/60"
                >
                  <ShieldAlert size={16} className="text-amber-600" />
                  <View className="min-w-0 flex-1">
                    <Text className="text-sm font-medium text-foreground" numberOfLines={1}>{`${a.agentName} wants to run ${a.toolName}`}</Text>
                    <Text className="font-mono text-xs text-muted-foreground" numberOfLines={1}>{a.summary}</Text>
                  </View>
                  <Text className="text-xs text-muted-foreground">{relativeTime(a.createdAt)}</Text>
                </Pressable>
              ))}
            </View>
          ) : null
        }
        ListEmptyComponent={
          !loading ? (
            <Text className="mt-8 text-center text-sm text-muted-foreground">
              {tab === 'open' ? 'No agent is waiting on you.' : 'Questions agents ask you show up here.'}
            </Text>
          ) : null
        }
        renderItem={({ item }) => (
          <View className="mb-4 gap-1" testID="question-row">
            <Pressable onPress={() => openThread(item)} accessibilityRole="link" className="flex-row items-center gap-2">
              <AgentAvatar name={item.agent.name} projectId={item.agent.projectId} workspaceId={workspaceId ?? ''} iconUrl={item.agent.iconUrl} size={20} />
              <Text className="text-sm font-semibold text-foreground">{item.agent.name}</Text>
              <Text className="flex-1 text-xs text-muted-foreground" numberOfLines={1}>{`in ${where(item)}`}</Text>
              <Text className="text-xs text-muted-foreground">{relativeTime(item.question.lastAskedAt ?? item.askedAt)}</Text>
            </Pressable>
            <QuestionCardView
              questions={[item.question]}
              messageId={item.messageId}
              workspaceId={workspaceId ?? undefined}
              me={me}
              names={names}
              canAnswer={item.canAnswer}
              agentName={item.agent.name}
              outlined={false}
              onOpen={() => openThread(item)}
            />
          </View>
        )}
      />
    </View>
  )
}
