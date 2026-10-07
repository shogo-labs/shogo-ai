// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pick who to message: teammates and agents in one searchable list.
 *
 * - Tapping an agent opens the DM straight away (agent DMs are one-to-one).
 * - Teammates are multi-selected and started together, so a group message is
 *   just several people checked.
 *
 * Rendered inside `NewConversationModal` on wide screens and inside the
 * full-screen `/c/new` route on phones.
 */
import { useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { Check } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { teamChatApi, type ConversationSummary, type Mentionables } from '../../lib/team-chat-api'
import { AgentAvatar } from './AgentAvatar'
import { PresenceDot } from './PresenceDot'

export type NewMessageFilter = 'all' | 'people' | 'agents'

export interface NewMessagePickerProps {
  workspaceId: string
  mentionables: Mentionables | null
  me: string | null
  /** Which recipients to list first. Defaults to everyone. */
  initialFilter?: NewMessageFilter
  autoFocus?: boolean
  /** Class for the root; use `flex-1` when the parent has a fixed height (the phone screen). */
  className?: string
  /** Class for the scrolling list, e.g. a max height inside a modal. Defaults to filling the space. */
  listClassName?: string
  onCreated: (conversation: ConversationSummary) => void
}

const FILTERS: Array<{ id: NewMessageFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'people', label: 'People' },
  { id: 'agents', label: 'Agents' },
]

export function filterRecipients(mentionables: Mentionables | null, me: string | null, query: string) {
  const q = query.trim().toLowerCase()
  const people = (mentionables?.people ?? []).filter(
    (p) => p.id !== me && (!q || p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q)),
  )
  const agents = (mentionables?.agents ?? []).filter(
    (a) => !q || a.name.toLowerCase().includes(q) || (a.description ?? '').toLowerCase().includes(q),
  )
  return { people, agents }
}

export function NewMessagePicker({
  workspaceId,
  mentionables,
  me,
  initialFilter = 'all',
  autoFocus,
  className = 'min-h-0 flex-shrink',
  listClassName = 'flex-1',
  onCreated,
}: NewMessagePickerProps) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<NewMessageFilter>(initialFilter)
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { people, agents } = filterRecipients(mentionables, me, query)
  const showPeople = filter !== 'agents'
  const showAgents = filter !== 'people'

  const submit = async (fn: () => Promise<ConversationSummary>) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      onCreated(await fn())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
  const empty = (!showPeople || !people.length) && (!showAgents || !agents.length)

  return (
    <View className={className} testID="new-message-picker">
      <TextInput
        value={query}
        onChangeText={setQuery}
        autoFocus={autoFocus}
        placeholder="Search people and agents"
        placeholderTextColor="#8a8a8a"
        accessibilityLabel="Search people and agents"
        className="mb-2 rounded-md border border-border px-3 py-2.5 text-base text-foreground"
      />

      <View className="mb-2 flex-row gap-1.5" accessibilityRole="tablist">
        {FILTERS.map((f) => (
          <Pressable
            key={f.id}
            accessibilityRole="tab"
            accessibilityState={{ selected: filter === f.id }}
            aria-selected={filter === f.id}
            onPress={() => setFilter(f.id)}
            className={cn('rounded-full px-3 py-1', filter === f.id ? 'bg-primary' : 'bg-muted active:bg-muted/70')}
          >
            <Text className={cn('text-xs font-medium', filter === f.id ? 'text-primary-foreground' : 'text-muted-foreground')}>{f.label}</Text>
          </Pressable>
        ))}
      </View>

      <ScrollView className={listClassName} keyboardShouldPersistTaps="handled">
        {showPeople && people.length > 0 && (
          <>
            {filter === 'all' && <SectionLabel>People</SectionLabel>}
            {people.map((p) => {
              const on = selected.includes(p.id)
              return (
                <Pressable
                  key={p.id}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={`${p.name}, ${p.email}`}
                  onPress={() => toggle(p.id)}
                  className="min-h-12 flex-row items-center gap-3 rounded-md px-2 py-2 active:bg-muted hover:bg-muted"
                >
                  <View className={cn('h-5 w-5 items-center justify-center rounded border', on ? 'border-primary bg-primary' : 'border-border')}>
                    {on && <Check size={13} className="text-primary-foreground" />}
                  </View>
                  <View className="w-3.5 items-center">
                    <PresenceDot userId={p.id} workspaceId={workspaceId} />
                  </View>
                  <View className="min-w-0 flex-1">
                    <Text className="text-sm text-foreground" numberOfLines={1}>{p.name}</Text>
                    <Text className="text-xs text-muted-foreground" numberOfLines={1}>{p.email}</Text>
                  </View>
                </Pressable>
              )
            })}
          </>
        )}

        {showAgents && agents.length > 0 && (
          <>
            {filter === 'all' && <SectionLabel>Agents</SectionLabel>}
            {agents.map((a) => (
              <Pressable
                key={a.key}
                accessibilityRole="button"
                accessibilityLabel={`${a.name}, agent`}
                disabled={busy}
                onPress={() => void submit(() => teamChatApi().openAgentDm(workspaceId, a.projectId))}
                className="min-h-12 flex-row items-center gap-3 rounded-md px-2 py-2 active:bg-muted hover:bg-muted"
              >
                <AgentAvatar name={a.name} projectId={a.projectId} workspaceId={workspaceId} iconUrl={a.image} size={26} />
                <View className="min-w-0 flex-1">
                  <Text className="text-sm text-foreground" numberOfLines={1}>{a.name}</Text>
                  {a.description ? <Text className="text-xs text-muted-foreground" numberOfLines={1}>{a.description}</Text> : null}
                </View>
              </Pressable>
            ))}
          </>
        )}

        {empty && (
          <Text className="px-2 py-4 text-sm text-muted-foreground">
            {filter === 'agents' ? 'No agents match.' : filter === 'people' ? 'No teammates match.' : 'No people or agents match.'}
          </Text>
        )}
      </ScrollView>

      {selected.length > 0 && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={selected.length > 1 ? `Start group message (${selected.length})` : 'Start message'}
          disabled={busy}
          onPress={() => void submit(() => teamChatApi().openDm(workspaceId, selected))}
          className="mt-3 items-center rounded-md bg-primary py-3"
        >
          {busy ? (
            <ActivityIndicator size="small" />
          ) : (
            <Text className="text-sm font-medium text-primary-foreground">
              {selected.length > 1 ? `Start group message (${selected.length})` : 'Start message'}
            </Text>
          )}
        </Pressable>
      )}
      {error && <Text className="mt-2 text-xs text-destructive">{error}</Text>}
    </View>
  )
}

function SectionLabel({ children }: { children: string }) {
  return <Text className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{children}</Text>
}
