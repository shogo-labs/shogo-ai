// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Settings → Automations tab.
 *
 * Everything that reacts to workspace events: triggers grouped by where the
 * event comes from (Shogo or a connected Composio app), each with its recent
 * deliveries and a redeliver button, plus the marketplace apps that hold a
 * grant on this workspace and can be revoked here. Triggers that run a
 * project agent also choose whose accounts that agent may use.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Platform, Pressable, TextInput, View } from 'react-native'
import { useRouter } from 'expo-router'
import {
  AlertCircle as AlertCircleIcon,
  Plus as PlusIcon,
  ChevronDown as ChevronDownIcon,
  ChevronRight as ChevronRightIcon,
  RefreshCw as RefreshCwIcon,
  RotateCcw as RotateCcwIcon,
} from 'lucide-react-native'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { useDomainHttp } from '../../contexts/domain'
import { setChatPrefill } from '../../hooks/useChatPrefill'
import {
  api,
  type TriggerDelivery,
  type WorkspaceAppGrant,
  type WorkspaceTrigger,
} from '../../lib/api'
import { Badge, Button, Card, CardContent, Skeleton, Switch, cn } from '@shogo/shared-ui/primitives'
import { Text, useAccountSheetIcons } from './account-sheet-chrome'

const LOG_PREFIX = '[AutomationsTab]'

export const CREATE_AUTOMATION_PROMPT = 'I want you to create an automation in this workspace that '

const STATUS_TONE: Record<string, string> = {
  ok: 'text-green-600',
  pending: 'text-muted-foreground',
  running: 'text-blue-500',
  failed: 'text-amber-600',
  dead: 'text-destructive',
  skipped: 'text-muted-foreground',
}

function sourceLabel(trigger: WorkspaceTrigger): string {
  if (trigger.source !== 'composio') return 'Shogo'
  const toolkit = trigger.eventType.split('.')[1] ?? 'app'
  return toolkit.charAt(0).toUpperCase() + toolkit.slice(1)
}

function targetLabel(trigger: WorkspaceTrigger): string {
  if (trigger.target === 'webhook') {
    try {
      return `Webhook → ${new URL(trigger.webhookUrl ?? '').host}`
    } catch {
      return 'Webhook'
    }
  }
  if (trigger.target === 'project') return trigger.targetMode === 'hook' ? 'Project hook' : 'Project agent'
  return 'Workspace agent'
}

function confirmAction(title: string, message: string, onConfirm: () => void) {
  if (Platform.OS === 'web') {
    if (window.confirm(`${title}\n\n${message}`)) onConfirm()
    return
  }
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Revoke', style: 'destructive', onPress: onConfirm },
  ])
}

const ACTS_AS_CHOICES: Array<{ id: 'subscriber' | 'actor' | 'nobody'; label: string; hint: string }> = [
  { id: 'subscriber', label: 'Whoever set it up', hint: "The project's integrations act as the trigger's creator." },
  { id: 'actor', label: 'Who triggered it', hint: 'Acts as the person behind the event when Shogo knows their account; otherwise falls back like any run with no person.' },
  { id: 'nobody', label: 'No one', hint: "Always uses the project's shared accounts." },
]

export function runsProjectAgent(trigger: WorkspaceTrigger): boolean {
  return trigger.target === 'project' && trigger.targetMode !== 'hook'
}

/** Whose accounts a project agent may use when this trigger fires. */
export function TriggerActsAs({
  trigger,
  workspaceId,
  onChanged,
}: {
  trigger: WorkspaceTrigger
  workspaceId: string
  onChanged: (trigger: WorkspaceTrigger) => void
}) {
  const http = useDomainHttp()
  const actsAs = (trigger.actsAs ?? 'subscriber') as 'subscriber' | 'actor' | 'nobody'
  const composio = trigger.source === 'composio'
  const [pending, setPending] = useState<'subscriber' | 'actor' | 'nobody' | null>(null)
  const [suggestions, setSuggestions] = useState<{ idPaths: string[]; emailPaths: string[] } | null>(null)
  const [idPath, setIdPath] = useState(trigger.actorIdPath ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const choosing = pending ?? actsAs
  const needsField = composio && choosing === 'actor'

  useEffect(() => {
    if (!needsField || suggestions) return
    api.getTriggerActorFields(http, workspaceId, trigger.eventType)
      .then(setSuggestions)
      .catch(() => setSuggestions({ idPaths: [], emailPaths: [] }))
  }, [needsField, suggestions, http, workspaceId, trigger.eventType])

  const save = useCallback(async (patch: Parameters<typeof api.updateWorkspaceTrigger>[3]) => {
    setSaving(true)
    setError(null)
    try {
      onChanged(await api.updateWorkspaceTrigger(http, workspaceId, trigger.id, patch))
      setPending(null)
    } catch (err: any) {
      setError(err?.message ?? String(err))
    } finally {
      setSaving(false)
    }
  }, [http, workspaceId, trigger.id, onChanged])

  const choose = (id: 'subscriber' | 'actor' | 'nobody') => {
    if (id === actsAs && !pending) return
    if (id === 'actor' && composio && !trigger.actorIdPath && !trigger.actorEmailPath) {
      setPending('actor')
      return
    }
    save({ actsAs: id })
  }

  const emailPath = trigger.actorEmailPath ?? suggestions?.emailPaths[0] ?? null
  const hint = ACTS_AS_CHOICES.find((c) => c.id === choosing)?.hint

  return (
    <View className="gap-1.5 pb-2" testID={`automation-acts-as-${trigger.id}`}>
      <Text className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Integrations act as</Text>
      <View className="flex-row flex-wrap gap-1.5">
        {ACTS_AS_CHOICES.map((choice) => (
          <Pressable
            key={choice.id}
            onPress={() => choose(choice.id)}
            disabled={saving}
            accessibilityLabel={choice.label}
            className={cn(
              'px-2.5 py-1 rounded-md border',
              choosing === choice.id ? 'border-primary bg-primary/10' : 'border-border active:bg-muted',
            )}
            testID={`automation-acts-as-${trigger.id}-${choice.id}`}
          >
            <Text className={cn('text-xs', choosing === choice.id ? 'text-primary' : 'text-foreground')}>{choice.label}</Text>
          </Pressable>
        ))}
      </View>
      {hint && <Text className="text-[11px] text-muted-foreground">{hint}</Text>}
      {needsField && (
        <View className="gap-1.5 mt-1">
          <Text className="text-[11px] text-foreground">Which field in the event says who did it?</Text>
          {suggestions && suggestions.idPaths.length > 0 && (
            <View className="flex-row flex-wrap gap-1.5">
              {suggestions.idPaths.map((path) => (
                <Pressable
                  key={path}
                  onPress={() => setIdPath(path)}
                  accessibilityLabel={path}
                  className={cn('px-2 py-0.5 rounded border', idPath === path ? 'border-primary' : 'border-border')}
                  testID={`automation-actor-field-${path}`}
                >
                  <Text className="text-[11px] font-mono text-foreground">{path}</Text>
                </Pressable>
              ))}
            </View>
          )}
          <TextInput
            value={idPath}
            onChangeText={setIdPath}
            placeholder="e.g. sender.id"
            autoCapitalize="none"
            className="border border-border rounded-md px-2 py-1 text-xs font-mono text-foreground"
            testID={`automation-actor-path-${trigger.id}`}
          />
          <Pressable
            onPress={() => save({ actsAs: 'actor', actorIdPath: idPath.trim() || null })}
            disabled={saving || !idPath.trim()}
            className="self-start px-2.5 py-1 rounded-md bg-primary"
            testID={`automation-actor-save-${trigger.id}`}
          >
            <Text className="text-xs text-primary-foreground">{saving ? 'Saving…' : 'Save'}</Text>
          </Pressable>
        </View>
      )}
      {composio && actsAs === 'actor' && !pending && emailPath && (
        <View className="flex-row items-center gap-2 mt-1" testID={`automation-trust-email-${trigger.id}`}>
          <Switch
            checked={!!trigger.trustActorEmail}
            disabled={saving}
            onCheckedChange={(on: boolean) => save(on ? { trustActorEmail: true, actorEmailPath: emailPath } : { trustActorEmail: false })}
          />
          <Text className="text-[11px] text-muted-foreground flex-1">
            Also match people by the email in <Text className="font-mono">{emailPath}</Text>. Only turn this on if that app verifies emails.
          </Text>
        </View>
      )}
      {error && <Text className="text-xs text-destructive">{error}</Text>}
    </View>
  )
}

function TriggerRow({
  trigger,
  workspaceId,
  appName,
  onChanged,
}: {
  trigger: WorkspaceTrigger
  workspaceId: string
  appName: string | null
  onChanged: (trigger: WorkspaceTrigger) => void
}) {
  const { ChevronDown, ChevronRight, RotateCcw } = useAccountSheetIcons({
    ChevronDown: ChevronDownIcon,
    ChevronRight: ChevronRightIcon,
    RotateCcw: RotateCcwIcon,
  })
  const http = useDomainHttp()
  const [open, setOpen] = useState(false)
  const [deliveries, setDeliveries] = useState<TriggerDelivery[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadDeliveries = useCallback(async () => {
    try {
      setDeliveries(await api.listTriggerDeliveries(http, workspaceId, trigger.id))
    } catch (err: any) {
      setError(err?.message ?? String(err))
    }
  }, [http, workspaceId, trigger.id])

  useEffect(() => {
    if (open) loadDeliveries()
  }, [open, loadDeliveries])

  const toggle = useCallback(async (enabled: boolean) => {
    setBusy('toggle')
    setError(null)
    try {
      onChanged(await api.setWorkspaceTriggerEnabled(http, workspaceId, trigger.id, enabled))
    } catch (err: any) {
      setError(err?.message ?? String(err))
    } finally {
      setBusy(null)
    }
  }, [http, workspaceId, trigger.id, onChanged])

  const redeliver = useCallback(async (deliveryId: string) => {
    setBusy(deliveryId)
    setError(null)
    try {
      const updated = await api.redeliverTriggerDelivery(http, workspaceId, trigger.id, deliveryId)
      setDeliveries((prev) => prev?.map((d) => (d.id === deliveryId ? { ...d, ...updated } : d)) ?? prev)
      setTimeout(loadDeliveries, 2500)
    } catch (err: any) {
      setError(err?.message ?? String(err))
    } finally {
      setBusy(null)
    }
  }, [http, workspaceId, trigger.id, loadDeliveries])

  return (
    <View className="border-t border-border first:border-t-0" testID={`automation-trigger-${trigger.id}`}>
      <View className="flex-row items-center gap-3 pr-3">
        <Pressable onPress={() => setOpen((v) => !v)} className="flex-1 flex-row items-center gap-3 pl-3 py-3 active:bg-muted">
          {open ? <ChevronDown size={14} className="text-muted-foreground" /> : <ChevronRight size={14} className="text-muted-foreground" />}
          <View className="flex-1 min-w-0">
            <View className="flex-row items-center gap-2 flex-wrap">
              <Text className="text-sm font-medium text-foreground" numberOfLines={1}>{trigger.name}</Text>
              {appName && <Badge variant="secondary"><Text className="text-[10px]">App · {appName}</Text></Badge>}
              {!trigger.enabled && trigger.consecutiveFailures > 0 && (
                <Badge variant="destructive"><Text className="text-[10px] text-destructive-foreground">Auto-disabled</Text></Badge>
              )}
            </View>
            <Text className="text-xs text-muted-foreground mt-0.5" numberOfLines={1}>
              <Text className="font-mono">{trigger.eventType}</Text> → {targetLabel(trigger)}
            </Text>
            {trigger.lastError && !trigger.enabled && (
              <Text className="text-[11px] text-destructive mt-0.5" numberOfLines={2}>{trigger.lastError}</Text>
            )}
          </View>
        </Pressable>
        <View testID={`automation-trigger-toggle-${trigger.id}`}>
          <Switch checked={trigger.enabled} disabled={busy === 'toggle'} onCheckedChange={toggle} />
        </View>
      </View>
      {open && (
        <View className="px-3 pb-3 pl-9 gap-1.5">
          {runsProjectAgent(trigger) && trigger.ownerKind !== 'app' && (
            <TriggerActsAs trigger={trigger} workspaceId={workspaceId} onChanged={onChanged} />
          )}
          {error && <Text className="text-xs text-destructive">{error}</Text>}
          {deliveries === null ? (
            <Skeleton className="h-8 w-full rounded-md" />
          ) : deliveries.length === 0 ? (
            <Text className="text-xs text-muted-foreground">No deliveries yet.</Text>
          ) : (
            deliveries.map((d) => (
              <View key={d.id} className="flex-row items-center gap-2" testID={`automation-delivery-${d.id}`}>
                <Text className={cn('text-[11px] font-medium uppercase w-16', STATUS_TONE[d.status] ?? 'text-muted-foreground')}>
                  {d.status}
                </Text>
                <View className="flex-1 min-w-0">
                  <Text className="text-xs text-foreground" numberOfLines={1}>
                    {d.summary || d.error || d.event?.type || 'Delivery'}
                  </Text>
                  <Text className="text-[10px] text-muted-foreground">
                    {new Date(d.createdAt).toLocaleString()} · {d.attempts} attempt{d.attempts === 1 ? '' : 's'}
                  </Text>
                </View>
                {d.status !== 'pending' && d.status !== 'running' && trigger.enabled && (
                  <Pressable
                    onPress={() => redeliver(d.id)}
                    disabled={busy === d.id}
                    className="flex-row items-center gap-1 px-2 py-1 border border-border rounded-md active:bg-muted"
                    testID={`automation-redeliver-${d.id}`}
                  >
                    <RotateCcw size={11} className="text-foreground" />
                    <Text className="text-[11px] text-foreground">Redeliver</Text>
                  </Pressable>
                )}
              </View>
            ))
          )}
        </View>
      )}
    </View>
  )
}

export function AutomationsTab({
  onOpenIntegrations,
  onLeaveSettings,
}: { onOpenIntegrations?: () => void; onLeaveSettings?: () => void } = {}) {
  const { AlertCircle, Plus, RefreshCw } = useAccountSheetIcons({
    AlertCircle: AlertCircleIcon,
    Plus: PlusIcon,
    RefreshCw: RefreshCwIcon,
  })
  const http = useDomainHttp()
  const router = useRouter()
  const workspace = useActiveWorkspace()
  const workspaceId = workspace?.id
  const [triggers, setTriggers] = useState<WorkspaceTrigger[]>([])
  const [grants, setGrants] = useState<WorkspaceAppGrant[]>([])
  const [toolkits, setToolkits] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!workspaceId) return
    setLoading(true)
    setError(null)
    try {
      const [t, g] = await Promise.all([
        api.listWorkspaceTriggers(http, workspaceId),
        api.listWorkspaceAppGrants(http, workspaceId),
      ])
      setTriggers(t)
      setGrants(g)
    } catch (err: any) {
      setError(err?.message ?? String(err))
    } finally {
      setLoading(false)
    }
    try {
      const connections = await api.getWorkspaceIntegrationConnections(http, workspaceId)
      setToolkits([...new Set(connections.filter((c) => c.status?.toLowerCase() === 'active').map((c) => c.toolkit ?? ''))].filter(Boolean))
    } catch (err) {
      console.warn(LOG_PREFIX, 'Failed to load connected apps', err)
    }
  }, [http, workspaceId])

  useEffect(() => {
    load()
  }, [load])

  const appNameByInstall = useMemo(
    () => new Map(grants.map((g) => [g.installId, g.app?.title ?? 'App'])),
    [grants],
  )

  const groups = useMemo(() => {
    const bySource = new Map<string, WorkspaceTrigger[]>()
    for (const trigger of triggers) {
      const label = sourceLabel(trigger)
      bySource.set(label, [...(bySource.get(label) ?? []), trigger])
    }
    return [...bySource.entries()].sort(([a], [b]) => (a === 'Shogo' ? -1 : b === 'Shogo' ? 1 : a.localeCompare(b)))
  }, [triggers])

  const replaceTrigger = useCallback((updated: WorkspaceTrigger) => {
    setTriggers((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
  }, [])

  const revoke = useCallback((grant: WorkspaceAppGrant) => {
    confirmAction(
      `Revoke ${grant.app?.title ?? 'this app'}?`,
      'Its triggers stop, its token stops working right away, and it can no longer act in this workspace. You can grant access again from the marketplace.',
      async () => {
        setRevoking(grant.installId)
        setError(null)
        try {
          await api.revokeAppInstall(http, grant.installId)
          await load()
        } catch (err: any) {
          setError(err?.message ?? String(err))
        } finally {
          setRevoking(null)
        }
      },
    )
  }, [http, load])

  const activeGrants = grants.filter((g) => g.status === 'active')

  const createWithAgent = useCallback(() => {
    setChatPrefill(CREATE_AUTOMATION_PROMPT)
    onLeaveSettings?.()
    router.push('/(app)/agent' as any)
  }, [onLeaveSettings, router])

  return (
    <View className="gap-6 pb-12" testID="automations-tab">
      <View>
        <Text className="text-2xl font-semibold text-foreground">Automations</Text>
        <Text className="text-sm text-muted-foreground mt-1">
          What runs when something happens in this workspace or a connected app. Ask the workspace agent to set one
          up, e.g. "when someone joins, welcome them and add them to #onboarding".
        </Text>
      </View>

      {error && (
        <Card>
          <CardContent className="p-3 flex-row items-center gap-2">
            <AlertCircle size={16} className="text-destructive" />
            <Text className="text-xs text-destructive flex-1">{error}</Text>
          </CardContent>
        </Card>
      )}

      <View className="gap-3">
        <View className="flex-row items-center gap-3">
          <Text className="text-sm font-medium text-foreground">
            {triggers.length} trigger{triggers.length === 1 ? '' : 's'}
          </Text>
          <View className="flex-1" />
          <Button variant="outline" size="sm" onPress={load} disabled={loading}>
            <View className="flex-row items-center gap-1.5">
              <RefreshCw size={14} className="text-foreground" />
              <Text className="text-sm text-foreground">Refresh</Text>
            </View>
          </Button>
          <Button size="sm" onPress={createWithAgent} testID="automations-create">
            <View className="flex-row items-center gap-1.5">
              <Plus size={14} className="text-primary-foreground" />
              <Text className="text-sm text-primary-foreground">New automation</Text>
            </View>
          </Button>
        </View>
        {loading && !triggers.length ? (
          <Skeleton className="h-16 w-full rounded-lg" />
        ) : triggers.length === 0 ? (
          <Card>
            <CardContent className="p-4">
              <Text className="text-sm text-muted-foreground">
                No automations yet. Ask the workspace agent, or install an app from the marketplace.
              </Text>
            </CardContent>
          </Card>
        ) : (
          groups.map(([label, rows]) => (
            <View key={label} className="gap-1.5" testID={`automation-group-${label}`}>
              <Text className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</Text>
              <Card>
                <CardContent className="p-0">
                  {rows.map((trigger) => (
                    <TriggerRow
                      key={trigger.id}
                      trigger={trigger}
                      workspaceId={workspaceId!}
                      appName={trigger.installId ? appNameByInstall.get(trigger.installId) ?? 'App' : null}
                      onChanged={replaceTrigger}
                    />
                  ))}
                </CardContent>
              </Card>
            </View>
          ))
        )}
      </View>

      <View className="gap-2">
        <Text className="text-sm font-medium text-foreground">Installed apps with access</Text>
        {activeGrants.length === 0 ? (
          <Text className="text-xs text-muted-foreground">No marketplace app has access to this workspace.</Text>
        ) : (
          <Card>
            <CardContent className="p-0">
              {activeGrants.map((grant) => (
                <View key={grant.id} className="flex-row items-start gap-3 px-3 py-3 border-t border-border first:border-t-0" testID={`app-grant-${grant.installId}`}>
                  <View className="flex-1 min-w-0">
                    <Text className="text-sm font-medium text-foreground">{grant.app?.title ?? 'App'}</Text>
                    <Text className="text-[11px] text-muted-foreground mt-0.5">
                      v{grant.version}{grant.grantedBy ? ` · granted by ${grant.grantedBy.name}` : ''}
                    </Text>
                    <View className="flex-row flex-wrap gap-1 mt-1.5">
                      {grant.grantedScopes.map((scope) => (
                        <Badge key={scope} variant="outline"><Text className="text-[10px] font-mono">{scope}</Text></Badge>
                      ))}
                    </View>
                    {grant.pendingScopes.length > 0 && (
                      <Text className="text-[11px] text-amber-600 mt-1.5">
                        v{grant.pendingVersion} asks for {grant.pendingScopes.join(', ')}. The installer can approve it from
                        the app's marketplace page.
                      </Text>
                    )}
                  </View>
                  <Pressable
                    onPress={() => revoke(grant)}
                    disabled={revoking === grant.installId}
                    className="px-3 py-1.5 border border-destructive/40 rounded-md active:bg-destructive/10"
                    testID={`app-grant-revoke-${grant.installId}`}
                  >
                    <Text className="text-xs text-destructive">{revoking === grant.installId ? 'Revoking…' : 'Revoke'}</Text>
                  </Pressable>
                </View>
              ))}
            </CardContent>
          </Card>
        )}
      </View>

      <View className="gap-2">
        <View className="flex-row items-center">
          <Text className="text-sm font-medium text-foreground flex-1">Connected apps that can trigger automations</Text>
          {onOpenIntegrations && (
            <Pressable onPress={onOpenIntegrations}>
              <Text className="text-xs text-primary">Manage</Text>
            </Pressable>
          )}
        </View>
        <Text className="text-xs text-muted-foreground">
          {toolkits.length
            ? toolkits.join(', ')
            : 'None yet. Connect GitHub, Slack, Linear and more under Integrations to trigger on their events.'}
        </Text>
      </View>
    </View>
  )
}
