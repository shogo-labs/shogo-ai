// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * MachineSettings — project Settings → DATA → Machine.
 *
 * Pick this project's machine size (vCPU + memory) and restart it. Sizes above
 * the workspace plan's memory budget are shown but locked, with the plan that
 * unlocks them. Going back to Standard is always allowed.
 *
 * The host sizes a VM when it starts it, so a change to a running project
 * waits for a restart; the panel offers one right after saving. A restart
 * saves the project's files first and boots it fresh (about a minute); the
 * open chat reconnects on its own.
 *
 * On desktop (`substrate: 'local'`) the project runs on the user's computer,
 * so the panel only says so.
 */

import { useCallback, useEffect, useState } from 'react'
import { View, Text, Pressable, ScrollView } from 'react-native'
import { Cpu, Lock, RotateCw, Check } from 'lucide-react-native'
import type { HttpClient } from '@shogo-ai/sdk'
import { cn } from '@shogo/shared-ui/primitives'
import { api, type ProjectMachineState, type MachineSizeId } from '../../lib/api'
import { Spinner } from '@/components/ui/spinner'

interface MachineSettingsProps {
  projectId: string
  /** Passed in by the settings host; avoids useDomainHttp() inside panels. */
  http: HttpClient
}

const TIER_LABEL: Record<string, string> = {
  micro: 'Micro',
  small: 'Small',
  medium: 'Medium',
  large: 'Large',
  xlarge: 'XLarge',
}

function gb(memMiB: number): string {
  const v = memMiB / 1024
  return `${Number.isInteger(v) ? v : v.toFixed(1)} GB`
}

export function MachineSettings({ projectId, http }: MachineSettingsProps) {
  const [state, setState] = useState<ProjectMachineState | null>(null)
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState<MachineSizeId | null>(null)
  const [saving, setSaving] = useState(false)
  const [restartPending, setRestartPending] = useState(false)
  const [confirmRestart, setConfirmRestart] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await api.getProjectMachine(http, projectId)
      setState(data)
      setDraft(data.current.id === 'custom' ? null : data.current.id)
      setError(null)
    } catch (err: any) {
      setError(err?.message || 'Could not load machine settings')
    } finally {
      setLoading(false)
    }
  }, [http, projectId])

  useEffect(() => {
    load()
  }, [load])

  const save = async () => {
    if (!draft || saving) return
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const data = await api.updateProjectMachine(http, projectId, draft)
      setState(data)
      if (data.restartRequired) {
        setRestartPending(true)
        setNotice('Saved. Restart the project to switch to the new size.')
      } else {
        setNotice(
          data.running
            ? 'Saved.'
            : 'Saved. The new size applies the next time the project starts.',
        )
      }
    } catch (err: any) {
      // The route's message names the plan that allows the size; show it as is.
      setError(err?.message || 'Could not change the machine size')
    } finally {
      setSaving(false)
    }
  }

  const restart = async () => {
    if (restarting) return
    setRestarting(true)
    setConfirmRestart(false)
    setError(null)
    setNotice(null)
    try {
      const out = await api.restartProjectMachine(http, projectId)
      setRestartPending(false)
      setNotice(out.message)
      await load()
    } catch (err: any) {
      setError(err?.message || 'Could not restart the project')
    } finally {
      setRestarting(false)
    }
  }

  if (loading) {
    return (
      <View className="flex-1 items-center justify-center py-10">
        <Spinner size="small" />
      </View>
    )
  }

  const readOnly = !state?.canChange
  const current = state?.current
  const dirty = !!draft && draft !== current?.id
  const draftSpec = state?.options.find((o) => o.id === draft)
  const isDowngrade =
    !!draftSpec && !!current && (draftSpec.memMiB < current.memMiB || draftSpec.vcpus < current.vcpus)

  return (
    <ScrollView className="flex-1 bg-background" contentContainerStyle={{ padding: 16 }}>
      <View className="flex-row items-center gap-1.5 mb-1">
        <Cpu size={15} className="text-muted-foreground" />
        <Text className="text-sm font-medium text-foreground">Machine</Text>
      </View>
      <Text className="text-[11px] text-muted-foreground mb-4">
        {readOnly
          ? state?.substrate === 'local'
            ? 'This project runs on your computer, so it uses your own CPU and memory.'
            : 'This project’s machine size follows the workspace plan.'
          : 'CPU and memory for this project’s machine. A bigger machine uses more of the workspace plan’s memory, leaving less for its other running projects.'}
      </Text>

      {current && (
        <View className="rounded-lg border border-border p-3 gap-1">
          <View className="flex-row items-center justify-between">
            <Text className="text-sm text-foreground">Current size</Text>
            <View className="flex-row items-center gap-1.5">
              <View
                className={cn('h-2 w-2 rounded-full', state?.running ? 'bg-green-500' : 'bg-muted-foreground')}
              />
              <Text className="text-[11px] text-muted-foreground">{state?.running ? 'Running' : 'Stopped'}</Text>
            </View>
          </View>
          <Text className="text-[13px] text-foreground">
            {current.label} · {current.vcpus} vCPU · {gb(current.memMiB)}
          </Text>
          {restartPending && (
            <Text className="text-[11px] text-amber-600 dark:text-amber-400">
              Still running at the old size until it restarts.
            </Text>
          )}
        </View>
      )}

      {!readOnly && state && (
        <View className="mt-4 gap-2" accessibilityRole="radiogroup">
          {state.options.map((o) => {
            const selected = draft === o.id
            const locked = !o.allowed
            return (
              <Pressable
                key={o.id}
                accessibilityRole="radio"
                aria-checked={selected}
                aria-disabled={locked}
                accessibilityLabel={`${o.label}, ${o.vcpus} vCPU, ${gb(o.memMiB)}`}
                disabled={locked || saving}
                onPress={() => {
                  setDraft(o.id)
                  setNotice(null)
                  setError(null)
                }}
                className={cn(
                  'rounded-lg border p-3 flex-row items-center gap-3',
                  selected ? 'border-primary bg-primary/5' : 'border-border',
                  locked && 'opacity-60',
                )}
              >
                <View
                  className={cn(
                    'h-4 w-4 rounded-full border items-center justify-center',
                    selected ? 'border-primary bg-primary' : 'border-muted-foreground',
                  )}
                >
                  {selected && <Check size={10} className="text-primary-foreground" />}
                </View>
                <View className="flex-1 min-w-0">
                  <View className="flex-row items-center gap-1.5 flex-wrap">
                    <Text className="text-sm text-foreground">{o.label}</Text>
                    {current?.id === o.id && (
                      <Text className="text-[10px] text-muted-foreground border border-border rounded px-1">
                        Current
                      </Text>
                    )}
                  </View>
                  <Text className="text-[11px] text-muted-foreground mt-0.5">
                    {o.vcpus} vCPU · {gb(o.memMiB)}
                    {o.id === 'standard' ? ' · default for every project' : ''}
                  </Text>
                </View>
                {locked && (
                  <View className="flex-row items-center gap-1">
                    <Lock size={12} className="text-muted-foreground" />
                    <Text className="text-[11px] text-muted-foreground">
                      {o.requiredTier ? `${TIER_LABEL[o.requiredTier] ?? o.requiredTier} plan` : 'Not available'}
                    </Text>
                  </View>
                )}
              </Pressable>
            )
          })}

          {current?.id === 'custom' && (
            <Text className="text-[11px] text-muted-foreground">
              This project was given a custom size by Shogo support. Picking a size here replaces it.
            </Text>
          )}

          <Pressable
            onPress={save}
            disabled={!dirty || saving}
            className={cn('rounded-md py-2 items-center mt-1', dirty && !saving ? 'bg-primary' : 'bg-muted')}
          >
            {saving ? (
              <Spinner size="small" />
            ) : (
              <Text
                className={cn(
                  'text-sm font-medium',
                  dirty ? 'text-primary-foreground' : 'text-muted-foreground',
                )}
              >
                {dirty && draftSpec ? `${isDowngrade ? 'Downgrade' : 'Upgrade'} to ${draftSpec.label}` : 'Save machine size'}
              </Text>
            )}
          </Pressable>
          <Text className="text-[11px] text-muted-foreground">
            Need more than your plan allows? Upgrade the workspace plan in Billing.
          </Text>
        </View>
      )}

      {state?.canRestart && (
        <View className="mt-4 rounded-lg border border-border p-3 gap-2">
          <View className="flex-row items-center gap-1.5">
            <RotateCw size={13} className="text-muted-foreground" />
            <Text className="text-sm text-foreground">Restart</Text>
          </View>
          <Text className="text-[11px] text-muted-foreground">
            Saves the project’s files, then starts it fresh on a new machine at the chosen size. Takes about a
            minute; anything running in the project (servers, terminals, an agent turn) stops.
          </Text>
          {confirmRestart ? (
            <View className="flex-row gap-2">
              <Pressable
                onPress={restart}
                className="flex-1 rounded-md py-2 items-center bg-destructive"
                accessibilityLabel="Confirm restart"
              >
                <Text className="text-sm font-medium text-destructive-foreground">Restart now</Text>
              </Pressable>
              <Pressable
                onPress={() => setConfirmRestart(false)}
                className="flex-1 rounded-md py-2 items-center border border-border"
              >
                <Text className="text-sm text-foreground">Cancel</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable
              onPress={() => setConfirmRestart(true)}
              disabled={restarting}
              className={cn(
                'rounded-md py-2 items-center border',
                restartPending ? 'bg-primary border-primary' : 'border-border',
              )}
            >
              {restarting ? (
                <Spinner size="small" />
              ) : (
                <Text
                  className={cn('text-sm font-medium', restartPending ? 'text-primary-foreground' : 'text-foreground')}
                >
                  {restartPending ? 'Restart to apply' : 'Restart project'}
                </Text>
              )}
            </Pressable>
          )}
        </View>
      )}

      {notice && <Text className="text-[11px] text-muted-foreground mt-3">{notice}</Text>}
      {error && <Text className="text-[11px] text-destructive mt-3">{error}</Text>}
    </ScrollView>
  )
}
