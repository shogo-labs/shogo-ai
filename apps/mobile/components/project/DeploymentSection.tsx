// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * DeploymentSection - the DevOps view for a published app (SHO-308 §4).
 *
 * Published apps run on Knative in one or more environments:
 *   - production (`{sub}.shogo.one`) — the live site
 *   - staging    (`{sub}--staging.shogo.one`) — optional, for load testing
 *
 * Everything here reads Knative/Kubernetes data (pods, revisions, pod logs) and
 * the metered usage rows, and it calls the same API the agent's `publish`
 * `ops_action` calls — so the dashboard and the agent never disagree.
 *
 * Controls: min/max replicas and size (clamped to the plan's caps), redeploy,
 * rollback, promote staging → production, create/delete staging.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native'
import { AlertTriangle, Boxes, RefreshCw, RotateCcw, Rocket, Trash2 } from 'lucide-react-native'
import type { HttpClient } from '@shogo-ai/sdk'
import { cn } from '@shogo/shared-ui/primitives'
import {
  api,
  type PublishedEnvironmentMetrics,
  type PublishedEnvironmentStatus,
  type PublishedPlanCaps,
  type PublishedSize,
} from '../../lib/api'

type EnvName = 'production' | 'staging'

interface DeploymentSectionProps {
  projectId: string
  http: HttpClient
  embedded?: boolean
}

const SIZE_LABEL: Record<PublishedSize, string> = { s: 'Small', m: 'Medium', l: 'Large' }

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View className="min-w-[45%] flex-1 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
      <Text className="text-xs uppercase text-neutral-500">{label}</Text>
      <Text className="mt-1 text-lg font-semibold text-neutral-900 dark:text-neutral-100">{value}</Text>
    </View>
  )
}

function Button({
  label,
  onPress,
  disabled,
  tone = 'neutral',
  icon,
}: {
  label: string
  onPress: () => void
  disabled?: boolean
  tone?: 'neutral' | 'primary' | 'danger'
  icon?: ReactNode
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      className={cn(
        'flex-row items-center gap-1.5 rounded-lg border px-3 py-2',
        tone === 'primary' && 'border-blue-600 bg-blue-600',
        tone === 'danger' && 'border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950',
        tone === 'neutral' && 'border-neutral-300 dark:border-neutral-700',
        disabled && 'opacity-40',
      )}
    >
      {icon}
      <Text
        className={cn(
          'text-sm font-medium',
          tone === 'primary' && 'text-white',
          tone === 'danger' && 'text-red-700 dark:text-red-300',
          tone === 'neutral' && 'text-neutral-800 dark:text-neutral-200',
        )}
      >
        {label}
      </Text>
    </Pressable>
  )
}

export function DeploymentSection({ projectId, http, embedded = true }: DeploymentSectionProps) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [environments, setEnvironments] = useState<PublishedEnvironmentStatus[]>([])
  const [caps, setCaps] = useState<PublishedPlanCaps | null>(null)
  const [active, setActive] = useState<EnvName>('production')
  const [metrics, setMetrics] = useState<PublishedEnvironmentMetrics | null>(null)
  const [logs, setLogs] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const activeStatus = environments.find((e) => e.environment.name === active) ?? null

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.getPublishedEnvironments(http, projectId)
      setEnvironments(res.environments ?? [])
      setCaps(res.caps ?? null)
      if (!res.environments?.length) return
      const name: EnvName = res.environments.some((e) => e.environment.name === 'staging') && active === 'staging' ? 'staging' : 'production'
      const [m] = await Promise.all([
        api.getPublishedEnvironmentMetrics(http, projectId, name).catch(() => null),
      ])
      setMetrics(m ?? null)
    } catch (err: any) {
      setError(err?.message ?? 'Could not load deployment state')
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [http, projectId, active])

  useEffect(() => {
    void load()
  }, [load])

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key)
    setError(null)
    try {
      await fn()
      await load()
    } catch (err: any) {
      setError(err?.message ?? 'Action failed')
    } finally {
      setBusy(null)
    }
  }

  const changeScale = (patch: { minReplicas?: number; maxReplicas?: number; size?: PublishedSize }) => {
    if (!activeStatus) return
    const next = { ...activeStatus.environment.scale, ...patch }
    void run('scale', () => api.scalePublishedEnvironment(http, projectId, active, next))
  }

  if (loading) {
    return (
      <View className="items-center justify-center py-10">
        <ActivityIndicator />
      </View>
    )
  }

  if (environments.length === 0) {
    return (
      <View className="gap-2 py-6">
        <Text className="text-base font-semibold text-neutral-900 dark:text-neutral-100">Deployment</Text>
        <Text className="text-sm text-neutral-500">
          Publish the app to see its deployment, replicas, logs and cost here.
        </Text>
      </View>
    )
  }

  const scale = activeStatus?.environment.scale
  const maxCap = caps?.maxReplicas ?? null
  const sizes = caps?.sizes ?? ['s']

  return (
    <View className={cn('gap-4', embedded ? '' : 'py-4')}>
      <View className="flex-row items-center justify-between">
        <Text className="text-base font-semibold text-neutral-900 dark:text-neutral-100">Deployment</Text>
        <Button label="Refresh" onPress={() => void load()} icon={<RefreshCw size={14} />} disabled={!!busy} />
      </View>

      {/* Environment switcher */}
      <View className="flex-row gap-2">
        {(['production', 'staging'] as EnvName[]).map((name) => {
          const exists = environments.some((e) => e.environment.name === name)
          return (
            <Pressable
              key={name}
              onPress={() => exists && setActive(name)}
              disabled={!exists}
              className={cn(
                'rounded-full border px-3 py-1.5',
                active === name && exists
                  ? 'border-blue-600 bg-blue-600'
                  : 'border-neutral-300 dark:border-neutral-700',
                !exists && 'opacity-40',
              )}
            >
              <Text
                className={cn(
                  'text-sm font-medium capitalize',
                  active === name && exists ? 'text-white' : 'text-neutral-700 dark:text-neutral-300',
                )}
              >
                {name}
                {!exists && name === 'staging' ? ' (not created)' : ''}
              </Text>
            </Pressable>
          )
        })}
      </View>

      {error && (
        <View className="flex-row items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950">
          <AlertTriangle size={16} className="text-amber-600" />
          <Text className="flex-1 text-sm text-amber-800 dark:text-amber-200">{error}</Text>
        </View>
      )}

      {active === 'staging' && !activeStatus && (
        <View className="gap-3">
          <Text className="text-sm text-neutral-500">
            A staging environment gets its own URL, database (seeded from dev), logs and cost, so you can load-test
            before promoting.
          </Text>
          <Button
            label={busy === 'create' ? 'Creating…' : 'Create staging'}
            tone="primary"
            disabled={!!busy || caps?.staging === false}
            onPress={() => void run('create', () => api.createPublishedEnvironment(http, projectId, 'staging'))}
            icon={<Boxes size={14} />}
          />
          {caps?.staging === false && (
            <Text className="text-xs text-neutral-500">Staging environments require the Pro plan or higher.</Text>
          )}
        </View>
      )}

      {activeStatus && scale && (
        <>
          {/* Live */}
          <View className="flex-row flex-wrap gap-2">
            <Stat label="Replicas ready" value={`${activeStatus.replicas.ready}`} />
            <Stat label="Requests (24h)" value={metrics ? metrics.requests.toLocaleString() : '—'} />
            <Stat label="p95 latency" value={metrics?.p95Ms != null ? `${metrics.p95Ms} ms` : '—'} />
            <Stat label="5xx (24h)" value={metrics ? metrics.errors5xx.toLocaleString() : '—'} />
            <Stat label="Billed (MTD)" value={metrics ? `$${metrics.monthToDateUsd.toFixed(2)}` : '—'} />
            <Stat label="Projected / mo" value={metrics ? `$${metrics.projectionUsd.toFixed(2)}` : '—'} />
          </View>

          <Text className="text-xs text-neutral-500">
            {activeStatus.environment.url} · revision {activeStatus.revision ?? '—'}
          </Text>

          {/* Scale */}
          <View className="gap-2 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
            <Text className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Scale</Text>
            <View className="flex-row items-center gap-3">
              <Text className="w-24 text-xs text-neutral-500">Min replicas</Text>
              <Button label="−" onPress={() => changeScale({ minReplicas: Math.max(0, scale.minReplicas - 1) })} disabled={!!busy || scale.minReplicas <= 0} />
              <Text className="w-6 text-center text-sm">{scale.minReplicas}</Text>
              <Button
                label="+"
                onPress={() => changeScale({ minReplicas: Math.min(scale.maxReplicas, scale.minReplicas + 1) })}
                disabled={!!busy || scale.minReplicas >= scale.maxReplicas}
              />
              <Text className="ml-2 text-[11px] text-neutral-500">1+ = always on</Text>
            </View>
            <View className="flex-row items-center gap-3">
              <Text className="w-24 text-xs text-neutral-500">Max replicas</Text>
              <Button label="−" onPress={() => changeScale({ maxReplicas: Math.max(scale.minReplicas || 1, scale.maxReplicas - 1) })} disabled={!!busy || scale.maxReplicas <= 1} />
              <Text className="w-6 text-center text-sm">{scale.maxReplicas}</Text>
              <Button
                label="+"
                onPress={() => changeScale({ maxReplicas: scale.maxReplicas + 1 })}
                disabled={!!busy || (maxCap !== null && scale.maxReplicas >= maxCap)}
              />
              <Text className="ml-2 text-[11px] text-neutral-500">
                {maxCap === null ? 'unlimited' : `plan cap ${maxCap}`}
              </Text>
            </View>
            <View className="flex-row items-center gap-2">
              <Text className="w-24 text-xs text-neutral-500">Size</Text>
              {(['s', 'm', 'l'] as PublishedSize[]).map((size) => {
                const allowed = sizes.includes(size)
                return (
                  <Pressable
                    key={size}
                    disabled={!allowed || !!busy}
                    onPress={() => changeScale({ size })}
                    className={cn(
                      'rounded-md border px-2.5 py-1',
                      scale.size === size ? 'border-blue-600 bg-blue-600' : 'border-neutral-300 dark:border-neutral-700',
                      !allowed && 'opacity-40',
                    )}
                  >
                    <Text className={cn('text-xs', scale.size === size ? 'text-white' : 'text-neutral-700 dark:text-neutral-300')}>
                      {SIZE_LABEL[size]}
                    </Text>
                  </Pressable>
                )
              })}
            </View>
          </View>

          {/* Actions */}
          <View className="flex-row flex-wrap gap-2">
            <Button
              label={busy === 'redeploy' ? 'Redeploying…' : 'Redeploy'}
              disabled={!!busy}
              onPress={() => void run('redeploy', () => api.redeployPublishedEnvironment(http, projectId, active))}
              icon={<Rocket size={14} />}
            />
            <Button
              label={busy === 'rollback' ? 'Rolling back…' : 'Rollback'}
              disabled={!!busy}
              onPress={() => void run('rollback', () => api.rollbackPublishedEnvironment(http, projectId, active))}
              icon={<RotateCcw size={14} />}
            />
            {active === 'staging' && (
              <>
                <Button
                  label={busy === 'promote' ? 'Promoting…' : 'Promote to production'}
                  tone="primary"
                  disabled={!!busy}
                  onPress={() => void run('promote', () => api.promotePublishedEnvironment(http, projectId))}
                />
                <Button
                  label="Delete staging"
                  tone="danger"
                  disabled={!!busy}
                  onPress={() => void run('delete', () => api.deletePublishedEnvironment(http, projectId, 'staging'))}
                  icon={<Trash2 size={14} />}
                />
              </>
            )}
          </View>

          <Text className="text-[11px] text-neutral-500">
            Rollback serves an earlier image as a new revision, with no rebuild. Data is not rolled back — database
            contents stay as they are.
          </Text>

          {/* Logs */}
          <View className="gap-2">
            <View className="flex-row items-center justify-between">
              <Text className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Logs</Text>
              <Button
                label={busy === 'logs' ? 'Loading…' : 'Load logs'}
                disabled={!!busy}
                onPress={() =>
                  void run('logs', async () => {
                    const res = await api.getPublishedEnvironmentLogs(http, projectId, active)
                    setLogs(res.logs || '(no log lines)')
                  })
                }
              />
            </View>
            {logs !== null && (
              <ScrollView className="max-h-56 rounded-lg bg-neutral-900 p-3">
                <Text className="font-mono text-[11px] leading-4 text-neutral-100">{logs}</Text>
              </ScrollView>
            )}
          </View>
        </>
      )}
    </View>
  )
}
