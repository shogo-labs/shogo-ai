// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Settings > Computer and files (desktop, local mode).
 *
 * The same controls as the onboarding permission steps, plus blocked folders:
 * what Shogo may do on this computer, which local apps it can read, and the
 * dictation shortcuts. OS grants live in System Settings; this panel shows
 * their state and links there.
 */
import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native'
import { HardDrive, Mic, Monitor, MousePointerClick, Plus, X } from 'lucide-react-native'
import { Switch } from '@shogo/shared-ui/primitives'
import { useDomainHttp } from '../../contexts/domain'
import { api } from '../../lib/api'
import { getDesktopBridge, type LocalAppId } from '../../lib/desktop-bridge'
import {
  APP_ACCESS_LABELS,
  APP_ACCESS_OPTIONS,
  HANDS_FREE_OPTIONS,
  PUSH_TO_TALK_OPTIONS,
  defaultLocalAccess,
  type AppAccess,
  type LocalAccessPrefs,
} from '../../lib/local-access'
import { useLocalApps, useOsPermissions } from '../../lib/use-os-permissions'
import { OptionSelect } from '../onboarding/desktop/OptionSelect'
import { PermissionRow } from '../onboarding/desktop/PermissionRow'

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <View className="gap-3">
      <View className="gap-1">
        <Text className="text-base font-semibold text-foreground">{title}</Text>
        {description ? <Text className="text-sm leading-5 text-muted-foreground">{description}</Text> : null}
      </View>
      {children}
    </View>
  )
}

export function ComputerAndFilesPanel() {
  const http = useDomainHttp()
  const perms = useOsPermissions()
  const { apps } = useLocalApps()
  const [prefs, setPrefs] = useState<LocalAccessPrefs>(() => defaultLocalAccess())
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [folderDraft, setFolderDraft] = useState('')

  useEffect(() => {
    if (!http) return
    let cancelled = false
    api
      .getLocalAccessPrefs(http)
      .then((res) => {
        if (!cancelled) setPrefs(res.prefs)
      })
      .catch((err) => console.warn('[ComputerAndFiles] load failed:', err))
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [http])

  const save = useCallback(
    async (patch: Partial<LocalAccessPrefs>) => {
      setPrefs((p) => ({ ...p, ...patch }))
      if (!http) return
      setSaving(true)
      setError(null)
      try {
        const res = await api.saveLocalAccessPrefs(http, patch)
        if (res?.prefs) setPrefs(res.prefs)
        if (patch.dictation) await getDesktopBridge()?.dictation?.setConfig(patch.dictation)
      } catch (err) {
        console.warn('[ComputerAndFiles] save failed:', err)
        setError("Couldn't save your changes. Try again.")
      } finally {
        setSaving(false)
      }
    },
    [http],
  )

  const addFolder = useCallback(
    (folder: string) => {
      const value = folder.trim()
      if (!value || prefs.blockedFolders.includes(value)) return
      void save({ blockedFolders: [...prefs.blockedFolders, value] })
      setFolderDraft('')
    },
    [prefs.blockedFolders, save],
  )

  const pickFolder = useCallback(async () => {
    const res = await getDesktopBridge()?.pickFolders?.({ multi: true })
    if (res?.ok) for (const p of res.paths) addFolder(p)
  }, [addFolder])

  if (loading) {
    return (
      <View className="items-center justify-center py-12">
        <ActivityIndicator />
      </View>
    )
  }

  const { status, requesting } = perms
  const computerReady = status.accessibility === 'granted' && status.screen === 'granted'

  return (
    <View testID="computer-and-files-panel" className="gap-8">
      <Section
        title="Computer use"
        description="Let Shogo see your screen and control the mouse and keyboard when you ask it to complete a task."
      >
        <View className="overflow-hidden rounded-2xl border border-border bg-card">
          <View className="flex-row items-center justify-between gap-4 px-5 py-4">
            <View className="min-w-0 flex-1">
              <Text className="text-base font-semibold text-foreground">Allow Shogo to use my computer</Text>
              <Text className="mt-0.5 text-sm leading-5 text-muted-foreground">
                {prefs.computerUse && !computerReady
                  ? 'Turned on, but Accessibility and Screen Recording must also be allowed below.'
                  : 'Applies to all of your projects.'}
              </Text>
            </View>
            <Switch
              checked={prefs.computerUse}
              onCheckedChange={(computerUse) => void save({ computerUse })}
            />
          </View>
          <View className="h-px bg-border" />
          <PermissionRow
            id="accessibility"
            title="Accessibility"
            description="Control the mouse and keyboard"
            icon={MousePointerClick}
            state={status.accessibility}
            busy={requesting === 'accessibility'}
            onAllow={() => void perms.request('accessibility')}
          />
          <View className="h-px bg-border" />
          <PermissionRow
            id="screen"
            title="Screen Recording"
            description="Take screenshots"
            icon={Monitor}
            state={status.screen}
            busy={requesting === 'screen'}
            onAllow={() => void perms.request('screen')}
          />
        </View>
      </Section>

      <Section
        title="Files and local apps"
        description="Choose which local apps Shogo can read. When you turn an app off, Shogo is blocked from its data."
      >
        <View className="overflow-hidden rounded-2xl border border-border bg-card">
          <PermissionRow
            id="fullDisk"
            title="Full Disk Access"
            description="Lets Shogo read files and app data outside your projects"
            icon={HardDrive}
            state={status.fullDisk}
            busy={requesting === 'fullDisk'}
            onAllow={() => void perms.request('fullDisk')}
          />
        </View>
        <View className="rounded-2xl border border-border bg-card">
          {apps.map((app, i) => (
            <View key={app.id}>
              {i > 0 ? <View className="h-px bg-border" /> : null}
              <View testID={`settings-app-${app.id}`} className="flex-row items-start justify-between gap-3 px-5 py-3">
                <Text className="mt-2 flex-1 text-sm font-medium text-foreground">{app.name}</Text>
                {app.installed ? (
                  <OptionSelect<AppAccess>
                    testID={`settings-app-${app.id}-access`}
                    label={app.name}
                    value={prefs.apps[app.id as LocalAppId]}
                    options={APP_ACCESS_OPTIONS.map((a) => ({ value: a, label: APP_ACCESS_LABELS[a] }))}
                    onChange={(access) => void save({ apps: { ...prefs.apps, [app.id]: access } })}
                  />
                ) : (
                  <Text className="mt-2 text-sm text-muted-foreground">Not installed</Text>
                )}
              </View>
            </View>
          ))}
        </View>

        <View className="gap-2">
          <Text className="text-sm font-medium text-foreground">Blocked folders</Text>
          <View className="flex-row flex-wrap gap-2">
            {prefs.blockedFolders.map((folder) => (
              <View key={folder} className="flex-row items-center gap-1 rounded-md bg-muted px-2 py-1">
                <Text className="font-mono text-xs text-foreground">{folder}</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Unblock ${folder}`}
                  onPress={() => void save({ blockedFolders: prefs.blockedFolders.filter((f) => f !== folder) })}
                  className="p-0.5"
                >
                  <X size={10} className="text-muted-foreground" />
                </Pressable>
              </View>
            ))}
            <View className="flex-row items-center gap-1">
              <TextInput
                testID="blocked-folder-input"
                value={folderDraft}
                onChangeText={setFolderDraft}
                placeholder="e.g. ~/Documents/Private"
                onSubmitEditing={() => addFolder(folderDraft)}
                className="w-48 rounded-lg border border-border bg-background px-2 py-1.5 text-xs text-foreground"
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Block folder"
                onPress={() => addFolder(folderDraft)}
                className="rounded-md bg-muted p-1.5"
              >
                <Plus size={12} className="text-muted-foreground" />
              </Pressable>
              {getDesktopBridge()?.pickFolders ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void pickFolder()}
                  className="rounded-md bg-muted px-2 py-1.5"
                >
                  <Text className="text-xs text-muted-foreground">Choose…</Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        </View>
      </Section>

      <Section title="Dictation" description="Speak instead of typing, from any app.">
        <View className="overflow-hidden rounded-2xl border border-border bg-card">
          <PermissionRow
            id="mic"
            title="Microphone"
            icon={Mic}
            state={status.mic}
            busy={requesting === 'mic'}
            onAllow={() => void perms.request('mic')}
          />
          <View className="h-px bg-border" />
          <View className="flex-row items-start justify-between gap-4 px-5 py-4">
            <View className="min-w-0 flex-1">
              <Text className="text-base font-semibold text-foreground">Push to talk</Text>
              <Text className="mt-0.5 text-sm leading-5 text-muted-foreground">Hold the key to dictate</Text>
            </View>
            <OptionSelect<string | null>
              testID="settings-push-to-talk"
              label="Push to talk"
              value={prefs.dictation.pushToTalk}
              options={PUSH_TO_TALK_OPTIONS}
              onChange={(pushToTalk) => void save({ dictation: { ...prefs.dictation, pushToTalk } })}
            />
          </View>
          <View className="h-px bg-border" />
          <View className="flex-row items-start justify-between gap-4 px-5 py-4">
            <View className="min-w-0 flex-1">
              <Text className="text-base font-semibold text-foreground">Hands-free mode</Text>
              <Text className="mt-0.5 text-sm leading-5 text-muted-foreground">
                Press the key to start and stop dictation without holding
              </Text>
            </View>
            <OptionSelect<string | null>
              testID="settings-hands-free"
              label="Hands-free mode"
              value={prefs.dictation.handsFree}
              options={HANDS_FREE_OPTIONS}
              onChange={(handsFree) => void save({ dictation: { ...prefs.dictation, handsFree } })}
            />
          </View>
        </View>
      </Section>

      <View className="h-5 flex-row items-center gap-2">
        {saving ? <ActivityIndicator size="small" /> : null}
        {error ? <Text className="text-xs text-destructive">{error}</Text> : null}
      </View>
    </View>
  )
}

export default ComputerAndFilesPanel
