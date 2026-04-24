// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * PhonePanel — lightweight project-settings tab for Twilio + ElevenLabs
 * telephony (Mode B / Shogo-hosted).
 *
 * Intentionally narrow surface for v1:
 *   - Show current assigned number, or a "Get a phone number" button with
 *     an optional area code input that hits `POST /api/voice/twilio/provision-number/:projectId`.
 *   - Show recent call usage aggregated by the same endpoint the SDK uses
 *     (`GET /api/voice/usage/:projectId`) so users can verify metering.
 *   - Release action (`DELETE /api/voice/twilio/number/:projectId`).
 *
 * No credential inputs — Shogo owns the underlying EL + Twilio keys.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  View,
  Text,
  Pressable,
  TextInput,
  ActivityIndicator,
  ScrollView,
} from 'react-native'
import {
  ChevronDown,
  ChevronRight,
  Phone,
  PhoneIncoming,
  PhoneOutgoing,
  PlusCircle,
  RefreshCw,
  Trash2,
} from 'lucide-react-native'
import { agentFetch } from '../../../lib/agent-fetch'
import { API_URL } from '../../../lib/api'

interface VoiceConfigResponse {
  phoneNumber?: string | null
  twilioPhoneSid?: string | null
  elevenlabsPhoneId?: string | null
  elevenlabsAgentId?: string | null
  purchasedAt?: string | null
  monthlyRateDebitedFor?: string | null
}

interface VoiceUsageSummary {
  totals: {
    minutesInbound: number
    minutesOutbound: number
    billedUsdInbound: number
    billedUsdOutbound: number
    billedUsdNumbers: number
    billedUsd: number
    calls: number
    inboundCalls: number
    outboundCalls: number
  }
}

interface TranscriptTurn {
  role: string
  message?: string | null
  time_in_call_secs?: number
}

interface VoiceCallRow {
  id: string
  conversationId: string | null
  callSid: string | null
  direction: string
  durationSeconds: number
  billedMinutes: number
  startedAt: string | null
  endedAt: string | null
  createdAt: string
  billed: boolean
  hasTranscript: boolean
  transcriptSummary: string | null
  transcript?: TranscriptTurn[] | null
}

interface AvailableNumber {
  phoneNumber: string
  friendlyName: string
  region?: string
  locality?: string
  isoCountry?: string
}

interface PhonePanelProps {
  projectId: string
  visible: boolean
  /** When true, omits the heading row so this can be embedded inside another
   *  panel's card (e.g. ChannelsPanel). Defaults to false (standalone). */
  embedded?: boolean
}

export function PhonePanel({ projectId, visible, embedded = false }: PhonePanelProps) {
  const [config, setConfig] = useState<VoiceConfigResponse | null>(null)
  const [usage, setUsage] = useState<VoiceUsageSummary | null>(null)
  const [calls, setCalls] = useState<VoiceCallRow[]>([])
  const [expandedCallId, setExpandedCallId] = useState<string | null>(null)
  const [transcripts, setTranscripts] = useState<Record<string, TranscriptTurn[] | null>>({})
  const [transcriptLoading, setTranscriptLoading] = useState<string | null>(null)
  const [areaCode, setAreaCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<null | 'provision' | 'release' | 'search'>(null)
  const [error, setError] = useState<string | null>(null)
  const [availableNumbers, setAvailableNumbers] = useState<AvailableNumber[]>([])
  const [selectedNumber, setSelectedNumber] = useState<string | null>(null)
  const [searchedOnce, setSearchedOnce] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [configRes, usageRes, callsRes] = await Promise.all([
        agentFetch(
          `${API_URL}/api/voice/config/${encodeURIComponent(projectId)}`,
        ),
        agentFetch(
          `${API_URL}/api/voice/usage/${encodeURIComponent(projectId)}`,
        ),
        agentFetch(
          `${API_URL}/api/voice/calls/${encodeURIComponent(projectId)}?limit=25`,
        ),
      ])
      if (configRes.ok) {
        const data = (await configRes.json()) as VoiceConfigResponse & {
          provisioned?: boolean
        }
        // The endpoint always 200s; `provisioned=false` means no number.
        setConfig(data.provisioned ? data : null)
      } else if (configRes.status !== 404) {
        setError(`Failed to load phone config (${configRes.status})`)
      }
      if (usageRes.ok) {
        setUsage((await usageRes.json()) as VoiceUsageSummary)
      } else if (usageRes.status !== 404) {
        setError((prev) => prev ?? `Failed to load usage (${usageRes.status})`)
      }
      if (callsRes.ok) {
        const data = (await callsRes.json()) as { calls: VoiceCallRow[] }
        setCalls(data.calls ?? [])
      }
    } catch (err: any) {
      setError(err?.message ?? 'Failed to load voice config')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  const toggleCall = useCallback(
    async (call: VoiceCallRow) => {
      if (expandedCallId === call.id) {
        setExpandedCallId(null)
        return
      }
      setExpandedCallId(call.id)
      if (!call.hasTranscript) return
      if (transcripts[call.id] !== undefined) return
      setTranscriptLoading(call.id)
      try {
        const res = await agentFetch(
          `${API_URL}/api/voice/calls/${encodeURIComponent(projectId)}/${encodeURIComponent(call.id)}`,
        )
        if (res.ok) {
          const data = (await res.json()) as { transcript: TranscriptTurn[] | null }
          setTranscripts((prev) => ({ ...prev, [call.id]: data.transcript ?? null }))
        } else {
          setTranscripts((prev) => ({ ...prev, [call.id]: null }))
        }
      } catch {
        setTranscripts((prev) => ({ ...prev, [call.id]: null }))
      } finally {
        setTranscriptLoading(null)
      }
    },
    [expandedCallId, projectId, transcripts],
  )

  useEffect(() => {
    if (visible) load()
  }, [visible, load])

  const searchNumbers = useCallback(async () => {
    setBusy('search')
    setError(null)
    try {
      const params = new URLSearchParams({ limit: '10' })
      if (areaCode) params.set('areaCode', areaCode)
      const res = await agentFetch(
        `${API_URL}/api/voice/twilio/available-numbers/${encodeURIComponent(projectId)}?${params.toString()}`,
      )
      const data = (await res.json()) as {
        numbers?: AvailableNumber[]
        error?: string | { message?: string }
        twilioBody?: string
      }
      if (!res.ok) {
        const msg =
          typeof data.error === 'string'
            ? data.error
            : data.error?.message || `Search failed (${res.status})`
        throw new Error(msg)
      }
      setAvailableNumbers(data.numbers ?? [])
      setSearchedOnce(true)
      if ((data.numbers ?? []).length > 0 && !selectedNumber) {
        setSelectedNumber(data.numbers![0].phoneNumber)
      }
    } catch (err: any) {
      setError(err?.message ?? 'Failed to search numbers')
      setAvailableNumbers([])
      setSearchedOnce(true)
    } finally {
      setBusy(null)
    }
  }, [projectId, areaCode, selectedNumber])

  const handleProvision = useCallback(async () => {
    if (!selectedNumber) {
      setError('Pick a number first.')
      return
    }
    setBusy('provision')
    setError(null)
    try {
      const res = await agentFetch(
        `${API_URL}/api/voice/twilio/provision-number/${encodeURIComponent(projectId)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            phoneNumber: selectedNumber,
            areaCode: areaCode || undefined,
          }),
        },
      )
      const data = (await res.json()) as VoiceConfigResponse & {
        error?: string
        detail?: string
        twilioBody?: string
        elBody?: string
      }
      if (!res.ok) {
        const extra = data.twilioBody || data.elBody || data.detail
        throw new Error(
          extra ? `${data.error ?? 'Provision failed'}: ${extra}` : (data.error ?? `Provision failed (${res.status})`),
        )
      }
      setConfig(data)
      setAvailableNumbers([])
      setSelectedNumber(null)
      setSearchedOnce(false)
      await load()
    } catch (err: any) {
      setError(err?.message ?? 'Provision failed')
    } finally {
      setBusy(null)
    }
  }, [projectId, areaCode, selectedNumber, load])

  const handleRelease = useCallback(async () => {
    setBusy('release')
    setError(null)
    try {
      const res = await agentFetch(
        `${API_URL}/api/voice/twilio/number/${encodeURIComponent(projectId)}`,
        { method: 'DELETE' },
      )
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(data.error ?? `Release failed (${res.status})`)
      }
      setConfig(null)
      await load()
    } catch (err: any) {
      setError(err?.message ?? 'Release failed')
    } finally {
      setBusy(null)
    }
  }, [projectId, load])

  if (!visible) return null

  return (
    <View className={embedded ? '' : 'p-4'}>
      {!embedded && (
        <View className="flex-row items-center gap-2 mb-4">
          <Phone size={20} color="#888" />
          <Text className="text-lg font-semibold text-foreground">
            Phone number
          </Text>
          <Pressable
            onPress={load}
            disabled={loading}
            className="ml-auto flex-row items-center gap-1 p-2"
            accessibilityLabel="Refresh phone config"
          >
            <RefreshCw size={16} color="#888" />
          </Pressable>
        </View>
      )}

      {error && (
        <View className="mb-3 rounded-md bg-red-950/40 border border-red-500/30 p-3">
          <Text className="text-sm text-red-400">{error}</Text>
        </View>
      )}

      {loading && !usage && (
        <View className="py-8 items-center">
          <ActivityIndicator />
        </View>
      )}

      {config?.phoneNumber ? (
        <View className="rounded-md border border-border bg-muted/20 p-4 mb-4">
          <Text className="text-sm text-muted-foreground">
            Assigned number
          </Text>
          <Text className="text-xl font-semibold text-foreground mb-2">
            {config.phoneNumber}
          </Text>
          {config.monthlyRateDebitedFor && (
            <Text className="text-xs text-muted-foreground">
              Last monthly debit:{' '}
              {new Date(config.monthlyRateDebitedFor).toLocaleDateString()}
            </Text>
          )}
          <Pressable
            onPress={handleRelease}
            disabled={busy !== null}
            className="mt-3 flex-row items-center gap-2 self-start px-3 py-2 rounded-md bg-red-950/40 border border-red-500/30"
          >
            {busy === 'release' ? (
              <ActivityIndicator size="small" />
            ) : (
              <Trash2 size={14} color="#f87171" />
            )}
            <Text className="text-sm text-red-400">Release number</Text>
          </Pressable>
        </View>
      ) : (
        <View className="rounded-md border border-border bg-muted/20 p-4 mb-4">
          <Text className="text-sm text-muted-foreground mb-2">
            No phone number attached to this project yet.
          </Text>
          <View className="flex-row items-center gap-2 mb-3">
            <TextInput
              value={areaCode}
              onChangeText={setAreaCode}
              placeholder="Area code (e.g. 415)"
              placeholderTextColor="#666"
              keyboardType="number-pad"
              maxLength={4}
              className="flex-1 px-3 py-2 rounded-md border border-border bg-background text-foreground"
            />
            <Pressable
              onPress={searchNumbers}
              disabled={busy !== null}
              className="flex-row items-center gap-2 px-3 py-2 rounded-md border border-border bg-background"
              accessibilityLabel="Search available numbers"
            >
              {busy === 'search' ? (
                <ActivityIndicator size="small" />
              ) : (
                <RefreshCw size={14} color="#888" />
              )}
              <Text className="text-sm text-foreground">
                {searchedOnce ? 'Search again' : 'Search numbers'}
              </Text>
            </Pressable>
          </View>

          {availableNumbers.length > 0 && (
            <View className="mb-3 rounded-md border border-border bg-background overflow-hidden">
              {availableNumbers.map((n) => {
                const selected = selectedNumber === n.phoneNumber
                const locationLine = [n.locality, n.region, n.isoCountry]
                  .filter(Boolean)
                  .join(', ')
                return (
                  <Pressable
                    key={n.phoneNumber}
                    onPress={() => setSelectedNumber(n.phoneNumber)}
                    className={`flex-row items-center gap-3 px-3 py-2 border-t border-border/50 ${selected ? 'bg-primary/10' : ''}`}
                    accessibilityLabel={`Select ${n.phoneNumber}`}
                    accessibilityState={{ selected }}
                  >
                    <View
                      className={`w-4 h-4 rounded-full border ${selected ? 'border-primary bg-primary' : 'border-border'}`}
                    />
                    <View className="flex-1">
                      <Text className="text-sm font-medium text-foreground">
                        {n.friendlyName || n.phoneNumber}
                      </Text>
                      {locationLine ? (
                        <Text className="text-xs text-muted-foreground">
                          {locationLine}
                        </Text>
                      ) : null}
                    </View>
                  </Pressable>
                )
              })}
            </View>
          )}

          {searchedOnce && availableNumbers.length === 0 && busy !== 'search' && (
            <Text className="mb-3 text-xs text-muted-foreground">
              No numbers found
              {areaCode ? ` for area code ${areaCode}` : ''}. Try a different
              area code.
            </Text>
          )}

          <Pressable
            onPress={handleProvision}
            disabled={busy !== null || !selectedNumber}
            className={`flex-row items-center gap-2 self-start px-3 py-2 rounded-md ${selectedNumber ? 'bg-primary' : 'bg-muted'}`}
          >
            {busy === 'provision' ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <PlusCircle size={14} color="#fff" />
            )}
            <Text className="text-sm text-white font-medium">
              {selectedNumber
                ? `Buy ${selectedNumber}`
                : 'Pick a number to buy'}
            </Text>
          </Pressable>
          <Text className="mt-2 text-xs text-muted-foreground">
            Inbound calls bridge to this project's ElevenLabs agent. Monthly
            line fee and per-minute usage are billed against your workspace
            at provider cost + 20% markup.
          </Text>
        </View>
      )}

      {usage?.totals && (
        <View className="rounded-md border border-border bg-muted/20 p-4 mb-4">
          <Text className="text-sm font-semibold text-foreground mb-2">
            Recent usage
          </Text>
          <Row
            label="Total calls"
            value={String(usage.totals.calls ?? 0)}
          />
          <Row
            label="Minutes (inbound)"
            value={String(usage.totals.minutesInbound ?? 0)}
          />
          <Row
            label="Minutes (outbound)"
            value={String(usage.totals.minutesOutbound ?? 0)}
          />
          <Row
            label="Usage billed"
            value={`$${(usage.totals.billedUsd ?? 0).toFixed(4)}`}
          />
        </View>
      )}

      {calls.length > 0 && (
        <View className="rounded-md border border-border bg-muted/20 p-4">
          <Text className="text-sm font-semibold text-foreground mb-2">
            Recent calls
          </Text>
          {calls.map((call) => {
            const expanded = expandedCallId === call.id
            const transcript = transcripts[call.id]
            const isLoading = transcriptLoading === call.id
            return (
              <View
                key={call.id}
                className="border-t border-border/50 py-2 first:border-t-0 first:pt-0"
              >
                <Pressable
                  onPress={() => toggleCall(call)}
                  className="flex-row items-center gap-2"
                  accessibilityLabel={`Call ${call.createdAt}`}
                >
                  {expanded ? (
                    <ChevronDown size={14} color="#888" />
                  ) : (
                    <ChevronRight size={14} color="#888" />
                  )}
                  {call.direction === 'outbound' ? (
                    <PhoneOutgoing size={14} color="#60a5fa" />
                  ) : (
                    <PhoneIncoming size={14} color="#4ade80" />
                  )}
                  <Text className="text-xs text-foreground flex-1">
                    {formatCallTitle(call)}
                  </Text>
                  <Text className="text-xs text-muted-foreground">
                    {formatDuration(call.durationSeconds)}
                  </Text>
                </Pressable>

                {expanded && (
                  <View className="mt-2 ml-6 pl-2 border-l border-border/60">
                    <Text className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                      {new Date(call.createdAt).toLocaleString()} ·{' '}
                      {call.billedMinutes} billed min
                      {call.billed ? '' : ' · pending'}
                    </Text>
                    {call.transcriptSummary && (
                      <Text className="text-xs text-foreground italic mb-2">
                        {call.transcriptSummary}
                      </Text>
                    )}
                    {isLoading ? (
                      <View className="py-2">
                        <ActivityIndicator size="small" />
                      </View>
                    ) : transcript && transcript.length > 0 ? (
                      <ScrollView
                        className="max-h-56"
                        nestedScrollEnabled
                      >
                        {transcript.map((turn, idx) => (
                          <View key={idx} className="py-1">
                            <Text className="text-[10px] uppercase text-muted-foreground">
                              {turn.role}
                            </Text>
                            <Text className="text-xs text-foreground">
                              {turn.message ?? ''}
                            </Text>
                          </View>
                        ))}
                      </ScrollView>
                    ) : call.hasTranscript ? (
                      <Text className="text-xs text-muted-foreground">
                        Transcript unavailable.
                      </Text>
                    ) : (
                      <Text className="text-xs text-muted-foreground">
                        No transcript yet. ElevenLabs delivers it via webhook
                        after the call ends.
                      </Text>
                    )}
                  </View>
                )}
              </View>
            )
          })}
        </View>
      )}
    </View>
  )
}

function formatCallTitle(call: VoiceCallRow): string {
  const direction = call.direction === 'outbound' ? 'Outbound' : 'Inbound'
  const when = new Date(call.createdAt).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
  return `${direction} · ${when}`
}

function formatDuration(seconds: number): string {
  if (!seconds || seconds < 1) return '—'
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return s > 0 ? `${m}m ${s}s` : `${m}m`
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row justify-between py-1">
      <Text className="text-xs text-muted-foreground">{label}</Text>
      <Text className="text-xs text-foreground">{value}</Text>
    </View>
  )
}
