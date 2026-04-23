// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Dual-mode telephony client.
 *
 * The SDK exposes a single `TelephonyClient` interface with two
 * implementations behind it:
 *
 *   - `HostedTelephonyClient` (Mode B) — proxies every call through
 *     Shogo's API using a `shogo_sk_*` bearer. Shogo owns the EL +
 *     Twilio accounts, provisions resources per project, and meters
 *     usage against the workspace's credit ledger.
 *
 *   - `DirectTelephonyClient` (Mode A) — talks directly to Twilio REST
 *     and ElevenLabs REST using developer-provided credentials. Shogo's
 *     API is not involved; the developer pays EL + Twilio directly.
 *
 * Consumers never construct these directly; `createTelephonyClient()`
 * (called by `createClient()`) picks the right implementation based on
 * the supplied options.
 */

import { ElevenLabsClient } from './elevenlabs.js'
import { TwilioClient } from './twilio.js'

export interface ProvisionNumberOptions {
  /** US area code preference (e.g. '415'). Hosted + Direct. */
  areaCode?: string
  /** ISO country code (defaults to US). */
  country?: string
  /** Human-friendly label stored with the number. */
  friendlyName?: string
}

export interface ProvisionNumberResult {
  phoneNumber: string
  twilioPhoneSid: string
  elevenlabsPhoneId: string
  /** Credits debited for setup + first month (Mode B only). */
  creditsDebited?: {
    setup: number
    monthly: number
  }
}

export interface OutboundCallOptions {
  to: string
  dynamicVariables?: Record<string, string>
}

export interface OutboundCallResult {
  callSid: string
  conversationId: string
  /** Pre-flight estimate (Mode B only). */
  estimatedCredits?: number
}

export interface VoiceUsageRange {
  from?: string
  to?: string
}

/**
 * Aggregated voice usage for a project. Shape mirrors
 * `GET /api/voice/usage/:projectId`. `events` is the underlying raw
 * `UsageEvent` list (capped at 1000) for consumers that want to build
 * a per-day chart themselves.
 */
export interface VoiceUsageSummary {
  projectId: string
  range: { from: string | null; to: string | null }
  totals: {
    minutesInbound: number
    minutesOutbound: number
    creditsInbound: number
    creditsOutbound: number
    creditsNumbers: number
    credits: number
    calls: number
    inboundCalls: number
    outboundCalls: number
  }
  events: Array<{
    id: string
    actionType: string
    actionMetadata: unknown
    creditCost: number
    createdAt: string
  }>
}

export interface ReleaseNumberResult {
  released: boolean
}

/**
 * Single turn of an ElevenLabs post-call transcript.
 * Mirrors the `transcript` array items in the `post_call_transcription`
 * webhook payload. Extra provider-specific fields are preserved on the
 * index signature so consumers can surface them if needed.
 */
export interface VoiceTranscriptTurn {
  role: 'agent' | 'user' | string
  message?: string | null
  time_in_call_secs?: number
  [key: string]: unknown
}

/**
 * Summary row returned by `GET /api/voice/calls/:projectId`. When
 * `includeTranscript=true` is passed to `listCalls`, each row also
 * includes the full `transcript` array.
 */
export interface VoiceCallSummary {
  id: string
  conversationId: string | null
  callSid: string | null
  direction: 'inbound' | 'outbound' | string
  durationSeconds: number
  billedMinutes: number
  startedAt: string | null
  endedAt: string | null
  createdAt: string
  billed: boolean
  hasTranscript: boolean
  transcriptSummary: string | null
  transcript?: VoiceTranscriptTurn[] | null
}

/**
 * Detailed single-call row from `GET /api/voice/calls/:projectId/:callId`
 * — always includes the full transcript when EL has delivered one.
 */
export interface VoiceCallDetail extends Omit<VoiceCallSummary, 'hasTranscript'> {
  transcript: VoiceTranscriptTurn[] | null
}

export interface ListCallsOptions {
  limit?: number
  includeTranscript?: boolean
}

export interface TelephonyClient {
  readonly mode: 'hosted' | 'direct'
  provisionNumber(opts?: ProvisionNumberOptions): Promise<ProvisionNumberResult>
  outboundCall(opts: OutboundCallOptions): Promise<OutboundCallResult>
  releaseNumber(): Promise<ReleaseNumberResult>
  /** Mode A throws; usage is not tracked on Shogo's side. */
  getUsage(range?: VoiceUsageRange): Promise<VoiceUsageSummary>
  /**
   * List recent calls for this project with optional transcripts.
   * Mode A throws — Shogo's API doesn't see these calls.
   */
  listCalls(opts?: ListCallsOptions): Promise<VoiceCallSummary[]>
  /**
   * Fetch a single call (by VoiceCallMeter id, EL conversation id, or
   * Twilio CallSid) including the full transcript. Mode A throws.
   */
  getCall(callId: string): Promise<VoiceCallDetail>
}

export class TelephonyConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TelephonyConfigError'
  }
}

export class TelephonyApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message)
    this.name = 'TelephonyApiError'
  }
}

// ---------------------------------------------------------------------------
// Hosted (Mode B)
// ---------------------------------------------------------------------------

export interface HostedTelephonyOptions {
  shogoApiKey: string
  projectId: string
  apiUrl: string
  fetch?: typeof fetch
}

export class HostedTelephonyClient implements TelephonyClient {
  readonly mode = 'hosted'
  private readonly fetchImpl: typeof fetch

  constructor(private readonly opts: HostedTelephonyOptions) {
    if (!opts.shogoApiKey) {
      throw new TelephonyConfigError('Hosted telephony requires shogoApiKey')
    }
    if (!opts.projectId) {
      throw new TelephonyConfigError('Hosted telephony requires projectId')
    }
    if (!opts.apiUrl) {
      throw new TelephonyConfigError('Hosted telephony requires apiUrl')
    }
    this.fetchImpl = opts.fetch ?? globalThis.fetch
    if (typeof this.fetchImpl !== 'function') {
      throw new TelephonyConfigError('global fetch is unavailable; pass opts.fetch')
    }
  }

  private url(path: string): string {
    return `${this.opts.apiUrl.replace(/\/+$/, '')}${path}`
  }

  private async request<T>(
    path: string,
    init: RequestInit & { json?: unknown } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.opts.shogoApiKey}`,
      ...(init.headers as Record<string, string> | undefined),
    }
    let body = init.body
    if (init.json !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(init.json)
    }
    const res = await this.fetchImpl(this.url(path), {
      ...init,
      headers,
      body,
      credentials: 'omit',
    })
    const text = await res.text()
    let parsed: unknown = undefined
    if (text) {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = text
      }
    }
    if (!res.ok) {
      const message =
        (parsed as { error?: string; message?: string } | undefined)?.error ??
        (parsed as { error?: string; message?: string } | undefined)?.message ??
        `Shogo API error: ${res.status}`
      throw new TelephonyApiError(message, res.status, parsed)
    }
    return parsed as T
  }

  async provisionNumber(
    opts: ProvisionNumberOptions = {},
  ): Promise<ProvisionNumberResult> {
    const data = await this.request<{
      phoneNumber: string
      twilioPhoneSid: string
      elevenlabsPhoneId: string
      creditsDebited?: { setup: number; monthly: number }
    }>(
      `/api/voice/twilio/provision-number/${encodeURIComponent(
        this.opts.projectId,
      )}`,
      {
        method: 'POST',
        json: {
          areaCode: opts.areaCode,
          country: opts.country,
          friendlyName: opts.friendlyName,
        },
      },
    )
    return {
      phoneNumber: data.phoneNumber,
      twilioPhoneSid: data.twilioPhoneSid,
      elevenlabsPhoneId: data.elevenlabsPhoneId,
      creditsDebited: data.creditsDebited,
    }
  }

  async outboundCall(opts: OutboundCallOptions): Promise<OutboundCallResult> {
    const data = await this.request<{
      callSid: string
      conversationId: string
      estimatedCredits?: number
    }>(
      `/api/voice/twilio/outbound/${encodeURIComponent(this.opts.projectId)}`,
      {
        method: 'POST',
        json: { to: opts.to, dynamicVariables: opts.dynamicVariables },
      },
    )
    return {
      callSid: data.callSid,
      conversationId: data.conversationId,
      estimatedCredits: data.estimatedCredits,
    }
  }

  async releaseNumber(): Promise<ReleaseNumberResult> {
    await this.request<unknown>(
      `/api/voice/twilio/number/${encodeURIComponent(this.opts.projectId)}`,
      { method: 'DELETE' },
    )
    return { released: true }
  }

  async getUsage(range: VoiceUsageRange = {}): Promise<VoiceUsageSummary> {
    const q = new URLSearchParams()
    if (range.from) q.set('from', range.from)
    if (range.to) q.set('to', range.to)
    const path = `/api/voice/usage/${encodeURIComponent(this.opts.projectId)}${
      q.toString() ? `?${q.toString()}` : ''
    }`
    return this.request<VoiceUsageSummary>(path, { method: 'GET' })
  }

  async listCalls(opts: ListCallsOptions = {}): Promise<VoiceCallSummary[]> {
    const q = new URLSearchParams()
    if (opts.limit) q.set('limit', String(opts.limit))
    if (opts.includeTranscript) q.set('includeTranscript', '1')
    const path = `/api/voice/calls/${encodeURIComponent(this.opts.projectId)}${
      q.toString() ? `?${q.toString()}` : ''
    }`
    const res = await this.request<{ projectId: string; calls: VoiceCallSummary[] }>(
      path,
      { method: 'GET' },
    )
    return res.calls
  }

  async getCall(callId: string): Promise<VoiceCallDetail> {
    const path = `/api/voice/calls/${encodeURIComponent(
      this.opts.projectId,
    )}/${encodeURIComponent(callId)}`
    return this.request<VoiceCallDetail>(path, { method: 'GET' })
  }
}

// ---------------------------------------------------------------------------
// Direct (Mode A)
// ---------------------------------------------------------------------------

export interface DirectTelephonyOptions {
  projectId?: string
  elevenlabs: {
    apiKey: string
    agentId: string
    /** Existing EL phone-number resource id. If omitted, `provisionNumber`
     *  will create one; `outboundCall` / `releaseNumber` will 409 until
     *  one exists. */
    phoneNumberId?: string
    baseUrl?: string
  }
  twilio: {
    accountSid: string
    authToken: string
    /**
     * E.164 number to use as the caller id. Required for
     * `outboundCall`. If you want `provisionNumber` to buy a new
     * number, leave this unset.
     */
    fromNumber?: string
    /** Optional pre-existing Twilio IncomingPhoneNumber sid. */
    phoneSid?: string
    baseUrl?: string
  }
  fetch?: typeof fetch
}

export class DirectTelephonyClient implements TelephonyClient {
  readonly mode = 'direct'
  private readonly el: ElevenLabsClient
  private readonly tw: TwilioClient
  // Internal, per-instance state for numbers minted via provisionNumber().
  private state: {
    phoneNumber?: string
    twilioSid?: string
    elevenlabsPhoneId?: string
  }

  constructor(private readonly opts: DirectTelephonyOptions) {
    if (!opts.elevenlabs?.apiKey) {
      throw new TelephonyConfigError('Direct telephony requires elevenlabs.apiKey')
    }
    if (!opts.elevenlabs?.agentId) {
      throw new TelephonyConfigError('Direct telephony requires elevenlabs.agentId')
    }
    if (!opts.twilio?.accountSid || !opts.twilio?.authToken) {
      throw new TelephonyConfigError(
        'Direct telephony requires twilio.accountSid + twilio.authToken',
      )
    }
    this.el = new ElevenLabsClient({
      apiKey: opts.elevenlabs.apiKey,
      baseUrl: opts.elevenlabs.baseUrl,
      fetch: opts.fetch,
    })
    this.tw = new TwilioClient({
      accountSid: opts.twilio.accountSid,
      authToken: opts.twilio.authToken,
      baseUrl: opts.twilio.baseUrl,
      fetch: opts.fetch,
    })
    this.state = {
      phoneNumber: opts.twilio.fromNumber,
      twilioSid: opts.twilio.phoneSid,
      elevenlabsPhoneId: opts.elevenlabs.phoneNumberId,
    }
  }

  async provisionNumber(
    opts: ProvisionNumberOptions = {},
  ): Promise<ProvisionNumberResult> {
    const candidates = await this.tw.searchAvailable({
      country: opts.country,
      areaCode: opts.areaCode,
      limit: 1,
    })
    if (candidates.length === 0) {
      throw new TelephonyApiError(
        'No Twilio numbers available matching criteria',
        404,
        { areaCode: opts.areaCode, country: opts.country },
      )
    }
    const purchased = await this.tw.purchaseNumber({
      phoneNumber: candidates[0].phoneNumber,
      friendlyName: opts.friendlyName,
    })
    try {
      const { phoneNumberId } = await this.el.createPhoneNumberTwilio({
        phoneNumber: purchased.phoneNumber,
        label: opts.friendlyName ?? purchased.phoneNumber,
        agentId: this.opts.elevenlabs.agentId,
        twilioAccountSid: this.opts.twilio.accountSid,
        twilioAuthToken: this.opts.twilio.authToken,
      })
      this.state = {
        phoneNumber: purchased.phoneNumber,
        twilioSid: purchased.sid,
        elevenlabsPhoneId: phoneNumberId,
      }
      return {
        phoneNumber: purchased.phoneNumber,
        twilioPhoneSid: purchased.sid,
        elevenlabsPhoneId: phoneNumberId,
      }
    } catch (err) {
      // Compensating release so we don't leak a purchased number.
      try {
        await this.tw.releaseNumber(purchased.sid)
      } catch {
        /* best-effort */
      }
      throw err
    }
  }

  async outboundCall(opts: OutboundCallOptions): Promise<OutboundCallResult> {
    if (!this.state.elevenlabsPhoneId) {
      throw new TelephonyConfigError(
        'outboundCall requires an ElevenLabs phone id; call provisionNumber() or pass elevenlabs.phoneNumberId',
      )
    }
    const res = await this.el.outboundCall({
      phoneNumberId: this.state.elevenlabsPhoneId,
      agentId: this.opts.elevenlabs.agentId,
      toNumber: opts.to,
      dynamicVariables: opts.dynamicVariables,
    })
    return { callSid: res.callSid, conversationId: res.conversationId }
  }

  async releaseNumber(): Promise<ReleaseNumberResult> {
    let released = false
    if (this.state.elevenlabsPhoneId) {
      await this.el.deletePhoneNumber(this.state.elevenlabsPhoneId)
      released = true
    }
    if (this.state.twilioSid) {
      await this.tw.releaseNumber(this.state.twilioSid)
      released = true
    }
    this.state = {}
    return { released }
  }

  async getUsage(): Promise<VoiceUsageSummary> {
    throw new TelephonyConfigError(
      'getUsage() is unavailable in Mode A (self-hosted). Query Twilio + ElevenLabs directly.',
    )
  }

  async listCalls(): Promise<VoiceCallSummary[]> {
    throw new TelephonyConfigError(
      'listCalls() is unavailable in Mode A (self-hosted). Query ElevenLabs conversations directly.',
    )
  }

  async getCall(): Promise<VoiceCallDetail> {
    throw new TelephonyConfigError(
      'getCall() is unavailable in Mode A (self-hosted). Query ElevenLabs conversations directly.',
    )
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export type CreateTelephonyOptions =
  | ({ mode: 'hosted' } & HostedTelephonyOptions)
  | ({ mode: 'direct' } & DirectTelephonyOptions)

export function createTelephonyClient(
  opts: CreateTelephonyOptions,
): TelephonyClient {
  if (opts.mode === 'hosted') return new HostedTelephonyClient(opts)
  return new DirectTelephonyClient(opts)
}
