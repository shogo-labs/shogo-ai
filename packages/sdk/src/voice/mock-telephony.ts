// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * MockTelephonyClient
 *
 * In-process telephony stub used by demo recordings (Playwright) and
 * any environment that sets `process.env.SHOGO_VOICE_MODE=mock`.
 *
 * Returns deterministic, hand-crafted fixture data for every method on
 * the {@link TelephonyClient} interface. Performs zero network I/O — no
 * Shogo API call, no Twilio call, no ElevenLabs call. Calling
 * `outboundCall()` is therefore safe in any context (no real phones
 * ring, no usage wallet is debited).
 *
 * Wire-compat with the real clients: same method shapes, same return
 * types. Generated app code that uses
 * `shogo.voice.telephony.outboundCall(...)` does not need to know it's
 * running against the mock.
 */

import type {
  TelephonyClient,
  ProvisionNumberOptions,
  ProvisionNumberResult,
  OutboundCallOptions,
  OutboundCallResult,
  ReleaseNumberResult,
  VoiceUsageRange,
  VoiceUsageSummary,
  ListCallsOptions,
  VoiceCallSummary,
  VoiceCallDetail,
  VoiceTranscriptTurn,
} from './telephony.js'

export interface MockTelephonyOptions {
  /** Project the mock pretends to belong to. Defaults to 'demo-project'. */
  projectId?: string
  /** Override the placeholder outbound number. */
  phoneNumber?: string
  /** Override the rotating call fixtures (advanced). */
  callFixtures?: VoiceCallSummary[]
}

const DEFAULT_PHONE = '+14155550143'
const DEFAULT_TWILIO_SID = 'PNmock0000000000000000000000000001'
const DEFAULT_EL_PHONE_ID = 'phn_mock_0000000001'

/**
 * Three rotating fake calls — each one a different disposition so the
 * agent's UI has variety to render. `listCalls` returns these in order;
 * each entry is fully transcripted so a polling agent can stream them.
 */
const DEFAULT_CALL_FIXTURES: VoiceCallSummary[] = [
  {
    id: 'mock_call_001',
    conversationId: 'mock_conv_001',
    callSid: 'CAmock00000000000000000000000000001',
    direction: 'outbound',
    durationSeconds: 184,
    billedMinutes: 4,
    startedAt: '2026-05-06T22:01:00.000Z',
    endedAt: '2026-05-06T22:04:04.000Z',
    createdAt: '2026-05-06T22:01:00.000Z',
    billed: true,
    hasTranscript: true,
    transcriptSummary:
      'Prospect agreed to a 30-min demo on Thursday at 2pm PT. Booked via Calendly link.',
  },
  {
    id: 'mock_call_002',
    conversationId: 'mock_conv_002',
    callSid: 'CAmock00000000000000000000000000002',
    direction: 'outbound',
    durationSeconds: 41,
    billedMinutes: 1,
    startedAt: '2026-05-06T22:05:00.000Z',
    endedAt: '2026-05-06T22:05:41.000Z',
    createdAt: '2026-05-06T22:05:00.000Z',
    billed: true,
    hasTranscript: true,
    transcriptSummary:
      'Voicemail. Left a 25-second AI-disclosed message with callback number.',
  },
  {
    id: 'mock_call_003',
    conversationId: 'mock_conv_003',
    callSid: 'CAmock00000000000000000000000000003',
    direction: 'outbound',
    durationSeconds: 22,
    billedMinutes: 1,
    startedAt: '2026-05-06T22:06:30.000Z',
    endedAt: '2026-05-06T22:06:52.000Z',
    createdAt: '2026-05-06T22:06:30.000Z',
    billed: true,
    hasTranscript: true,
    transcriptSummary:
      'Prospect said "remove me" 8 seconds in. Honored, persisted to do-not-call list.',
  },
]

const DEFAULT_TRANSCRIPTS: Record<string, VoiceTranscriptTurn[]> = {
  mock_conv_001: [
    { role: 'agent', message: "Hi, this is an AI assistant calling on behalf of Russell at Shogo. Do you have 30 seconds?", time_in_call_secs: 1 },
    { role: 'user', message: 'Sure, what is this about?', time_in_call_secs: 6 },
    { role: 'agent', message: "Shogo is a universal AI agent that runs every job-to-be-done with real interfaces, not chat. We help teams like yours replace point tools with one platform.", time_in_call_secs: 10 },
    { role: 'user', message: "Interesting. We've been looking at workflow automation. How is this different from Zapier?", time_in_call_secs: 24 },
    { role: 'agent', message: "Zapier connects steps. Shogo runs the whole workflow with an agent that can use tools, build interfaces, and learn from your data.", time_in_call_secs: 30 },
    { role: 'user', message: "OK I'd like to see it. Send me a demo invite.", time_in_call_secs: 52 },
    { role: 'agent', message: "Great. I'm sending the Calendly link now. Does Thursday at 2pm Pacific work?", time_in_call_secs: 58 },
    { role: 'user', message: "Yes, perfect.", time_in_call_secs: 66 },
    { role: 'agent', message: "Booked. You'll get a confirmation email in 30 seconds. Thanks for your time.", time_in_call_secs: 70 },
  ],
  mock_conv_002: [
    { role: 'agent', message: "Hi, this is an AI assistant calling on behalf of Russell at Shogo. Leaving a voicemail — we'd love to show you our universal AI agent platform. Call us back at +1 415 555 0143 or visit shogo.ai. Have a great day.", time_in_call_secs: 1 },
  ],
  mock_conv_003: [
    { role: 'agent', message: "Hi, this is an AI assistant calling on behalf of Russell at Shogo —", time_in_call_secs: 1 },
    { role: 'user', message: "Remove me from your list.", time_in_call_secs: 8 },
    { role: 'agent', message: "Understood. You're removed and we won't call again. Thank you.", time_in_call_secs: 11 },
  ],
}

let warned = false

export class MockTelephonyClient implements TelephonyClient {
  readonly mode = 'mock' as const
  private readonly projectId: string
  private readonly phoneNumber: string
  private readonly fixtures: VoiceCallSummary[]
  private callCounter = 0

  constructor(opts: MockTelephonyOptions = {}) {
    this.projectId = opts.projectId ?? 'demo-project'
    this.phoneNumber = opts.phoneNumber ?? DEFAULT_PHONE
    this.fixtures = opts.callFixtures ?? DEFAULT_CALL_FIXTURES
    if (!warned) {
      console.warn(
        '[shogo] voice mock mode active — telephony returns canned data, no real provider calls are made.',
      )
      warned = true
    }
  }

  async provisionNumber(_opts: ProvisionNumberOptions = {}): Promise<ProvisionNumberResult> {
    return {
      phoneNumber: this.phoneNumber,
      twilioPhoneSid: DEFAULT_TWILIO_SID,
      elevenlabsPhoneId: DEFAULT_EL_PHONE_ID,
      setupBilledUsd: 0,
      monthlyBilledUsd: 0,
      usageDebited: { setup: false, monthly: false },
    }
  }

  async outboundCall(_opts: OutboundCallOptions): Promise<OutboundCallResult> {
    this.callCounter++
    const seq = String(this.callCounter).padStart(32, '0').slice(-32)
    return {
      callSid: `CAmock${seq}`,
      conversationId: `mock_conv_${String(this.callCounter).padStart(3, '0')}`,
      estimatedBilledUsd: 0,
      billedUsdPerMinute: 0,
    }
  }

  async releaseNumber(): Promise<ReleaseNumberResult> {
    return { released: true }
  }

  async getUsage(_range?: VoiceUsageRange): Promise<VoiceUsageSummary> {
    const outboundCalls = this.fixtures.filter((c) => c.direction === 'outbound').length
    const inboundCalls = this.fixtures.length - outboundCalls
    const totalMinutes = this.fixtures.reduce((sum, c) => sum + c.billedMinutes, 0)
    return {
      projectId: this.projectId,
      range: { from: null, to: null },
      totals: {
        minutesInbound: 0,
        minutesOutbound: totalMinutes,
        billedUsdInbound: 0,
        billedUsdOutbound: 0,
        billedUsdNumbers: 0,
        billedUsd: 0,
        calls: this.fixtures.length,
        inboundCalls,
        outboundCalls,
      },
      events: [],
    }
  }

  async listCalls(opts: ListCallsOptions = {}): Promise<VoiceCallSummary[]> {
    const limit = opts.limit ?? this.fixtures.length
    const slice = this.fixtures.slice(0, limit)
    if (!opts.includeTranscript) return slice.map((c) => ({ ...c }))
    return slice.map((c) => ({
      ...c,
      transcript: DEFAULT_TRANSCRIPTS[c.conversationId ?? ''] ?? null,
    }))
  }

  async getCall(callId: string): Promise<VoiceCallDetail> {
    const found = this.fixtures.find(
      (c) => c.id === callId || c.conversationId === callId || c.callSid === callId,
    )
    if (!found) {
      // Synthesize a "completed just now" detail so polling code never breaks.
      return {
        id: callId,
        conversationId: callId,
        callSid: callId,
        direction: 'outbound',
        durationSeconds: 0,
        billedMinutes: 0,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        billed: false,
        transcriptSummary: null,
        transcript: null,
      }
    }
    const { hasTranscript: _hasTranscript, ...rest } = found
    return {
      ...rest,
      transcript: DEFAULT_TRANSCRIPTS[found.conversationId ?? ''] ?? null,
    }
  }
}

/**
 * Convenience: returns true when SHOGO_VOICE_MODE is set to one of the
 * recognized mock-mode aliases. Other modules in the SDK use this to
 * branch their telephony selection.
 */
export function isVoiceMockEnv(): boolean {
  if (typeof process === 'undefined') return false
  const value = process.env?.SHOGO_VOICE_MODE
  if (!value) return false
  const v = value.toLowerCase()
  return v === 'mock' || v === 'demo' || v === 'fake'
}
