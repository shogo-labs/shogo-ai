// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin Mint License Keys
 *
 * Generates a batch of single-use license keys via
 * `POST /api/admin/license-keys/mint`. The endpoint returns the plaintext
 * codes EXACTLY ONCE — they are never persisted and cannot be recovered —
 * so on success we swap the form for a result panel that lets the admin
 * download a CSV or copy the codes before navigating away.
 */

import { useState } from 'react'
import {
  View,
  Text,
  ScrollView,
  Pressable,
  TextInput,
  ActivityIndicator,
  Platform,
} from 'react-native'
import { useRouter } from 'expo-router'
import * as Clipboard from 'expo-clipboard'
import {
  ArrowLeft,
  KeyRound,
  Sparkles,
  Download,
  Copy,
  Check,
  AlertTriangle,
  Link as LinkIcon,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { API_URL } from '../../../lib/api'

const API_BASE = `${API_URL}/api/admin`

interface MintedKey {
  id: string
  plaintext: string
  codePrefix: string
  planId: string
  expiresAt: string | null
}

interface MintResponse {
  keys: MintedKey[]
  count: number
}

async function postMint(body: unknown): Promise<{ ok: boolean; data?: MintResponse; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}/license-keys/mint`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = await res.json().catch(() => null)
    if (!res.ok) {
      return { ok: false, error: json?.error?.message ?? `HTTP ${res.status}` }
    }
    return { ok: true, data: json?.data }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'request failed' }
  }
}

// Only paid tiers may be minted — the backend rejects `free`.
const PLAN_OPTIONS = [
  { id: 'basic', label: 'Basic' },
  { id: 'pro', label: 'Pro' },
  { id: 'business', label: 'Business' },
  { id: 'enterprise', label: 'Enterprise' },
] as const

type PlanId = (typeof PLAN_OPTIONS)[number]['id']

function showAlert(title: string, message?: string): void {
  if (typeof window !== 'undefined' && typeof window.alert === 'function') {
    window.alert(message ? `${title}\n\n${message}` : title)
  }
}

// Recipients land on the billing screen with the code prefilled. On web
// we use the current origin so the link opens the same deployment; native
// shares fall back to the `shogo://` scheme.
function buildRedeemLink(code: string): string {
  const path = `/billing?redeem=${encodeURIComponent(code)}`
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    return `${window.location.origin}${path}`
  }
  return `shogo:/${path}`
}

function buildCsv(keys: MintedKey[]): string {
  const header = 'code,plan,prefix,expiresAt,id,redeemLink'
  const rows = keys.map((k) =>
    [k.plaintext, k.planId, k.codePrefix, k.expiresAt ?? '', k.id, buildRedeemLink(k.plaintext)]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(','),
  )
  return [header, ...rows].join('\n')
}

function downloadCsv(keys: MintedKey[], batchId: string): void {
  const csv = buildCsv(keys)
  if (Platform.OS === 'web' && typeof document !== 'undefined') {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const stamp = new Date().toISOString().slice(0, 10)
    a.download = `license-keys-${batchId || 'batch'}-${stamp}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  } else {
    Clipboard.setStringAsync(csv)
    showAlert('Copied', 'CSV is not downloadable on this platform — copied to clipboard instead.')
  }
}

export default function MintLicenseKeysPage() {
  const router = useRouter()

  const [count, setCount] = useState('10')
  const [planId, setPlanId] = useState<PlanId>('pro')
  const [durationDays, setDurationDays] = useState('')
  const [monthlyIncludedUsd, setMonthlyIncludedUsd] = useState('0')
  const [freeSeats, setFreeSeats] = useState('0')
  const [batchId, setBatchId] = useState('')
  const [codePrefix, setCodePrefix] = useState('SHGO-PRO')
  const [expiresAt, setExpiresAt] = useState('')
  const [note, setNote] = useState('')

  const [minting, setMinting] = useState(false)
  const [result, setResult] = useState<MintResponse | null>(null)
  const [copiedAll, setCopiedAll] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [copiedLinkId, setCopiedLinkId] = useState<string | null>(null)

  const onMint = async () => {
    const parsedCount = parseInt(count || '0', 10)
    if (!Number.isFinite(parsedCount) || parsedCount < 1 || parsedCount > 10_000) {
      showAlert('Validation', 'Count must be between 1 and 10,000.')
      return
    }

    const body: Record<string, unknown> = {
      count: parsedCount,
      planId,
      monthlyIncludedUsd: Math.max(0, parseFloat(monthlyIncludedUsd || '0') || 0),
      freeSeats: Math.max(0, parseInt(freeSeats || '0', 10) || 0),
    }
    const dur = parseInt(durationDays || '0', 10)
    if (durationDays.trim() && dur > 0) body.durationDays = dur
    if (batchId.trim()) body.batchId = batchId.trim()
    if (codePrefix.trim()) body.codePrefix = codePrefix.trim()
    if (note.trim()) body.note = note.trim()
    if (expiresAt.trim()) {
      const d = new Date(expiresAt.trim())
      if (Number.isNaN(d.getTime())) {
        showAlert('Validation', 'Expires at must be a valid date (YYYY-MM-DD).')
        return
      }
      body.expiresAt = d.toISOString()
    }

    setMinting(true)
    const res = await postMint(body)
    setMinting(false)
    if (!res.ok || !res.data) {
      showAlert('Mint failed', res.error ?? 'Unknown error')
      return
    }
    setResult(res.data)
  }

  const onCopyAll = async () => {
    if (!result) return
    await Clipboard.setStringAsync(result.keys.map((k) => k.plaintext).join('\n'))
    setCopiedAll(true)
    setTimeout(() => setCopiedAll(false), 1500)
  }

  const onCopyOne = async (key: MintedKey) => {
    await Clipboard.setStringAsync(key.plaintext)
    setCopiedId(key.id)
    setTimeout(() => setCopiedId((id) => (id === key.id ? null : id)), 1500)
  }

  const onCopyLink = async (key: MintedKey) => {
    await Clipboard.setStringAsync(buildRedeemLink(key.plaintext))
    setCopiedLinkId(key.id)
    setTimeout(() => setCopiedLinkId((id) => (id === key.id ? null : id)), 1500)
  }

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 48 }}
      showsVerticalScrollIndicator={false}
    >
      <View style={{ maxWidth: 760, width: '100%', alignSelf: 'center' }}>
        <Pressable
          onPress={() => router.replace('/(admin)/license-keys' as any)}
          className="flex-row items-center gap-2 mb-4 self-start py-1.5 px-3 rounded-lg border border-border active:bg-muted/50"
        >
          <ArrowLeft size={16} className="text-muted-foreground" />
          <Text className="text-sm text-muted-foreground font-medium">Back to license keys</Text>
        </Pressable>

        <View className="rounded-xl border border-border bg-card p-5 mb-4">
          <View className="flex-row items-center gap-3">
            <View className="h-10 w-10 rounded-lg bg-primary/10 items-center justify-center">
              <KeyRound size={18} className="text-primary" />
            </View>
            <View className="flex-1">
              <Text className="text-base font-bold text-foreground">Mint license keys</Text>
              <Text className="text-xs text-muted-foreground mt-0.5">
                Single-use coupons that upgrade a workspace on redemption.
              </Text>
            </View>
          </View>
        </View>

        {result ? (
          <ResultPanel
            result={result}
            batchId={batchId}
            copiedAll={copiedAll}
            copiedId={copiedId}
            copiedLinkId={copiedLinkId}
            onCopyAll={onCopyAll}
            onCopyOne={onCopyOne}
            onCopyLink={onCopyLink}
            onDownload={() => downloadCsv(result.keys, batchId)}
            onMintMore={() => {
              setResult(null)
              setCopiedAll(false)
              setCopiedId(null)
              setCopiedLinkId(null)
            }}
          />
        ) : (
          <View className="rounded-xl border border-border bg-card p-5 gap-4">
            <View className="flex-row gap-4">
              <View className="flex-1">
                <Field
                  label="Count"
                  value={count}
                  onChange={setCount}
                  keyboardType="number-pad"
                  placeholder="10"
                  hint="1–10,000 keys per batch."
                />
              </View>
              <View className="flex-1">
                <Field
                  label="Code prefix"
                  value={codePrefix}
                  onChange={setCodePrefix}
                  placeholder="SHGO-PRO"
                  mono
                />
              </View>
            </View>

            <PlanPicker value={planId} onChange={setPlanId} />

            <View className="flex-row gap-4">
              <View className="flex-1">
                <Field
                  label="Free seats"
                  value={freeSeats}
                  onChange={setFreeSeats}
                  keyboardType="number-pad"
                  placeholder="0"
                  hint="Stacked into the redeemed grant."
                />
              </View>
              <View className="flex-1">
                <Field
                  label="Monthly USD"
                  value={monthlyIncludedUsd}
                  onChange={setMonthlyIncludedUsd}
                  keyboardType="decimal-pad"
                  placeholder="0"
                  hint="Extra USD credit per cycle."
                />
              </View>
            </View>

            <View className="flex-row gap-4">
              <View className="flex-1">
                <Field
                  label="Duration (days)"
                  value={durationDays}
                  onChange={setDurationDays}
                  keyboardType="number-pad"
                  placeholder="perpetual"
                  hint="Grant length after redemption. Blank = perpetual."
                />
              </View>
              <View className="flex-1">
                <Field
                  label="Key expires at (YYYY-MM-DD)"
                  value={expiresAt}
                  onChange={setExpiresAt}
                  placeholder="never"
                  hint="Deadline to redeem the key itself."
                />
              </View>
            </View>

            <Field
              label="Batch ID (optional)"
              value={batchId}
              onChange={setBatchId}
              placeholder="e.g. hn-launch-2026"
            />

            <Field
              label="Note (internal, optional)"
              value={note}
              onChange={setNote}
              placeholder="e.g. Conference giveaway"
              multiline
            />

            <Pressable
              onPress={onMint}
              disabled={minting}
              className={cn(
                'flex-row items-center justify-center gap-2 bg-primary px-4 py-2.5 rounded-lg active:opacity-80 mt-2',
                minting && 'opacity-60',
              )}
            >
              {minting ? (
                <ActivityIndicator size="small" />
              ) : (
                <Sparkles size={14} className="text-primary-foreground" />
              )}
              <Text className="text-sm font-medium text-primary-foreground">
                {minting ? 'Minting…' : 'Mint keys'}
              </Text>
            </Pressable>
          </View>
        )}
      </View>
    </ScrollView>
  )
}

function ResultPanel({
  result,
  batchId,
  copiedAll,
  copiedId,
  copiedLinkId,
  onCopyAll,
  onCopyOne,
  onCopyLink,
  onDownload,
  onMintMore,
}: {
  result: MintResponse
  batchId: string
  copiedAll: boolean
  copiedId: string | null
  copiedLinkId: string | null
  onCopyAll: () => void
  onCopyOne: (key: MintedKey) => void
  onCopyLink: (key: MintedKey) => void
  onDownload: () => void
  onMintMore: () => void
}) {
  return (
    <View className="gap-4">
      <View className="rounded-xl border border-amber-300 dark:border-amber-700/50 bg-amber-50 dark:bg-amber-900/20 p-4 flex-row gap-3">
        <AlertTriangle size={18} className="text-amber-600 dark:text-amber-400 mt-0.5" />
        <View className="flex-1">
          <Text className="text-sm font-semibold text-amber-800 dark:text-amber-300">
            Save these {result.count} code{result.count === 1 ? '' : 's'} now
          </Text>
          <Text className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
            Plaintext keys are shown only once and cannot be recovered. Download the CSV or
            copy them before leaving this page.
          </Text>
        </View>
      </View>

      <View className="flex-row gap-2">
        <Pressable
          onPress={onDownload}
          className="flex-row items-center gap-2 bg-primary px-4 py-2.5 rounded-lg active:opacity-80"
        >
          <Download size={14} className="text-primary-foreground" />
          <Text className="text-sm font-medium text-primary-foreground">Download CSV</Text>
        </Pressable>
        <Pressable
          onPress={onCopyAll}
          className="flex-row items-center gap-2 bg-card border border-border px-4 py-2.5 rounded-lg active:bg-muted/50"
        >
          {copiedAll ? (
            <Check size={14} className="text-green-600 dark:text-green-400" />
          ) : (
            <Copy size={14} className="text-foreground" />
          )}
          <Text className="text-sm font-medium text-foreground">
            {copiedAll ? 'Copied' : 'Copy all'}
          </Text>
        </Pressable>
        <Pressable
          onPress={onMintMore}
          className="flex-row items-center gap-2 bg-card border border-border px-4 py-2.5 rounded-lg active:bg-muted/50 ml-auto"
        >
          <Text className="text-sm font-medium text-foreground">Mint more</Text>
        </Pressable>
      </View>

      <Text className="text-xs text-muted-foreground">
        Use the link icon to copy a one-tap redeem link, or the copy icon for the raw code.
      </Text>

      <View className="rounded-xl border border-border bg-card overflow-hidden">
        {result.keys.map((key, idx) => (
          <View
            key={key.id}
            className={cn(
              'flex-row items-center px-4 py-2.5',
              idx !== result.keys.length - 1 && 'border-b border-border',
            )}
          >
            <Text className="flex-1 text-sm font-mono text-foreground" selectable>
              {key.plaintext}
            </Text>
            <Pressable
              onPress={() => onCopyLink(key)}
              accessibilityLabel="Copy redeem link"
              className="p-1.5 rounded-md active:bg-muted"
            >
              {copiedLinkId === key.id ? (
                <Check size={14} className="text-green-600 dark:text-green-400" />
              ) : (
                <LinkIcon size={14} className="text-muted-foreground" />
              )}
            </Pressable>
            <Pressable
              onPress={() => onCopyOne(key)}
              accessibilityLabel="Copy code"
              className="p-1.5 rounded-md active:bg-muted"
            >
              {copiedId === key.id ? (
                <Check size={14} className="text-green-600 dark:text-green-400" />
              ) : (
                <Copy size={14} className="text-muted-foreground" />
              )}
            </Pressable>
          </View>
        ))}
      </View>

      {batchId.trim() ? (
        <Text className="text-xs text-muted-foreground">
          Batch <Text className="font-mono">{batchId.trim()}</Text> · filter by this batch on the
          list page to reconcile redemptions.
        </Text>
      ) : null}
    </View>
  )
}

function PlanPicker({ value, onChange }: { value: PlanId; onChange: (v: PlanId) => void }) {
  return (
    <View>
      <Text className="text-xs font-medium text-muted-foreground mb-1.5">Plan</Text>
      <View className="flex-row flex-wrap gap-2">
        {PLAN_OPTIONS.map((opt) => {
          const active = value === opt.id
          return (
            <Pressable
              key={opt.id}
              onPress={() => onChange(opt.id)}
              className={cn(
                'px-3 py-1.5 rounded-md border',
                active ? 'bg-primary border-primary' : 'bg-card border-border active:bg-muted/40',
              )}
            >
              <Text
                className={cn(
                  'text-xs font-medium',
                  active ? 'text-primary-foreground' : 'text-foreground',
                )}
              >
                {opt.label}
              </Text>
            </Pressable>
          )
        })}
      </View>
      <Text className="text-[11px] text-muted-foreground mt-1">
        Tier the redeemed grant confers. Free is not allowed — keys always upgrade.
      </Text>
    </View>
  )
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  hint,
  keyboardType,
  mono,
  multiline,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  hint?: string
  keyboardType?: 'default' | 'number-pad' | 'decimal-pad'
  mono?: boolean
  multiline?: boolean
}) {
  return (
    <View>
      <Text className="text-xs font-medium text-muted-foreground mb-1.5">{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor="#9ca3af"
        keyboardType={keyboardType}
        autoCapitalize="none"
        autoCorrect={false}
        multiline={multiline}
        className={cn(
          'border border-border rounded-lg px-3 py-2 text-sm text-foreground bg-background',
          mono && 'font-mono',
          multiline && 'min-h-[64px]',
        )}
      />
      {hint && <Text className="text-[11px] text-muted-foreground mt-1">{hint}</Text>}
    </View>
  )
}
