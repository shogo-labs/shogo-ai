// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Chat preferences for the active workspace: custom status, Do Not Disturb,
 * default notification level, keyword alerts, quiet hours, email digest, and
 * desktop notification permission.
 */
import { useEffect, useState } from 'react'
import { Platform, Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useActiveWorkspace } from '../../../hooks/useActiveWorkspace'
import { useWorkspaceExperience } from '../../../hooks/useWorkspaceExperience'
import { useChatSettings } from '../../../hooks/useChatPrefs'
import type { NotifyLevel } from '../../../lib/team-chat-api'
import { expiryFrom, type ClearAfter } from '../../../lib/team-chat-state'

const STATUS_PRESETS = [
  { emoji: '📅', text: 'In a meeting', minutes: 60 },
  { emoji: '🚌', text: 'Commuting', minutes: 30 },
  { emoji: '🤒', text: 'Out sick', minutes: 'today' as const },
  { emoji: '🌴', text: 'Vacationing', minutes: null },
  { emoji: '🏡', text: 'Working remotely', minutes: 'today' as const },
]

const CLEAR_AFTER = [
  { label: "Don't clear", value: null },
  { label: '30 minutes', value: 30 },
  { label: '1 hour', value: 60 },
  { label: '4 hours', value: 240 },
  { label: 'Today', value: 'today' as const },
]

const DND_OPTIONS = [
  { label: '30 minutes', value: 30 },
  { label: '1 hour', value: 60 },
  { label: '2 hours', value: 120 },
  { label: 'Until tomorrow', value: 'tomorrow' as const },
]

const LEVELS: Array<{ value: NotifyLevel; label: string; hint: string }> = [
  { value: 'all', label: 'All new messages', hint: 'Every message in channels you’ve joined' },
  { value: 'mentions', label: 'Mentions and keywords', hint: 'DMs, @mentions, @channel, keywords, and threads you follow' },
  { value: 'none', label: 'Nothing', hint: 'Only direct @mentions still reach you' },
]

function localTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null
  } catch {
    return null
  }
}

function formatUntil(iso: string): string {
  const d = new Date(iso)
  const sameDay = d.toDateString() === new Date().toDateString()
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

function Chip({ label, selected, onPress }: { label: string; selected?: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected }}
      onPress={onPress}
      className={cn('rounded-full border px-3 py-1', selected ? 'border-primary bg-primary/10' : 'border-border active:bg-accent/50')}
    >
      <Text className={cn('text-xs', selected ? 'text-primary' : 'text-muted-foreground')}>{label}</Text>
    </Pressable>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View className="mt-6 rounded-lg border border-border p-4">
      <Text className="mb-3 text-sm font-semibold text-foreground">{title}</Text>
      {children}
    </View>
  )
}

function useDesktopPermission(): [string, () => void] {
  const supported = Platform.OS === 'web' && typeof window !== 'undefined' && 'Notification' in window
  const [perm, setPerm] = useState<string>(supported ? Notification.permission : 'unsupported')
  const request = () => {
    if (!supported) return
    void Notification.requestPermission().then(setPerm)
  }
  return [perm, request]
}

export default function TeamChatSettings() {
  const workspace = useActiveWorkspace()
  const experience = useWorkspaceExperience()
  const workspaceId: string | null = experience.kind === 'team' ? workspace?.id ?? null : null
  const { settings, error, saving, update } = useChatSettings(workspaceId)
  const [emoji, setEmoji] = useState('')
  const [text, setText] = useState('')
  const [clearAfter, setClearAfter] = useState<ClearAfter>(null)
  const [keywords, setKeywords] = useState('')
  const [quietStart, setQuietStart] = useState('22:00')
  const [quietEnd, setQuietEnd] = useState('08:00')
  const [perm, requestPerm] = useDesktopPermission()

  useEffect(() => {
    if (!settings) return
    setEmoji(settings.statusEmoji ?? '')
    setText(settings.statusText ?? '')
    setKeywords(settings.keywords.join(', '))
    if (settings.quietHours) {
      const [a, b] = settings.quietHours.split('-')
      setQuietStart(a)
      setQuietEnd(b)
    }
  }, [settings?.statusEmoji, settings?.statusText, settings?.keywords.join(','), settings?.quietHours])

  if (experience.resolved && experience.kind !== 'team') {
    return (
      <View className="flex-1 items-center justify-center bg-background px-8">
        <Text className="text-center text-sm text-muted-foreground">Team chat is available in team workspaces.</Text>
      </View>
    )
  }

  const saveStatus = (next?: { emoji: string; text: string; clear: ClearAfter }) => {
    const e = next?.emoji ?? emoji
    const t = next?.text ?? text
    void update({
      statusEmoji: e.trim() || null,
      statusText: t.trim() || null,
      statusExpiresAt: expiryFrom(next ? next.clear : clearAfter),
    })
  }
  const clearStatus = () => {
    setEmoji('')
    setText('')
    void update({ statusEmoji: null, statusText: null, statusExpiresAt: null })
  }
  const quietOn = !!settings?.quietHours
  const saveQuiet = (on: boolean) => void update({
    quietHours: on ? `${quietStart}-${quietEnd}` : null,
    timezone: localTimezone(),
  })
  const quietValid = /^([01]\d|2[0-3]):[0-5]\d$/.test(quietStart) && /^([01]\d|2[0-3]):[0-5]\d$/.test(quietEnd)

  return (
    <ScrollView className="flex-1 bg-background" contentContainerStyle={{ paddingBottom: 48 }}>
      <View className="w-full self-center px-6 pt-6" style={{ maxWidth: 720 }}>
        <View className="flex-row items-center">
          <Text className="flex-1 text-2xl font-semibold text-foreground">Chat preferences</Text>
          {saving ? <Text className="text-xs text-muted-foreground">Saving…</Text> : null}
        </View>
        {error ? <Text className="mt-2 text-sm text-destructive">{error}</Text> : null}

        <Card title="Status">
          <View className="flex-row items-center gap-2">
            <TextInput
              value={emoji}
              onChangeText={(v) => setEmoji(v.slice(0, 8))}
              placeholder="🙂"
              placeholderTextColor="#8a8a8a"
              accessibilityLabel="Status emoji"
              className="w-14 rounded-md border border-border px-2 py-2 text-center text-base text-foreground"
            />
            <TextInput
              value={text}
              onChangeText={(v) => setText(v.slice(0, 100))}
              placeholder="What's your status?"
              placeholderTextColor="#8a8a8a"
              accessibilityLabel="Status text"
              className="flex-1 rounded-md border border-border px-3 py-2 text-sm text-foreground"
              onSubmitEditing={() => saveStatus()}
            />
          </View>
          <View className="mt-3 flex-row flex-wrap gap-2">
            {STATUS_PRESETS.map((p) => (
              <Chip
                key={p.text}
                label={`${p.emoji} ${p.text}`}
                selected={settings?.statusText === p.text}
                onPress={() => {
                  setEmoji(p.emoji)
                  setText(p.text)
                  setClearAfter(p.minutes)
                  saveStatus({ emoji: p.emoji, text: p.text, clear: p.minutes })
                }}
              />
            ))}
          </View>
          <Text className="mb-2 mt-4 text-xs font-medium text-muted-foreground">Clear after</Text>
          <View className="flex-row flex-wrap gap-2">
            {CLEAR_AFTER.map((c) => (
              <Chip key={c.label} label={c.label} selected={clearAfter === c.value} onPress={() => setClearAfter(c.value)} />
            ))}
          </View>
          <View className="mt-4 flex-row items-center gap-2">
            <Pressable accessibilityRole="button" onPress={() => saveStatus()} className="rounded-md bg-primary px-3 py-1.5 active:opacity-80">
              <Text className="text-xs font-semibold text-primary-foreground">Save status</Text>
            </Pressable>
            {settings?.statusEmoji || settings?.statusText ? (
              <Pressable accessibilityRole="button" onPress={clearStatus} className="rounded-md px-3 py-1.5 active:bg-accent/50">
                <Text className="text-xs text-muted-foreground">Clear status</Text>
              </Pressable>
            ) : null}
            {settings?.statusExpiresAt ? (
              <Text className="text-xs text-muted-foreground">Clears at {formatUntil(settings.statusExpiresAt)}</Text>
            ) : null}
          </View>
        </Card>

        <Card title="Do Not Disturb">
          <Text className="mb-3 text-xs text-muted-foreground">
            {settings?.dndUntil
              ? `Notifications are paused until ${formatUntil(settings.dndUntil)}. Everything still lands in your inbox.`
              : 'Pause alerts for a while. Everything still lands in your inbox.'}
          </Text>
          <View className="flex-row flex-wrap gap-2">
            {DND_OPTIONS.map((o) => (
              <Chip key={o.label} label={o.label} onPress={() => void update({ dndUntil: expiryFrom(o.value) })} />
            ))}
            {settings?.dndUntil ? <Chip label="Resume notifications" selected onPress={() => void update({ dndUntil: null })} /> : null}
          </View>
        </Card>

        <Card title="Notify me about">
          {LEVELS.map((l) => {
            const selected = settings?.notifyDefault === l.value
            return (
              <Pressable
                key={l.value}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected }}
                onPress={() => void update({ notifyDefault: l.value })}
                className="mb-2 flex-row items-center gap-3 rounded-md px-1 py-1 active:bg-accent/50"
              >
                <View className={cn('h-4 w-4 items-center justify-center rounded-full border', selected ? 'border-primary' : 'border-border')}>
                  {selected ? <View className="h-2 w-2 rounded-full bg-primary" /> : null}
                </View>
                <View className="flex-1">
                  <Text className="text-sm text-foreground">{l.label}</Text>
                  <Text className="text-xs text-muted-foreground">{l.hint}</Text>
                </View>
              </Pressable>
            )
          })}
          <Text className="mt-2 text-xs text-muted-foreground">Each channel can override this from its header.</Text>

          <Text className="mb-2 mt-4 text-xs font-medium text-muted-foreground">Keywords (comma separated)</Text>
          <TextInput
            value={keywords}
            onChangeText={setKeywords}
            onBlur={() => void update({ keywords: keywords.split(',').map((k) => k.trim()).filter(Boolean) })}
            placeholder="deploy, outage, my-project"
            placeholderTextColor="#8a8a8a"
            accessibilityLabel="Notification keywords"
            className="rounded-md border border-border px-3 py-2 text-sm text-foreground"
          />
        </Card>

        <Card title="Quiet hours">
          <View className="flex-row items-center gap-3">
            <Switch value={quietOn} onValueChange={(on) => saveQuiet(on)} disabled={!quietValid} accessibilityLabel="Quiet hours" />
            <TextInput
              value={quietStart}
              onChangeText={setQuietStart}
              onBlur={() => quietOn && quietValid && saveQuiet(true)}
              accessibilityLabel="Quiet hours start"
              className="w-20 rounded-md border border-border px-2 py-1.5 text-center text-sm text-foreground"
            />
            <Text className="text-xs text-muted-foreground">to</Text>
            <TextInput
              value={quietEnd}
              onChangeText={setQuietEnd}
              onBlur={() => quietOn && quietValid && saveQuiet(true)}
              accessibilityLabel="Quiet hours end"
              className="w-20 rounded-md border border-border px-2 py-1.5 text-center text-sm text-foreground"
            />
          </View>
          <Text className="mt-2 text-xs text-muted-foreground">
            No alerts during these hours every day{settings?.timezone ? ` (${settings.timezone})` : ''}.
          </Text>
        </Card>

        <Card title="Email">
          <View className="flex-row items-center gap-3">
            <Switch
              value={settings?.emailDigest === 'daily'}
              onValueChange={(on) => void update({ emailDigest: on ? 'daily' : 'off', timezone: settings?.timezone ?? localTimezone() })}
              accessibilityLabel="Daily email digest"
            />
            <Text className="flex-1 text-sm text-foreground">Send me a daily digest of unread mentions and DMs at 9am</Text>
          </View>
        </Card>

        {Platform.OS === 'web' ? (
          <Card title="Desktop notifications">
            <View className="flex-row items-center gap-3">
              <Text className="flex-1 text-xs text-muted-foreground">
                {perm === 'granted'
                  ? 'Desktop notifications are on for this browser.'
                  : perm === 'denied'
                    ? 'Notifications are blocked. Allow them in your browser’s site settings.'
                    : perm === 'unsupported'
                      ? 'This browser doesn’t support notifications.'
                      : 'Get an alert for mentions and DMs while this tab is in the background.'}
              </Text>
              {perm === 'default' ? (
                <Pressable accessibilityRole="button" onPress={requestPerm} className="rounded-md bg-primary px-3 py-1.5 active:opacity-80">
                  <Text className="text-xs font-semibold text-primary-foreground">Enable</Text>
                </Pressable>
              ) : null}
            </View>
          </Card>
        ) : null}
      </View>
    </ScrollView>
  )
}
