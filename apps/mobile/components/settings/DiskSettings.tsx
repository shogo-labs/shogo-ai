// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * DiskSettings — Settings → DATA → Disk (SHO-349) and Settings → Workspace →
 * Disk (SHO-401).
 *
 * A project's files live on its own workspace drive; a bare `ws:<id>` workspace
 * runtime has its own drive too. Each tier includes a fixed amount of drive
 * (`includedGiB`); anything above that is a paid per-GiB-month add-on, charged
 * daily against the usage wallet. The host grows the live drive without a
 * restart.
 *
 * Two facts the copy has to carry, because they surprise people:
 *   - drives never shrink (ext4 can't, and lowering the setting only caps
 *     future growth);
 *   - a bigger workspace takes longer to sleep and wake (the whole drive is
 *     packed on suspend and restored on wake).
 *
 * On desktop (`substrate: 'local'`) there is nothing to grow — the project uses
 * the machine's own disk — so the panel is read-only and shows no price.
 */

import { useCallback, useEffect, useState } from 'react'
import { View, Text, Pressable, ActivityIndicator, ScrollView } from 'react-native'
import { useRouter } from 'expo-router'
import { HardDrive, Minus, Plus } from 'lucide-react-native'
import type { HttpClient } from '@shogo-ai/sdk'
import { cn } from '@shogo/shared-ui/primitives'
import { api, type ProjectDiskState } from '../../lib/api'

interface DiskSettingsProps {
  /** Which drive this panel edits. */
  scope: 'project' | 'workspace'
  /** Required when `scope === 'project'`. */
  projectId?: string
  /** Required when `scope === 'workspace'`. */
  workspaceId?: string
  /** Passed in by the settings host; avoids useDomainHttp() inside panels. */
  http: HttpClient
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 GB'
  const gb = bytes / 1024 ** 3
  if (gb >= 10) return `${gb.toFixed(0)} GB`
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`
}

export function DiskSettings({ scope, projectId, workspaceId, http }: DiskSettingsProps) {
  const router = useRouter()
  const [state, setState] = useState<ProjectDiskState | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [draftGiB, setDraftGiB] = useState<number>(20)

  const load = useCallback(async () => {
    try {
      const data =
        scope === 'workspace'
          ? await api.getWorkspaceDisk(http, workspaceId!)
          : await api.getProjectDisk(http, projectId!)
      setState(data)
      setDraftGiB(Math.max(data.effectiveGiB, data.requestedGiB ?? data.effectiveGiB))
      setError(null)
    } catch (err: any) {
      setError(err?.message || 'Could not load disk settings')
    } finally {
      setLoading(false)
    }
  }, [http, projectId, workspaceId, scope])

  useEffect(() => {
    load()
  }, [load])

  const save = async () => {
    if (!state || saving) return
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const data =
        scope === 'workspace'
          ? await api.updateWorkspaceDisk(http, workspaceId!, draftGiB)
          : await api.updateProjectDisk(http, projectId!, draftGiB)
      setState(data)
      if ((data as any).growError) {
        setNotice('Saved — applies on next start. The running runtime will pick up the bigger disk the next time it opens.')
      }
    } catch (err: any) {
      // The route's message is the useful one ("This workspace's plan includes
      // 20 GiB. Upgrade to buy more disk."), so surface it verbatim.
      setError(err?.message || 'Could not change the disk size')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <View className="flex-1 items-center justify-center py-10">
        <ActivityIndicator size="small" />
      </View>
    )
  }

  const readOnly = state?.substrate === 'local'
  const defaultGiB = state?.defaultGiB ?? 20
  const includedGiB = state?.includedGiB ?? defaultGiB
  const maxGiB = state?.maxGiB ?? defaultGiB
  const currentGiB = state?.effectiveGiB ?? defaultGiB
  const usedBytes = state?.usage?.usedBytes ?? 0
  const totalBytes = state?.usage?.totalBytes ?? currentGiB * 1024 ** 3
  const percent = totalBytes > 0 ? Math.min((usedBytes / totalBytes) * 100, 100) : 0
  const canSave = !readOnly && !saving && draftGiB !== currentGiB && draftGiB <= maxGiB
  const draftAddonGiB = Math.max(0, draftGiB - includedGiB)
  const draftMonthlyUsd = draftAddonGiB * (state?.pricePerGiBMonthUsd ?? 0)
  const nearFull = !!state?.usage && percent >= 90
  const planBlocked = state?.buyBlockedReason === 'plan_required'

  return (
    <ScrollView className="flex-1 bg-background" contentContainerStyle={{ padding: 16 }}>
      <View className="flex-row items-center gap-1.5 mb-1">
        <HardDrive size={15} className="text-muted-foreground" />
        <Text className="text-sm font-medium text-foreground">Disk</Text>
      </View>
      <Text className="text-[11px] text-muted-foreground mb-4">
        {scope === 'workspace'
          ? 'Space for this workspace runtime — every project folder it mounts.'
          : "Space for this project's files, dependencies and build output."}
        {readOnly
          ? ' This runs on your computer, so it uses your own disk.'
          : ' Raising it is immediate — the runtime keeps running.'}
      </Text>

      {/* Usage bar */}
      <View className="rounded-lg border border-border p-3 gap-2">
        <View className="flex-row items-center justify-between">
          <Text className="text-sm text-foreground">Used</Text>
          <Text className="text-sm text-muted-foreground">
            {state?.usage ? `${formatBytes(usedBytes)} of ${formatBytes(totalBytes)}` : `${currentGiB} GiB`}
          </Text>
        </View>
        <View className="h-2 bg-muted rounded-full overflow-hidden">
          <View
            className={cn(
              'h-full rounded-full',
              percent > 90 ? 'bg-destructive' : percent > 70 ? 'bg-amber-500' : 'bg-primary',
            )}
            style={{ width: `${Math.max(state?.usage ? percent : 1, 1)}%` }}
          />
        </View>
        {!state?.usage && (
          <Text className="text-[11px] text-muted-foreground">
            Usage appears while the runtime is running.
          </Text>
        )}
        {nearFull && (
          <Text className="text-[11px] text-amber-600">
            Almost full ({percent.toFixed(0)}%). Raise the disk size below to avoid running out of space.
          </Text>
        )}
      </View>

      {/* Included vs add-on */}
      {!readOnly && (
        <View className="mt-3 rounded-lg border border-border p-3 gap-1">
          <View className="flex-row items-center justify-between">
            <Text className="text-[12px] text-muted-foreground">Included with your plan</Text>
            <Text className="text-[12px] text-foreground">{includedGiB} GiB</Text>
          </View>
          <View className="flex-row items-center justify-between">
            <Text className="text-[12px] text-muted-foreground">Add-on</Text>
            <Text className="text-[12px] text-foreground">
              {state?.addonGiB ?? 0} GiB
              {(state?.addonMonthlyUsd ?? 0) > 0 ? ` · ${usd(state!.addonMonthlyUsd)}/mo` : ''}
            </Text>
          </View>
        </View>
      )}

      {/* Size picker */}
      {!readOnly && (
        <View className="mt-4 rounded-lg border border-border p-3 gap-3">
          <View className="flex-row items-center justify-between">
            <View className="flex-1 min-w-0 pr-3">
              <Text className="text-sm text-foreground">Disk size</Text>
              <Text className="text-[11px] text-muted-foreground mt-0.5">
                {currentGiB} GiB now · up to {maxGiB} GiB
              </Text>
            </View>
            <View className="flex-row items-center gap-2">
              <Pressable
                accessibilityLabel="Smaller disk"
                onPress={() => setDraftGiB((v) => Math.max(currentGiB, v - 5))}
                disabled={draftGiB <= currentGiB || saving}
                className={cn(
                  'h-8 w-8 items-center justify-center rounded-md border border-border',
                  (draftGiB <= currentGiB || saving) && 'opacity-40',
                )}
              >
                <Minus size={14} className="text-foreground" />
              </Pressable>
              <Text className="text-sm font-semibold text-foreground w-14 text-center">
                {draftGiB} GiB
              </Text>
              <Pressable
                accessibilityLabel="Bigger disk"
                onPress={() => setDraftGiB((v) => Math.min(maxGiB, v + 5))}
                disabled={!state?.canIncrease || draftGiB >= maxGiB || saving}
                className={cn(
                  'h-8 w-8 items-center justify-center rounded-md border border-border',
                  (!state?.canIncrease || draftGiB >= maxGiB || saving) && 'opacity-40',
                )}
              >
                <Plus size={14} className="text-foreground" />
              </Pressable>
            </View>
          </View>

          {draftAddonGiB > 0 && (
            <Text className="text-[11px] text-muted-foreground">
              {draftAddonGiB} GiB add-on · +{usd(draftMonthlyUsd)}/mo
            </Text>
          )}

          {!state?.canIncrease && (
            <Text className="text-[11px] text-muted-foreground">
              {planBlocked
                ? `${includedGiB} GiB is what your plan includes. Upgrade to buy more disk.`
                : `${currentGiB} GiB is the most a workspace disk can be.`}
            </Text>
          )}

          {planBlocked && (
            <Pressable
              onPress={() => router.push('/(app)/settings?tab=billing' as any)}
              className="rounded-md border border-border py-2 items-center"
            >
              <Text className="text-sm font-medium text-foreground">Upgrade to a paid plan</Text>
            </Pressable>
          )}

          <Pressable
            onPress={save}
            disabled={!canSave}
            className={cn('rounded-md py-2 items-center', canSave ? 'bg-primary' : 'bg-muted')}
          >
            {saving ? (
              <ActivityIndicator size="small" />
            ) : (
              <Text className={cn('text-sm font-medium', canSave ? 'text-primary-foreground' : 'text-muted-foreground')}>
                Save disk size
              </Text>
            )}
          </Pressable>

          <Text className="text-[11px] text-muted-foreground">
            Disks can&apos;t be made smaller — lowering this only limits future growth. Bigger
            workspaces take a little longer to sleep and wake.
          </Text>
        </View>
      )}

      {notice && <Text className="text-[11px] text-amber-600 mt-3">{notice}</Text>}
      {error && <Text className="text-[11px] text-destructive mt-3">{error}</Text>}
    </ScrollView>
  )
}
