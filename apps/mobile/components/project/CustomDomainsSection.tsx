// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * CustomDomainsSection - bring-your-own custom domain management for a
 * published project (Cloudflare for SaaS custom hostnames).
 *
 * Rendered inside PublishDropdown once an app is published. Lets the user:
 *  - add a domain (e.g. app.acme.com),
 *  - see the exact DNS records they must create (CNAME + any SSL/ownership
 *    TXT records) with copy buttons,
 *  - re-check verification/SSL status,
 *  - remove a domain.
 */

import { useCallback, useEffect, useState } from 'react'
import { View, Text, TextInput, Pressable, ActivityIndicator, ScrollView } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { CheckCircle, Copy, Trash2, RefreshCw, AlertTriangle, Globe } from 'lucide-react-native'
import type { HttpClient } from '@shogo-ai/sdk'
import { cn } from '@shogo/shared-ui/primitives'
import { api, type CustomDomain, type CustomDomainInstruction } from '../../lib/api'

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

const PURPOSE_LABEL: Record<CustomDomainInstruction['purpose'], string> = {
  routing: 'Point your domain here',
  'ssl-validation': 'SSL certificate validation',
  'ownership-verification': 'Domain ownership',
}

function StatusBadge({ domain }: { domain: CustomDomain }) {
  const map: Record<CustomDomain['status'], { label: string; className: string }> = {
    pending: { label: 'Awaiting DNS', className: 'text-amber-600 dark:text-amber-400' },
    verifying: { label: 'Verifying', className: 'text-blue-600 dark:text-blue-400' },
    active: { label: 'Live', className: 'text-emerald-600 dark:text-emerald-400' },
    failed: { label: 'Failed', className: 'text-destructive' },
  }
  const s = map[domain.status]
  return <Text className={cn('text-[11px] font-medium', s.className)}>{s.label}</Text>
}

function DnsRecordRow({ record }: { record: CustomDomainInstruction }) {
  const [copied, setCopied] = useState<'name' | 'value' | null>(null)

  const copy = useCallback(async (which: 'name' | 'value', text: string) => {
    await Clipboard.setStringAsync(text)
    setCopied(which)
    setTimeout(() => setCopied(null), 1200)
  }, [])

  return (
    <View className="gap-1 p-2 rounded-md bg-muted/50 border border-border">
      <Text className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {record.type} · {PURPOSE_LABEL[record.purpose]}
      </Text>
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

  // Merge a freshly returned domain (from add/verify) into local state,
  // preserving the instructions which the list endpoint omits.
  const upsertDomain = useCallback((d: CustomDomain) => {
    setDomains((prev) => {
      const idx = prev.findIndex((x) => x.id === d.id)
      if (idx === -1) return [...prev, d]
      const next = [...prev]
      next[idx] = { ...next[idx], ...d }
      return next
    })
  }, [])

  const handleAdd = useCallback(async () => {
    const trimmed = hostname.trim().toLowerCase()
    if (!trimmed) return
    setAdding(true)
    setError(null)
    try {
      const d = await api.addCustomDomain(http, projectId, trimmed)
      upsertDomain(d)
      setHostname('')
    } catch (err: any) {
      setError(err?.message || 'Failed to add domain')
    } finally {
      setAdding(false)
    }
  }, [http, projectId, hostname, upsertDomain])

  const handleVerify = useCallback(async (domainId: string) => {
    setBusyId(domainId)
    setError(null)
    try {
      const d = await api.verifyCustomDomain(http, projectId, domainId)
      upsertDomain(d)
    } catch (err: any) {
      setError(err?.message || 'Failed to check status')
    } finally {
      setBusyId(null)
    }
  }, [http, projectId, upsertDomain])

  const handleRemove = useCallback(async (domainId: string) => {
    setBusyId(domainId)
    setError(null)
    try {
      await api.removeCustomDomain(http, projectId, domainId)
      setDomains((prev) => prev.filter((d) => d.id !== domainId))
    } catch (err: any) {
      setError(err?.message || 'Failed to remove domain')
    } finally {
      setBusyId(null)
    }
  }, [http, projectId])

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
      <Text className="text-[11px] text-muted-foreground mb-2">
        Serve this app from a domain you own.
      </Text>
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

  const body = (
    <>
      {header}

      {/* Existing domains */}
      {domains.map((d) => (
        <View key={d.id} className="mb-2 p-3 rounded-lg border border-border gap-2">
          <View className="flex-row items-center justify-between">
            <Text className="text-sm text-foreground flex-1" numberOfLines={1}>
              {d.hostname}
            </Text>
            <View className="flex-row items-center gap-2">
              <StatusBadge domain={d} />
              <Pressable onPress={() => handleRemove(d.id)} disabled={busyId === d.id} hitSlop={6} className="p-1 rounded active:bg-muted">
                <Trash2 size={14} className="text-muted-foreground" />
              </Pressable>
            </View>
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
          ) : (
            <>
              {d.instructions && d.instructions.length > 0 ? (
                <View className="gap-2">
                  <Text className="text-[11px] text-muted-foreground">
                    Add these records at your DNS provider, then check status:
                  </Text>
                  {d.instructions.map((rec, i) => (
                    <DnsRecordRow key={`${rec.type}-${rec.name}-${i}`} record={rec} />
                  ))}
                </View>
              ) : (
                <Text className="text-[11px] text-muted-foreground">
                  Check status to fetch the DNS records you need to add.
                </Text>
              )}
              <Pressable
                onPress={() => handleVerify(d.id)}
                disabled={busyId === d.id}
                className="flex-row items-center justify-center gap-1.5 h-8 rounded-md border border-border active:bg-muted"
              >
                {busyId === d.id ? (
                  <ActivityIndicator size="small" />
                ) : (
                  <>
                    <RefreshCw size={12} className="text-foreground" />
                    <Text className="text-xs font-medium text-foreground">Check status</Text>
                  </>
                )}
              </Pressable>
            </>
          )}
        </View>
      ))}

      {/* Add a domain */}
      <View className="flex-row items-center gap-2">
        <TextInput
          value={hostname}
          onChangeText={(t) => setHostname(t.replace(/\s/g, ''))}
          placeholder="app.example.com"
          placeholderTextColor="#9ca3af"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
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
