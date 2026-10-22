// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Chat preferences, as a Settings tab: custom status, Do Not Disturb, default
 * notification level, keyword alerts, quiet hours, sounds, email digest and
 * desktop notification permission for the active workspace.
 *
 * It draws no page chrome — the Settings page and the native Account sheet
 * both render their own title and scroll container — so the same component
 * works on web, desktop and phone. `/c/settings` redirects here.
 */
import { useEffect, useState } from 'react'
import { Platform, Pressable, View } from 'react-native'
import { Check } from 'lucide-react-native'
import {
  Button,
  Card,
  CardContent,
  Switch,
  cn,
} from '@shogo/shared-ui/primitives'
import { Text, TextInput } from './account-sheet-chrome'
import { useResolvedTheme } from '../../contexts/theme'
import { SURFACE_COLORS } from '../../lib/surface-tokens'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { useWorkspaceExperience } from '../../hooks/useWorkspaceExperience'
import { useChatSettings } from '../../hooks/useChatPrefs'
import { useMentionables } from '../../hooks/useTeamChat'
import { useCustomEmojiFeed } from '../../hooks/useCustomEmoji'
import { CustomEmojiCard, UserGroupsCard } from '../team-chat/WorkspaceChatAdmin'
import type { HuddleSound, MessageSound, MobilePushDelay, NotifyLevel } from '../../lib/team-chat-api'
import { previewMessageSound } from '../../lib/notification-sound'
import { previewHuddleSound } from '../../lib/huddle-ringtone'
import {
  readDeviceAlertPrefs,
  writeDeviceAlertPrefs,
  type DeviceAlertPrefs,
  type DockBounce,
} from '../../lib/notifications/device-alert-prefs'
import {
  getAnnounceHuddleCalls,
  setAnnounceHuddleCallsPreference,
  subscribeAnnounceHuddleCalls,
} from '../../lib/notifications/huddle-call-prefs'
import { expiryFrom, type ClearAfter } from '../../lib/team-chat-state'

const STATUS_PRESETS = [
  { emoji: '📅', text: 'In a meeting', minutes: 60 },
  { emoji: '🚌', text: 'Commuting', minutes: 30 },
  { emoji: '🤒', text: 'Out sick', minutes: 'today' as const },
  { emoji: '🌴', text: 'Vacationing', minutes: null },
  { emoji: '🏡', text: 'Working remotely', minutes: 'today' as const },
]

const CLEAR_AFTER: Array<{ label: string; value: ClearAfter }> = [
  { label: "Don't clear", value: null },
  { label: '30 minutes', value: 30 },
  { label: '1 hour', value: 60 },
  { label: '4 hours', value: 240 },
  { label: 'Today', value: 'today' },
]

const DND_OPTIONS: Array<{ label: string; value: ClearAfter }> = [
  { label: '30 minutes', value: 30 },
  { label: '1 hour', value: 60 },
  { label: '2 hours', value: 120 },
  { label: 'Until tomorrow', value: 'tomorrow' },
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

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <Text className="mb-2 mt-5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </Text>
  )
}

function Section({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <View>
      <SectionTitle>{title}</SectionTitle>
      <Card>
        <CardContent className="p-4 gap-2">
          {description ? (
            <Text className="mb-1 text-xs text-muted-foreground">{description}</Text>
          ) : null}
          {children}
        </CardContent>
      </Card>
    </View>
  )
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return <Text className="mb-1 mt-2 text-xs font-medium text-muted-foreground">{children}</Text>
}

/** One option of a single-choice group: a radio row, checked shows the tick. */
function ChoiceRow({
  label,
  hint,
  checked,
  onPress,
  testID,
}: {
  label: string
  hint?: string
  checked: boolean
  onPress: () => void
  testID?: string
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ checked }}
      onPress={onPress}
      className={cn(
        'flex-row items-center gap-3 rounded-lg border px-3 py-2',
        checked ? 'border-primary bg-primary/5' : 'border-border active:bg-muted/50',
      )}
    >
      <View className="flex-1">
        <Text className="text-sm text-foreground">{label}</Text>
        {hint ? <Text className="mt-0.5 text-xs text-muted-foreground">{hint}</Text> : null}
      </View>
      {checked ? <Check size={14} className="text-primary" /> : null}
    </Pressable>
  )
}

function SwitchRow({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string
  description?: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}) {
  return (
    <View className="flex-row items-center gap-3 rounded-lg border border-border bg-muted/30 px-4 py-3">
      <View className="flex-1">
        <Text className="text-sm font-medium text-foreground">{label}</Text>
        {description ? (
          <Text className="mt-0.5 text-xs text-muted-foreground">{description}</Text>
        ) : null}
      </View>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </View>
  )
}

/** iPhone only: whether incoming huddles take over the call screen. Stored on this phone. */
function AnnounceHuddleCallsRow() {
  const [announce, setAnnounce] = useState<boolean>(() => getAnnounceHuddleCalls())
  useEffect(() => subscribeAnnounceHuddleCalls(setAnnounce), [])
  return (
    <View className="mt-2 border-t border-border pt-4">
      <Text className="mb-1 text-sm text-foreground">This iPhone</Text>
      <SwitchRow
        label="Announce huddle calls"
        description="Show incoming huddles on the call screen, even when the app is closed. Off, this phone gets the normal alert instead."
        checked={announce}
        onChange={(on) => void setAnnounceHuddleCallsPreference(on)}
      />
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

export function ChatPreferencesTab() {
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
  const placeholderTextColor = SURFACE_COLORS[useResolvedTheme()].onSurfaceMuted

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
      <View className="flex-1 items-center justify-center bg-background px-8 py-12">
        <Text className="text-center text-sm text-muted-foreground">
          Team chat is available in team workspaces.
        </Text>
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
  const messageSound = settings?.messageSound ?? 'default'
  const huddleSound = settings?.huddleSound ?? 'ring'

  return (
    <View>
      {saving || error ? (
        <View className="mb-1 flex-row items-center gap-2">
          {saving ? <Text className="text-xs text-muted-foreground">Saving…</Text> : null}
          {error ? <Text className="text-sm text-destructive">{error}</Text> : null}
        </View>
      ) : null}

      <Section title="Status">
        <View className="flex-row items-center gap-2">
          <TextInput
            value={emoji}
            onChangeText={(v) => setEmoji(v.slice(0, 8))}
            placeholder="🙂"
            placeholderTextColor={placeholderTextColor}
            accessibilityLabel="Status emoji"
            className="w-14 rounded-md border border-border bg-background px-2 py-2 text-center text-base text-foreground"
          />
          <TextInput
            value={text}
            onChangeText={(v) => setText(v.slice(0, 100))}
            placeholder="What's your status?"
            placeholderTextColor={placeholderTextColor}
            accessibilityLabel="Status text"
            className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
            onSubmitEditing={() => saveStatus()}
          />
        </View>
        <View className="mt-1 flex-row flex-wrap gap-2">
          {STATUS_PRESETS.map((p) => (
            <Button
              key={p.text}
              variant="outline"
              size="sm"
              onPress={() => {
                setEmoji(p.emoji)
                setText(p.text)
                setClearAfter(p.minutes)
                saveStatus({ emoji: p.emoji, text: p.text, clear: p.minutes })
              }}
            >
              {`${p.emoji} ${p.text}`}
            </Button>
          ))}
        </View>
        <GroupLabel>Clear after</GroupLabel>
        {CLEAR_AFTER.map((c) => (
          <ChoiceRow
            key={c.label}
            label={c.label}
            checked={clearAfter === c.value}
            onPress={() => setClearAfter(c.value)}
            testID={`chat-clear-after-${c.label}`}
          />
        ))}
        <View className="mt-2 flex-row flex-wrap items-center gap-2">
          <Button size="sm" onPress={() => saveStatus()}>
            Save status
          </Button>
          {settings?.statusEmoji || settings?.statusText ? (
            <Button size="sm" variant="ghost" onPress={clearStatus}>
              Clear status
            </Button>
          ) : null}
          {settings?.statusExpiresAt ? (
            <Text className="text-xs text-muted-foreground">
              Clears at {formatUntil(settings.statusExpiresAt)}
            </Text>
          ) : null}
        </View>
      </Section>

      <Section
        title="Do Not Disturb"
        description={
          settings?.dndUntil
            ? `Notifications are paused until ${formatUntil(settings.dndUntil)}. Everything still lands in your inbox.`
            : 'Pause alerts for a while. Everything still lands in your inbox.'
        }
      >
        {DND_OPTIONS.map((o) => (
          <ChoiceRow
            key={o.label}
            label={o.label}
            checked={false}
            onPress={() => void update({ dndUntil: expiryFrom(o.value) })}
            testID={`chat-dnd-${o.label}`}
          />
        ))}
        {settings?.dndUntil ? (
          <Button size="sm" variant="outline" onPress={() => void update({ dndUntil: null })}>
            Resume notifications
          </Button>
        ) : null}
      </Section>

      <Section title="Notify me about">
        {LEVELS.map((l) => (
          <ChoiceRow
            key={l.value}
            label={l.label}
            hint={l.hint}
            checked={settings?.notifyDefault === l.value}
            onPress={() => void update({ notifyDefault: l.value })}
            testID={`chat-notify-${l.value}`}
          />
        ))}
        <Text className="mt-1 text-xs text-muted-foreground">
          Each channel can override this from its header.
        </Text>

        <GroupLabel>Keywords (comma separated)</GroupLabel>
        <TextInput
          value={keywords}
          onChangeText={setKeywords}
          onBlur={() => void update({ keywords: keywords.split(',').map((k) => k.trim()).filter(Boolean) })}
          placeholder="deploy, outage, my-project"
          placeholderTextColor={placeholderTextColor}
          accessibilityLabel="Notification keywords"
          className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
        />
      </Section>

      <Section title="Quiet hours">
        <View className="flex-row items-center gap-3">
          <Switch
            checked={quietOn}
            onCheckedChange={(on) => saveQuiet(on)}
            disabled={!quietValid}
          />
          <TextInput
            value={quietStart}
            onChangeText={setQuietStart}
            onBlur={() => quietOn && quietValid && saveQuiet(true)}
            accessibilityLabel="Quiet hours start"
            className="w-20 rounded-md border border-border bg-background px-2 py-1.5 text-center text-sm text-foreground"
          />
          <Text className="text-xs text-muted-foreground">to</Text>
          <TextInput
            value={quietEnd}
            onChangeText={setQuietEnd}
            onBlur={() => quietOn && quietValid && saveQuiet(true)}
            accessibilityLabel="Quiet hours end"
            className="w-20 rounded-md border border-border bg-background px-2 py-1.5 text-center text-sm text-foreground"
          />
        </View>
        <Text className="text-xs text-muted-foreground">
          No alerts during these hours every day{settings?.timezone ? ` (${settings.timezone})` : ''}.
        </Text>
      </Section>

      <Section title="Sounds">
        <GroupLabel>Message sound</GroupLabel>
        {MESSAGE_SOUNDS.map((s) => (
          <ChoiceRow
            key={s.value}
            label={s.label}
            checked={messageSound === s.value}
            onPress={() => void update({ messageSound: s.value })}
            testID={`chat-message-sound-${s.value}`}
          />
        ))}
        <View className="flex-row items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={messageSound === 'off'}
            accessibilityLabel="Preview message sound"
            onPress={() => previewMessageSound(messageSound)}
          >
            Preview
          </Button>
          <Text className="flex-1 text-xs text-muted-foreground">
            Plays in the browser and desktop app when a new message arrives in this workspace, even if
            banners are off. Phones use their system sound.
          </Text>
        </View>

        <GroupLabel>Huddle sound</GroupLabel>
        {HUDDLE_SOUNDS.map((s) => (
          <ChoiceRow
            key={s.value}
            label={s.label}
            checked={huddleSound === s.value}
            onPress={() => void update({ huddleSound: s.value })}
            testID={`chat-huddle-sound-${s.value}`}
          />
        ))}
        <View className="flex-row items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={huddleSound === 'off'}
            accessibilityLabel="Preview huddle sound"
            onPress={() => previewHuddleSound(huddleSound)}
          >
            Preview
          </Button>
          <Text className="flex-1 text-xs text-muted-foreground">
            A direct call rings until it’s answered. A group huddle rings once. Off means no sound and no
            vibration.
          </Text>
        </View>

        {Platform.OS === 'ios' ? <AnnounceHuddleCallsRow /> : null}
      </Section>

      <Section title="Activity">
        <SwitchRow
          label="Show direct messages in Activity"
          description="Every new direct message also shows up in your Activity list, not just the DMs count."
          checked={!!settings?.dmInActivity}
          onChange={(on) => void update({ dmInActivity: on })}
        />
        <SwitchRow
          label="Count thread replies in the badge"
          description="Off: thread replies show as a dot on Activity instead of a number."
          checked={settings?.threadRepliesInBadge ?? true}
          onChange={(on) => void update({ threadRepliesInBadge: on })}
        />
      </Section>

      <Section title="Phone notifications">
        <GroupLabel>Send a push to my phone</GroupLabel>
        {PUSH_DELAYS.map((d) => (
          <ChoiceRow
            key={d.value}
            label={d.label}
            checked={(settings?.mobilePushDelay ?? 'inactive') === d.value}
            onPress={() => void update({ mobilePushDelay: d.value })}
            testID={`chat-push-delay-${d.value}`}
          />
        ))}
        <Text className="text-xs text-muted-foreground">
          A push is cancelled if you read the conversation before it is sent.
        </Text>
      </Section>

      <Section title="Email">
        <SwitchRow
          label="Send me a daily digest of unread mentions and DMs at 9am"
          checked={settings?.emailDigest === 'daily'}
          onChange={(on) =>
            void update({
              emailDigest: on ? 'daily' : 'off',
              timezone: settings?.timezone ?? localTimezone(),
            })
          }
        />
      </Section>

      {workspaceId ? (
        <>
          <SectionTitle>Workspace</SectionTitle>
          <Text className="mb-2 text-xs text-muted-foreground">
            Shared with everyone in {workspace?.name ?? 'this workspace'}.
          </Text>
          <Section title="User groups">
            <UserGroupsCard workspaceId={workspaceId} mentionables={mentionables} />
          </Section>
          <Section title="Custom emoji">
            <CustomEmojiCard workspaceId={workspaceId} />
          </Section>
        </>
      ) : null}

      {Platform.OS === 'web' ? (
        <Section title="Desktop notifications">
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
              <Button size="sm" onPress={requestPerm}>
                Enable
              </Button>
            ) : null}
          </View>

          {isDesktopApp() ? (
            <View className="mt-2 border-t border-border pt-4">
              <Text className="mb-1 text-sm text-foreground">This computer</Text>
              <Text className="mb-2 text-xs text-muted-foreground">Stored on this device only.</Text>
              <GroupLabel>Bounce dock icon on a new message</GroupLabel>
              {DOCK_BOUNCE.map((o) => (
                <ChoiceRow
                  key={o.value}
                  label={o.label}
                  checked={deviceAlerts.dockBounce === o.value}
                  onPress={() => saveDeviceAlerts({ dockBounce: o.value })}
                  testID={`chat-dock-bounce-${o.value}`}
                />
              ))}
              <View className="mt-2">
                <SwitchRow
                  label="Flash the taskbar button on Windows"
                  checked={deviceAlerts.flashTaskbar}
                  onChange={(on) => saveDeviceAlerts({ flashTaskbar: on })}
                />
              </View>
            </View>
          ) : null}
        </Section>
      ) : null}
    </View>
  )
}
