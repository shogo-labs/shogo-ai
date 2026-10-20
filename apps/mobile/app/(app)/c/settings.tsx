// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Chat preferences for the active workspace: custom status, Do Not Disturb,
 * default notification level, keyword alerts, quiet hours, email digest, and
 * desktop notification permission.
 */
import { useEffect, useState } from 'react'
import { Platform, Pressable, ScrollView, Switch, Text, TextInput, View, useWindowDimensions } from 'react-native'
import { useRouter } from 'expo-router'
import { ArrowLeft } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useActiveWorkspace } from '../../../hooks/useActiveWorkspace'
import { useWorkspaceExperience } from '../../../hooks/useWorkspaceExperience'
import { useChatSettings } from '../../../hooks/useChatPrefs'
import { useMentionables } from '../../../hooks/useTeamChat'
import { useCustomEmojiFeed } from '../../../hooks/useCustomEmoji'
import { CustomEmojiCard, UserGroupsCard } from '../../../components/team-chat/WorkspaceChatAdmin'
import type { HuddleSound, MessageSound, MobilePushDelay, NotifyLevel } from '../../../lib/team-chat-api'
import { previewMessageSound } from '../../../lib/notification-sound'
import { previewHuddleSound } from '../../../lib/huddle-ringtone'
import { readDeviceAlertPrefs, writeDeviceAlertPrefs, type DeviceAlertPrefs, type DockBounce } from '../../../lib/notifications/device-alert-prefs'
import {
  getAnnounceHuddleCalls,
  setAnnounceHuddleCallsPreference,
  subscribeAnnounceHuddleCalls,
} from '../../../lib/notifications/huddle-call-prefs'
import { expiryFrom, type ClearAfter } from '../../../lib/team-chat-state'
import { leaveChatPreferences } from '../../../lib/settings-back'
import { WEB_WIDE_MIN_WIDTH } from '../../../lib/native-phone-layout'

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

const MESSAGE_SOUNDS: Array<{ value: MessageSound; label: string }> = [
  { value: 'default', label: 'Default' },
  { value: 'subtle', label: 'Subtle' },
  { value: 'off', label: 'Off' },
]

const HUDDLE_SOUNDS: Array<{ value: HuddleSound; label: string }> = [
  { value: 'ring', label: 'Ring' },
  { value: 'chime', label: 'Chime' },
  { value: 'off', label: 'Off' },
]

const PUSH_DELAYS: Array<{ value: MobilePushDelay; label: string }> = [
  { value: 'immediate', label: 'Right away' },
  { value: 'inactive', label: 'When I’m away' },
  { value: 'inactive_5m', label: 'Away for 5 minutes' },
  { value: 'inactive_10m', label: 'Away for 10 minutes' },
]

const DOCK_BOUNCE: Array<{ value: DockBounce; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'once', label: 'Once' },
  { value: 'until-focused', label: 'Until I look' },
]

/** True inside the Electron desktop app, where dock and taskbar alerts exist. */
function isDesktopApp(): boolean {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return false
  return !!(window as unknown as { shogoDesktop?: { isDesktop?: boolean } }).shogoDesktop?.isDesktop
}

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

/** iPhone only: whether incoming huddles take over the call screen. Stored on this phone. */
function AnnounceHuddleCallsRow() {
  const [announce, setAnnounce] = useState<boolean>(() => getAnnounceHuddleCalls())
  useEffect(() => subscribeAnnounceHuddleCalls(setAnnounce), [])
  return (
    <View className="mt-4 border-t border-border pt-4">
      <Text className="mb-1 text-sm text-foreground">This iPhone</Text>
      <View className="flex-row items-center gap-3">
        <Switch
          value={announce}
          onValueChange={(on) => void setAnnounceHuddleCallsPreference(on)}
          accessibilityLabel="Announce huddle calls"
        />
        <View className="flex-1">
          <Text className="text-sm text-foreground">Announce huddle calls</Text>
          <Text className="text-xs text-muted-foreground">
            Show incoming huddles on the call screen, even when the app is closed. Off, this phone gets the normal alert instead.
          </Text>
        </View>
      </View>
    </View>
  )
}

function useDeviceAlertPrefs(): [DeviceAlertPrefs, (patch: Partial<DeviceAlertPrefs>) => void] {
  const [prefs, setPrefs] = useState<DeviceAlertPrefs>(() => readDeviceAlertPrefs())
  const save = (patch: Partial<DeviceAlertPrefs>) => setPrefs(writeDeviceAlertPrefs(patch))
  return [prefs, save]
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
  const router = useRouter()
  const { width } = useWindowDimensions()
  // Wide web shows the app sidebar beside this page (see `(app)/_layout.tsx`).
  const inAppShell = Platform.OS === 'web' && width >= WEB_WIDE_MIN_WIDTH
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
  const [deviceAlerts, saveDeviceAlerts] = useDeviceAlertPrefs()
  const mentionables = useMentionables(workspaceId)
  useCustomEmojiFeed(workspaceId)

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
        {inAppShell ? null : (
          <Pressable
            onPress={() => leaveChatPreferences(router)}
            hitSlop={8}
            className="-ml-2 mb-3 h-9 w-9 items-center justify-center rounded-full border border-border bg-background active:bg-muted"
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <ArrowLeft size={20} className="text-foreground" />
          </Pressable>
        )}
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

        <Card title="Sounds">
          <Text className="mb-2 text-xs font-medium text-muted-foreground">Message sound</Text>
          <View className="flex-row flex-wrap items-center gap-2">
            {MESSAGE_SOUNDS.map((s) => (
              <Chip
                key={s.value}
                label={s.label}
                selected={(settings?.messageSound ?? 'default') === s.value}
                onPress={() => void update({ messageSound: s.value })}
              />
            ))}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Preview message sound"
              disabled={(settings?.messageSound ?? 'default') === 'off'}
              onPress={() => previewMessageSound(settings?.messageSound ?? 'default')}
              className="rounded-md px-3 py-1.5 active:bg-accent/50 disabled:opacity-40"
            >
              <Text className="text-xs font-semibold text-primary">Preview</Text>
            </Pressable>
          </View>
          <Text className="mt-2 text-xs text-muted-foreground">
            Plays in the browser and desktop app when a new message arrives in this workspace, even if banners are off.
            Phones use their system sound.
          </Text>

          <Text className="mb-2 mt-4 text-xs font-medium text-muted-foreground">Huddle sound</Text>
          <View className="flex-row flex-wrap items-center gap-2">
            {HUDDLE_SOUNDS.map((s) => (
              <Chip
                key={s.value}
                label={s.label}
                selected={(settings?.huddleSound ?? 'ring') === s.value}
                onPress={() => void update({ huddleSound: s.value })}
              />
            ))}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Preview huddle sound"
              disabled={(settings?.huddleSound ?? 'ring') === 'off'}
              onPress={() => previewHuddleSound(settings?.huddleSound ?? 'ring')}
              className="rounded-md px-3 py-1.5 active:bg-accent/50 disabled:opacity-40"
            >
              <Text className="text-xs font-semibold text-primary">Preview</Text>
            </Pressable>
          </View>
          <Text className="mt-2 text-xs text-muted-foreground">
            A direct call rings until it’s answered. A group huddle rings once. Off means no sound and no vibration.
          </Text>

          {Platform.OS === 'ios' ? <AnnounceHuddleCallsRow /> : null}
        </Card>

        <Card title="Activity">
          <View className="flex-row items-center gap-3">
            <Switch
              value={!!settings?.dmInActivity}
              onValueChange={(on) => void update({ dmInActivity: on })}
              accessibilityLabel="Show direct messages in Activity"
            />
            <View className="flex-1">
              <Text className="text-sm text-foreground">Show direct messages in Activity</Text>
              <Text className="text-xs text-muted-foreground">Every new direct message also shows up in your Activity list, not just the DMs count.</Text>
            </View>
          </View>
          <View className="mt-4 flex-row items-center gap-3">
            <Switch
              value={settings?.threadRepliesInBadge ?? true}
              onValueChange={(on) => void update({ threadRepliesInBadge: on })}
              accessibilityLabel="Count thread replies in the badge"
            />
            <View className="flex-1">
              <Text className="text-sm text-foreground">Count thread replies in the badge</Text>
              <Text className="text-xs text-muted-foreground">Off: thread replies show as a dot on Activity instead of a number.</Text>
            </View>
          </View>
        </Card>

        <Card title="Phone notifications">
          <Text className="mb-2 text-xs font-medium text-muted-foreground">Send a push to my phone</Text>
          <View className="flex-row flex-wrap gap-2">
            {PUSH_DELAYS.map((d) => (
              <Chip
                key={d.value}
                label={d.label}
                selected={(settings?.mobilePushDelay ?? 'inactive') === d.value}
                onPress={() => void update({ mobilePushDelay: d.value })}
              />
            ))}
          </View>
          <Text className="mt-2 text-xs text-muted-foreground">
            A push is cancelled if you read the conversation before it is sent.
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

        {workspaceId ? (
          <>
            <Text className="mt-10 text-lg font-semibold text-foreground">Workspace</Text>
            <Text className="text-xs text-muted-foreground">Shared with everyone in {workspace?.name ?? 'this workspace'}.</Text>
            <Card title="User groups">
              <UserGroupsCard workspaceId={workspaceId} mentionables={mentionables} />
            </Card>
            <Card title="Custom emoji">
              <CustomEmojiCard workspaceId={workspaceId} />
            </Card>
          </>
        ) : null}

        {Platform.OS === 'web' ? (
          <Card title="Desktop notifications">
            <View className="flex-row items-center gap-3">
              {perm === 'denied' ? (
                <View testID="desktop-alerts-blocked" className="rounded-full bg-destructive/10 px-2 py-0.5">
                  <Text className="text-xs font-medium text-destructive">Desktop alerts blocked</Text>
                </View>
              ) : null}
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
            {isDesktopApp() ? (
              <View className="mt-4 border-t border-border pt-4">
                <Text className="mb-1 text-sm text-foreground">This computer</Text>
                <Text className="mb-2 text-xs text-muted-foreground">Stored on this device only.</Text>
                <Text className="mb-2 text-xs font-medium text-muted-foreground">Bounce dock icon on a new message</Text>
                <View className="flex-row flex-wrap gap-2">
                  {DOCK_BOUNCE.map((o) => (
                    <Chip key={o.value} label={o.label} selected={deviceAlerts.dockBounce === o.value} onPress={() => saveDeviceAlerts({ dockBounce: o.value })} />
                  ))}
                </View>
                <View className="mt-4 flex-row items-center gap-3">
                  <Switch
                    value={deviceAlerts.flashTaskbar}
                    onValueChange={(on) => saveDeviceAlerts({ flashTaskbar: on })}
                    accessibilityLabel="Flash taskbar on a new message"
                  />
                  <Text className="flex-1 text-sm text-foreground">Flash the taskbar button on Windows</Text>
                </View>
              </View>
            ) : null}
          </Card>
        ) : null}
      </View>
    </ScrollView>
  )
}
