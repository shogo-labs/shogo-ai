// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * CustomDomainsSection - bring-your-own custom domain management for a
 * published project (Cloudflare for SaaS custom hostnames).
 *
 * Rendered inside PublishDropdown once an app is published. Lets the user:
 *  - add a domain (e.g. acme.com) — we auto-create the apex/www companion
 *    and link them as a group so the user doesn't have to reason about
 *    subdomains vs. www,
 *  - choose which hostname is primary (the other 308-redirects to it),
 *  - see the exact DNS records to create (CNAME + any SSL/ownership TXT)
 *    with copy buttons and provider hints,
 *  - remove a domain (the whole apex/www group).
 *
 * Verification is automatic: while any domain is still validating the
 * section polls status every 30s, so the domain goes live on its own once
 * DNS + SSL check out (a manual "Check now" stays as a fallback).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { View, Text, TextInput, Pressable, ActivityIndicator, ScrollView, Linking } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { CheckCircle, Copy, Trash2, RefreshCw, RotateCw, AlertTriangle, Globe, ExternalLink, Star, Circle, XCircle } from 'lucide-react-native'
import type { HttpClient } from '@shogo-ai/sdk'
import { cn } from '@shogo/shared-ui/primitives'
import {
  api,
  type CustomDomain,
  type CustomDomainInstruction,
  type CustomDomainStage,
} from '../../lib/api'

/** Customer-facing setup guide (Docusaurus, docs.shogo.ai). */
const SETUP_GUIDE_URL = 'https://docs.shogo.ai/features/custom-domains'

/** How often to re-check status while a domain is still validating. */
const AUTO_POLL_MS = 30_000

interface CustomDomainsSectionProps {
  projectId: string
  /**
   * HTTP client supplied by the caller. This section is rendered inside the
   * publish Popover, whose gluestack overlay teleports content to a root host
   * *outside* the SDKDomainProvider — so calling useDomainHttp() here throws
   * "must be used within SDKDomainProvider" (RootErrorBoundary crash). Callers
   * live in the provider tree and pass their resolved client down instead.
   */
  http: HttpClient
  /**
   * Compact variant for the publish dropdown (default). When false, renders a
   * standalone, scrollable settings pane with a visible empty/disabled state
   * instead of collapsing to null.
   */
  embedded?: boolean
}

// Plain-language label for each DNS record, instead of exposing the raw
// "purpose" enum. Users only need to know "add this, here's why".
const PURPOSE_LABEL: Record<CustomDomainInstruction['purpose'], string> = {
  routing: 'Points your domain to your app',
  'ssl-validation': 'Verifies your SSL certificate',
  'ownership-verification': 'Confirms you own the domain',
}

/** A bare two-label apex like `acme.com` (no `www.`, no deeper subdomain). */
function isApex(hostname: string): boolean {
  return !hostname.startsWith('www.') && hostname.split('.').length === 2
}

/** Stable grouping key: the apex/www group, or the row itself when standalone. */
function groupKey(d: CustomDomain): string {
  return d.groupId ?? d.id
}

/** Collapse the flat domain list into apex/www groups, preserving order. */
function groupDomains(domains: CustomDomain[]): CustomDomain[][] {
  const order: string[] = []
  const map = new Map<string, CustomDomain[]>()
  for (const d of domains) {
    const k = groupKey(d)
    if (!map.has(k)) {
      map.set(k, [])
      order.push(k)
    }
    map.get(k)!.push(d)
  }
  // Within a group show the primary (canonical) hostname first.
  return order.map((k) =>
    map.get(k)!.slice().sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0)),
  )
}

/** "just now" / "5m ago" / "2h ago" from an epoch-ms timestamp. */
function formatAge(since?: number): string | null {
  if (!since) return null
  const ms = Date.now() - since
  if (ms < 60_000) return 'just now'
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

/** Human "retry in N" copy from a cooldown/age remaining (ms). */
function formatWait(ms?: number): string {
  const mins = Math.max(1, Math.ceil((ms ?? 0) / 60_000))
  return mins === 1 ? '1 minute' : `${mins} minutes`
}

/** The four customer-facing steps; `stage` maps to where we are. */
const TIMELINE_STEPS = ['Add records', 'Validate DNS', 'Issue certificate', 'Live'] as const

/** Index of the step a given stage sits at (stalled rides the cert step). */
function stageStep(stage: CustomDomainStage | undefined): number {
  switch (stage) {
    case 'awaiting_dns':
      return 0
    case 'validating':
      return 1
    case 'issuing':
    case 'stalled':
      return 2
    case 'active':
      return 3
    default:
      return 0
  }
}

/**
 * Compact horizontal stepper: completed steps show a green check, the current
 * step a spinner (or amber dot when stalled), later steps a hollow circle. A
 * failed domain renders the current step in red.
 */
function StatusTimeline({ domain }: { domain: CustomDomain }) {
  const stage = domain.stage
  const failed = domain.status === 'failed'
  const stalled = stage === 'stalled'
  const current = failed ? Math.max(0, stageStep(stage)) : stageStep(stage)
  return (
    <View className="flex-row items-center gap-1 mt-1">
      {TIMELINE_STEPS.map((label, i) => {
        const done = !failed && (domain.status === 'active' ? true : i < current)
        const isCurrent = i === current && domain.status !== 'active'
        return (
          <View key={label} className="flex-row items-center">
            <View className="items-center gap-0.5" style={{ minWidth: 58 }}>
              {done ? (
                <CheckCircle size={13} color="#10b981" />
              ) : isCurrent && failed ? (
                <XCircle size={13} color="#ef4444" />
              ) : isCurrent && stalled ? (
                <AlertTriangle size={12} color="#f59e0b" />
              ) : isCurrent ? (
                <ActivityIndicator size="small" />
              ) : (
                <Circle size={12} className="text-muted-foreground" />
              )}
              <Text
                className={cn(
                  'text-[9px] text-center',
                  done
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : isCurrent && failed
                      ? 'text-destructive'
                      : isCurrent
                        ? 'text-foreground'
                        : 'text-muted-foreground',
                )}
                numberOfLines={1}
              >
                {label}
              </Text>
            </View>
            {i < TIMELINE_STEPS.length - 1 && (
              <View className={cn('h-px w-3', done ? 'bg-emerald-500' : 'bg-border')} />
            )}
          </View>
        )
      })}
    </View>
  )
}

/** Tick for a single DNS record, derived from the server-side DNS verdict. */
function recordTick(domain: CustomDomain, record: CustomDomainInstruction) {
  if (record.type === 'CNAME') return domain.dns?.cname
  if (record.purpose === 'ssl-validation') {
    const match = domain.validation?.find((v) => v.name === record.name)
    if (match) return match.status === 'active' ? 'ok' : 'pending'
    if (domain.dns) return domain.dns.txt === 'ok' ? 'ok' : domain.dns.txt === 'missing' ? 'missing' : 'partial'
  }
  return undefined
}

function StatusBadge({ domain }: { domain: CustomDomain }) {
  const map: Record<CustomDomain['status'], { label: string; className: string }> = {
    pending: { label: 'Awaiting DNS', className: 'text-amber-600 dark:text-amber-400' },
    verifying: { label: 'Issuing certificate', className: 'text-blue-600 dark:text-blue-400' },
    active: { label: 'Live', className: 'text-emerald-600 dark:text-emerald-400' },
    failed: { label: 'Action needed', className: 'text-destructive' },
  }
  const s = map[domain.status]
  return <Text className={cn('text-[11px] font-medium', s.className)}>{s.label}</Text>
}

/** Small ✓ / ✗ / … indicator for whether a record has been detected. */
function RecordTick({ status }: { status?: 'ok' | 'wrong' | 'missing' | 'partial' | 'pending' }) {
  if (status === 'ok') {
    return (
      <View className="flex-row items-center gap-1">
        <CheckCircle size={11} color="#10b981" />
        <Text className="text-[9px] text-emerald-600 dark:text-emerald-400">Found</Text>
      </View>
    )
  }
  if (status === 'wrong') {
    return (
      <View className="flex-row items-center gap-1">
        <XCircle size={11} color="#ef4444" />
        <Text className="text-[9px] text-destructive">Wrong target</Text>
      </View>
    )
  }
  if (status === 'partial') {
    return (
      <View className="flex-row items-center gap-1">
        <AlertTriangle size={10} color="#f59e0b" />
        <Text className="text-[9px] text-amber-600 dark:text-amber-400">Incomplete</Text>
      </View>
    )
  }
  if (status === 'missing' || status === 'pending') {
    return <Text className="text-[9px] text-muted-foreground">Not detected yet</Text>
  }
  return null
}

function DnsRecordRow({
  record,
  status,
}: {
  record: CustomDomainInstruction
  status?: 'ok' | 'wrong' | 'missing' | 'partial' | 'pending'
}) {
  const [copied, setCopied] = useState<'name' | 'value' | null>(null)

  const copy = useCallback(async (which: 'name' | 'value', text: string) => {
    await Clipboard.setStringAsync(text)
    setCopied(which)
    setTimeout(() => setCopied(null), 1200)
  }, [])

  return (
    <View className="gap-1 p-2 rounded-md bg-muted/50 border border-border">
      <View className="flex-row items-center justify-between">
        <Text className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {record.type} · {PURPOSE_LABEL[record.purpose]}
        </Text>
        <RecordTick status={status} />
      </View>
      <Field label="Name" value={record.name} copied={copied === 'name'} onCopy={() => copy('name', record.name)} />
      <Field label="Value" value={record.value} copied={copied === 'value'} onCopy={() => copy('value', record.value)} />
    </View>
  )
}

function Field({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string
  value: string
  copied: boolean
  onCopy: () => void
}) {
  return (
    <View className="flex-row items-center gap-2">
      <Text className="text-[10px] text-muted-foreground w-10">{label}</Text>
      <Text className="flex-1 text-[11px] font-mono text-foreground" numberOfLines={1}>
        {value}
      </Text>
      <Pressable onPress={onCopy} hitSlop={6} className="p-1 rounded active:bg-muted">
        {copied ? <CheckCircle size={13} color="#10b981" /> : <Copy size={13} className="text-muted-foreground" />}
      </Pressable>
    </View>
  )
}

export function CustomDomainsSection({ projectId, http, embedded = true }: CustomDomainsSectionProps) {
  const [loading, setLoading] = useState(true)
  const [enabled, setEnabled] = useState(false)
  const [domains, setDomains] = useState<CustomDomain[]>([])
  const [hostname, setHostname] = useState('')
  const [adding, setAdding] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await api.getCustomDomains(http, projectId)
      setEnabled(data.enabled)
      setDomains(data.domains)
    } catch {
      // Leave whatever we have; surfacing a load error here would be noise.
    } finally {
      setLoading(false)
    }
  }, [http, projectId])

  useEffect(() => {
    load()
  }, [load])

  // Merge freshly returned domains (from add/verify/primary) into local
  // state, preserving instructions the list endpoint omits.
  const upsertDomains = useCallback((incoming: CustomDomain[]) => {
    setDomains((prev) => {
      const next = [...prev]
      for (const d of incoming) {
        const idx = next.findIndex((x) => x.id === d.id)
        if (idx === -1) next.push(d)
        else next[idx] = { ...next[idx], ...d }
      }
      return next
    })
  }, [])

  const handleAdd = useCallback(async () => {
    const trimmed = hostname.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    if (!trimmed) return
    setAdding(true)
    setError(null)
    try {
      const created = await api.addCustomDomain(http, projectId, trimmed)
      upsertDomains(created)
      setHostname('')
    } catch (err: any) {
      setError(err?.message || 'Failed to add domain')
    } finally {
      setAdding(false)
    }
  }, [http, projectId, hostname, upsertDomains])

  const handleVerify = useCallback(async (domainId: string) => {
    setBusyId(domainId)
    setError(null)
    try {
      const updated = await api.verifyCustomDomain(http, projectId, domainId)
      upsertDomains(updated)
    } catch (err: any) {
      setError(err?.message || 'Failed to check status')
    } finally {
      setBusyId(null)
    }
  }, [http, projectId, upsertDomains])

  const handleRetrigger = useCallback(async (domainId: string) => {
    setBusyId(domainId)
    setError(null)
    try {
      const updated = await api.retriggerCustomDomain(http, projectId, domainId)
      upsertDomains(updated)
    } catch (err: any) {
      setError(err?.message || 'Failed to retry certificate issuance')
    } finally {
      setBusyId(null)
    }
  }, [http, projectId, upsertDomains])

  const handleMakePrimary = useCallback(async (domainId: string) => {
    setBusyId(domainId)
    setError(null)
    try {
      const updated = await api.setPrimaryDomain(http, projectId, domainId)
      upsertDomains(updated)
    } catch (err: any) {
      setError(err?.message || 'Failed to update primary domain')
    } finally {
      setBusyId(null)
    }
  }, [http, projectId, upsertDomains])

  const handleRemoveGroup = useCallback(async (group: CustomDomain[]) => {
    const ids = group.map((d) => d.id)
    setBusyId(ids[0] ?? null)
    setError(null)
    try {
      // The API removes the whole group from any member id.
      const removed = await api.removeCustomDomain(http, projectId, ids[0])
      const removedSet = new Set(removed.length ? removed : ids)
      setDomains((prev) => prev.filter((d) => !removedSet.has(d.id)))
    } catch (err: any) {
      setError(err?.message || 'Failed to remove domain')
    } finally {
      setBusyId(null)
    }
  }, [http, projectId])

  // Auto-poll while anything is still validating, without a manual tap. Polls
  // one member per still-pending group (verify re-checks the whole group) and
  // stops once everything is active/failed. A ref tracks in-flight polling so
  // overlapping ticks don't stack.
  const pollingRef = useRef(false)
  useEffect(() => {
    const groups = groupDomains(domains)
    const pendingGroups = groups.filter((g) =>
      g.some((d) => d.status === 'pending' || d.status === 'verifying'),
    )
    if (pendingGroups.length === 0) return

    const tick = async () => {
      if (pollingRef.current) return
      pollingRef.current = true
      try {
        for (const g of pendingGroups) {
          const target = g.find((d) => d.status === 'pending' || d.status === 'verifying')
          if (!target) continue
          try {
            const updated = await api.verifyCustomDomain(http, projectId, target.id)
            upsertDomains(updated)
          } catch {
            // Best-effort; the next tick retries.
          }
        }
      } finally {
        pollingRef.current = false
      }
    }

    const id = setInterval(tick, AUTO_POLL_MS)
    return () => clearInterval(id)
  }, [domains, http, projectId, upsertDomains])

  if (loading) {
    return (
      <View className={cn('items-center', embedded ? 'py-3' : 'flex-1 justify-center')}>
        <ActivityIndicator size="small" />
      </View>
    )
  }

  const header = (
    <>
      <View className="flex-row items-center gap-1.5 mb-1">
        <Globe size={embedded ? 13 : 15} className="text-muted-foreground" />
        <Text className={cn('font-medium text-foreground', embedded ? 'text-xs' : 'text-sm')}>
          Custom domain
        </Text>
      </View>
      <Text className="text-[11px] text-muted-foreground mb-1.5">
        Serve this app from a domain you own, like <Text className="font-mono">acme.com</Text>. We
        set up <Text className="font-mono">www</Text> and a redirect for you automatically.
      </Text>
      <Pressable
        onPress={() => Linking.openURL(SETUP_GUIDE_URL)}
        hitSlop={6}
        className="flex-row items-center gap-1 mb-2 self-start"
      >
        <Text className="text-[11px] font-medium text-primary">Read the setup guide</Text>
        <ExternalLink size={11} className="text-primary" />
      </Pressable>
    </>
  )

  // Feature flag off for this deployment. The publish dropdown hides the
  // section entirely (keep it clean); the standalone settings pane explains
  // the empty state instead of rendering nothing.
  if (!enabled) {
    if (embedded) return null
    return (
      <ScrollView className="flex-1 bg-background" contentContainerStyle={{ padding: 16 }}>
        {header}
        <Text className="text-[11px] text-muted-foreground">
          Custom domains aren&apos;t available on this deployment yet.
        </Text>
      </ScrollView>
    )
  }

  const groups = groupDomains(domains)

  const body = (
    <>
      {header}

      {/* Fuller guidance only in the standalone settings pane; the publish
          dropdown stays compact and links out to the guide instead. */}
      {!embedded && (
        <View className="mb-3 p-3 rounded-lg bg-muted/50 border border-border gap-1.5">
          <Text className="text-[11px] font-medium text-foreground">How it works</Text>
          <Text className="text-[11px] text-muted-foreground">
            1. Enter your domain below — your root domain like{' '}
            <Text className="font-mono">acme.com</Text> is fine. We add{' '}
            <Text className="font-mono">www.acme.com</Text> too and redirect one to the other.
          </Text>
          <Text className="text-[11px] text-muted-foreground">
            2. Add the DNS records we show you at your domain provider.
          </Text>
          <Text className="text-[11px] text-muted-foreground">
            3. That&apos;s it — your domain goes live on its own once DNS and SSL check out,
            usually within a few minutes.
          </Text>
        </View>
      )}

      {/* Existing domains, grouped as apex/www pairs */}
      {groups.map((group) => {
        const primary = group.find((d) => d.primary) ?? group[0]
        const groupBusy = group.some((d) => busyId === d.id)
        const hasApex = group.some((d) => isApex(d.hostname))
        const groupCanRetrigger = group.some((d) => d.canRetrigger)
        const retriggerTarget = group.find((d) => d.canRetrigger) ?? primary
        const groupStalled = group.some((d) => d.stage === 'stalled')
        const stalledWaitMs = group.map((d) => d.retriggerCooldownMs).find((ms) => ms != null) ?? null
        return (
          <View key={groupKey(group[0])} className="mb-2 p-3 rounded-lg border border-border gap-2">
            <View className="flex-row items-center justify-between">
              <Text className="text-sm text-foreground flex-1" numberOfLines={1}>
                {primary.hostname}
              </Text>
              <Pressable
                onPress={() => handleRemoveGroup(group)}
                disabled={groupBusy}
                hitSlop={6}
                className="p-1 rounded active:bg-muted"
              >
                <Trash2 size={14} className="text-muted-foreground" />
              </Pressable>
            </View>

            {/* Lifecycle timeline + plain-language explanation of what's
                happening (driven by the server-derived stage/message). */}
            <StatusTimeline domain={primary} />
            {primary.message && (
              <Text
                className={cn(
                  'text-[11px]',
                  primary.stage === 'stalled'
                    ? 'text-amber-600 dark:text-amber-400'
                    : primary.status === 'failed'
                      ? 'text-destructive'
                      : 'text-muted-foreground',
                )}
              >
                {primary.message}
              </Text>
            )}
            {primary.status !== 'active' && formatAge(primary.createdAt) && (
              <Text className="text-[10px] text-muted-foreground">
                Submitted {formatAge(primary.createdAt)}
                {primary.lastCheckedAt ? ` · last checked ${formatAge(primary.lastCheckedAt)}` : ''}
              </Text>
            )}

            {group.length > 1 && (
              <Text className="text-[11px] text-muted-foreground">
                <Text className="font-mono">{primary.hostname}</Text> is your primary address
                {group
                  .filter((d) => d.id !== primary.id)
                  .map((d) => (
                    <Text key={d.id}>
                      {' '}
                      · <Text className="font-mono">{d.hostname}</Text> redirects to it
                    </Text>
                  ))}
              </Text>
            )}

            {group.map((d) => (
              <View key={d.id} className="gap-2 pt-1">
                <View className="flex-row items-center gap-2">
                  <Text className="text-[12px] font-mono text-foreground flex-1" numberOfLines={1}>
                    {d.hostname}
                  </Text>
                  {d.primary ? (
                    group.length > 1 ? (
                      <View className="flex-row items-center gap-1">
                        <Star size={11} color="#f59e0b" fill="#f59e0b" />
                        <Text className="text-[10px] text-amber-600 dark:text-amber-400">Primary</Text>
                      </View>
                    ) : null
                  ) : (
                    <Pressable
                      onPress={() => handleMakePrimary(d.id)}
                      disabled={groupBusy}
                      hitSlop={6}
                      className="px-1.5 py-0.5 rounded border border-border active:bg-muted"
                    >
                      <Text className="text-[10px] text-muted-foreground">Make primary</Text>
                    </Pressable>
                  )}
                  <StatusBadge domain={d} />
                </View>

                {d.status === 'failed' && d.error && (
                  <View className="flex-row items-start gap-1.5">
                    <AlertTriangle size={12} color="#ef4444" />
                    <Text className="text-[11px] text-destructive flex-1">{d.error}</Text>
                  </View>
                )}

                {d.status === 'active' ? (
                  <View className="flex-row items-center gap-1.5">
                    <CheckCircle size={13} color="#10b981" />
                    <Text className="text-[11px] text-emerald-600 dark:text-emerald-400">
                      Certificate issued — your domain is live.
                    </Text>
                  </View>
                ) : d.instructions && d.instructions.length > 0 ? (
                  <View className="gap-2">
                    <Text className="text-[11px] text-muted-foreground">
                      Add these records at your DNS provider — we check automatically:
                    </Text>
                    {d.instructions.map((rec, i) => (
                      <DnsRecordRow key={`${rec.type}-${rec.name}-${i}`} record={rec} status={recordTick(d, rec)} />
                    ))}
                  </View>
                ) : (
                  <Text className="text-[11px] text-muted-foreground">
                    Checking status… the DNS records you need will appear here.
                  </Text>
                )}
              </View>
            ))}

            {hasApex && group.some((d) => d.status !== 'active') && (
              <Text className="text-[10px] text-muted-foreground">
                Using Cloudflare, Route 53, or another provider with CNAME flattening? You can point
                your root domain directly with the CNAME above. Otherwise the{' '}
                <Text className="font-mono">www</Text> record is all you need.
              </Text>
            )}

            {group.some((d) => d.status !== 'active') && (
              <View className="gap-2">
                {/* Stalled but not yet retriggerable (cooldown): tell the user
                    when they can retry instead of a dead/disabled button. */}
                {!groupCanRetrigger && groupStalled && stalledWaitMs != null && (
                  <Text className="text-[10px] text-amber-600 dark:text-amber-400">
                    Taking longer than usual. You can retry certificate issuance in {formatWait(stalledWaitMs)}.
                  </Text>
                )}
                <View className="flex-row items-center gap-2">
                  <Pressable
                    onPress={() => handleVerify(primary.id)}
                    disabled={groupBusy}
                    className="flex-1 flex-row items-center justify-center gap-1.5 h-8 rounded-md border border-border active:bg-muted"
                  >
                    {groupBusy ? (
                      <ActivityIndicator size="small" />
                    ) : (
                      <>
                        <RefreshCw size={12} className="text-foreground" />
                        <Text className="text-xs font-medium text-foreground">Check now</Text>
                      </>
                    )}
                  </Pressable>
                  {groupCanRetrigger && (
                    <Pressable
                      onPress={() => handleRetrigger(retriggerTarget.id)}
                      disabled={groupBusy}
                      className="flex-1 flex-row items-center justify-center gap-1.5 h-8 rounded-md bg-amber-500/15 border border-amber-500/40 active:bg-amber-500/25"
                    >
                      {groupBusy ? (
                        <ActivityIndicator size="small" />
                      ) : (
                        <>
                          <RotateCw size={12} color="#d97706" />
                          <Text className="text-xs font-medium text-amber-700 dark:text-amber-400">
                            Retry certificate
                          </Text>
                        </>
                      )}
                    </Pressable>
                  )}
                </View>
              </View>
            )}
          </View>
        )
      })}

      {/* Add a domain */}
      <View className="flex-row items-center gap-2">
        <TextInput
          value={hostname}
          onChangeText={(t) => setHostname(t.replace(/\s/g, ''))}
          placeholder="acme.com"
          placeholderTextColor="#9ca3af"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          onSubmitEditing={handleAdd}
          className="flex-1 h-9 px-3 text-sm text-foreground border border-border rounded-lg web:outline-none"
        />
        <Pressable
          onPress={handleAdd}
          disabled={adding || hostname.trim().length === 0}
          className={cn(
            'h-9 px-3 rounded-lg items-center justify-center',
            adding || hostname.trim().length === 0 ? 'bg-muted' : 'bg-primary',
          )}
        >
          {adding ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text
              className={cn(
                'text-xs font-medium',
                hostname.trim().length === 0 ? 'text-muted-foreground' : 'text-primary-foreground',
              )}
            >
              Add
            </Text>
          )}
        </Pressable>
      </View>

      {error && <Text className="text-[11px] text-destructive mt-1.5">{error}</Text>}
    </>
  )

  if (!embedded) {
    return (
      <ScrollView className="flex-1 bg-background" contentContainerStyle={{ padding: 16 }}>
        {body}
      </ScrollView>
    )
  }

  return <View className="mb-4 pt-4 border-t border-border">{body}</View>
}
