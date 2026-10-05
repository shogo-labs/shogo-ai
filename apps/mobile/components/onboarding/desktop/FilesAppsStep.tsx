// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useEffect, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { HardDrive, Mail, MessageCircle, MessagesSquare, NotebookText } from 'lucide-react-native'
import type { LocalAppId, PermissionStatus } from '../../../lib/desktop-bridge'
import {
  APP_ACCESS_LABELS,
  APP_ACCESS_OPTIONS,
  type AppAccess,
} from '../../../lib/local-access'
import { useLocalApps, useOsPermissions } from '../../../lib/use-os-permissions'
import { OptionSelect } from './OptionSelect'
import { PermissionRow } from './PermissionRow'

const APP_ICONS: Record<LocalAppId, typeof Mail> = {
  mail: Mail,
  messages: MessageCircle,
  notes: NotebookText,
  whatsapp: MessagesSquare,
}

interface FilesAppsStepProps {
  value: Record<LocalAppId, AppAccess>
  onChange: (id: LocalAppId, access: AppAccess) => void
  onStatusChange?: (status: PermissionStatus) => void
}

/** Full Disk Access, then (once granted) per-app access for Mail, Messages, Notes and WhatsApp. */
export function FilesAppsStep({ value, onChange, onStatusChange }: FilesAppsStepProps) {
  const perms = useOsPermissions()
  const { apps, loaded } = useLocalApps()
  const { status, requesting, awaitingSettings } = perms
  // Full Disk Access has no status API, so the probe can be inconclusive.
  // Let the user confirm they turned it on.
  const [manuallyConfirmed, setManuallyConfirmed] = useState(false)

  useEffect(() => {
    if (perms.ready) onStatusChange?.(status)
  }, [status, perms.ready, onStatusChange])

  const fullDiskGranted = status.fullDisk === 'granted' || manuallyConfirmed
  const showConfirm = !fullDiskGranted && awaitingSettings.fullDisk

  return (
    <View className="gap-4">
      <View className="overflow-hidden rounded-2xl border border-border bg-card">
        <PermissionRow
          id="fullDisk"
          title="Full Disk Access"
          description="Allow Shogo to access your files and local apps"
          icon={HardDrive}
          state={fullDiskGranted ? 'granted' : status.fullDisk}
          busy={requesting === 'fullDisk'}
          onAllow={() => void perms.request('fullDisk')}
        >
          {showConfirm ? (
            <View className="mt-2 flex-row flex-wrap items-center gap-x-4 gap-y-1">
              <Text className="text-xs leading-4 text-muted-foreground">
                Turn Shogo on under Full Disk Access, then come back.
              </Text>
              <Pressable
                testID="full-disk-confirm"
                accessibilityRole="button"
                onPress={() => {
                  setManuallyConfirmed(true)
                  void perms.refresh()
                }}
              >
                <Text className="text-xs font-medium text-primary">I've turned it on</Text>
              </Pressable>
            </View>
          ) : null}
        </PermissionRow>
      </View>

      {fullDiskGranted ? (
        <View testID="local-apps-list" className="gap-2">
          <Text className="px-1 text-xs font-medium text-muted-foreground">Select permissions for these apps</Text>
          <View className="rounded-2xl border border-border bg-card">
            {apps.map((app, i) => {
              const Icon = APP_ICONS[app.id]
              return (
                <View key={app.id}>
                  {i > 0 ? <View className="h-px bg-border" /> : null}
                  <View testID={`local-app-${app.id}`} className="flex-row items-start gap-3 px-5 py-3">
                    <View className="h-9 w-9 items-center justify-center rounded-lg bg-muted">
                      <Icon size={18} className="text-foreground" />
                    </View>
                    <Text className="mt-2 flex-1 text-sm font-medium text-foreground">{app.name}</Text>
                    {app.installed ? (
                      <OptionSelect<AppAccess>
                        testID={`local-app-${app.id}-access`}
                        label={app.name}
                        value={value[app.id]}
                        options={APP_ACCESS_OPTIONS.map((a) => ({ value: a, label: APP_ACCESS_LABELS[a] }))}
                        onChange={(access) => onChange(app.id, access)}
                      />
                    ) : (
                      <Text testID={`local-app-${app.id}-not-installed`} className="mt-2 text-sm text-muted-foreground">
                        Not installed
                      </Text>
                    )}
                  </View>
                </View>
              )
            })}
            {loaded && apps.length === 0 ? (
              <Text className="px-5 py-4 text-sm text-muted-foreground">No supported apps were found.</Text>
            ) : null}
          </View>
        </View>
      ) : null}
    </View>
  )
}

export function FilesAppsFootnote({ showAppNote }: { showAppNote: boolean }) {
  return (
    <Text className="text-center text-xs leading-4 text-muted-foreground">
      {showAppNote
        ? 'When you turn off an app here, Shogo will be blocked from accessing it. Shogo can still access other files on your disk when you ask it to.'
        : 'You can turn Full Disk Access on or off and add blocked folders any time in Settings. Shogo only reads files when you ask it to.'}
    </Text>
  )
}
