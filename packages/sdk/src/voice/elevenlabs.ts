// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Typed ElevenLabs REST client for convai agents + TTS.
 *
 * Scoped to the endpoints the voice server handlers need:
 *   - POST  /v1/convai/agents/create
 *   - PATCH /v1/convai/agents/:id
 *   - DELETE /v1/convai/agents/:id
 *   - GET   /v1/convai/conversation/get-signed-url?agent_id=…
 *   - POST  /v1/text-to-speech/:voiceId
 *   - GET   /v1/voices/:voiceId
 *
 * All network calls use the global `fetch`. No module-level env reads —
 * the API key is always supplied to the constructor.
 */

import type { Expressivity, VoiceSettings } from './audioTags.js'
import { composeAgentPrompt } from './prompt.js'

export const DEFAULT_ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io'

/** TTS models the convai runtime supports as of 2026-Q2. */
export const CONVAI_SUPPORTED_TTS_MODELS = new Set<string>([
  'eleven_turbo_v2',
  'eleven_turbo_v2_5',
  'eleven_flash_v2',
  'eleven_flash_v2_5',
  'eleven_multilingual_v2',
])

export const CONVAI_TTS_MODEL_FALLBACK = 'eleven_turbo_v2_5'

/** If `requested` isn't a convai-compatible TTS model, fall back to the default. */
export function resolveConvaiTtsModel(requested: string | null | undefined): string {
  if (requested && CONVAI_SUPPORTED_TTS_MODELS.has(requested)) return requested
  return CONVAI_TTS_MODEL_FALLBACK
}

export interface ElevenLabsClientConfig {
  apiKey: string
  /** Override for tests or self-hosted proxies. Defaults to the public API. */
  baseUrl?: string
  /** Custom fetch (for tests). Defaults to the global `fetch`. */
  fetch?: typeof fetch
}

/** A `type: 'client'` tool entry attached to an agent's prompt config. */
export interface ConvaiClientTool {
  type: 'client'
  name: string
  description: string
  expects_response?: boolean
  parameters?: Record<string, unknown>
}

export interface CreateAgentParams {
  displayName: string
  characterName: string
  voiceId: string
  /** Base system prompt — memory/expressivity blocks are appended before sending. */
  systemPrompt: string
  firstMessage: string
  expressivity?: Expressivity
  audioTags?: string[] | null
  voiceSettings?: VoiceSettings
  ttsModelId?: string | null
  /**
   * Tools the client (browser) implements. When omitted, no tools are attached.
   * Consumers who want memory typically pass `MEMORY_CLIENT_TOOLS`.
   */
  tools?: ReadonlyArray<ConvaiClientTool>
  /** Optional memory block for the prompt composer. Default keeps the built-in block. */
  memoryBlock?: string | null
  /** Language code for the conversation (default: 'en'). */
  language?: string
  /** Per-user dynamic variable defaults. Merged on top of `character_name` / `user_context`. */
  dynamicVariablePlaceholders?: Record<string, string>
}

export interface PatchAgentParams {
  displayName?: string
  characterName?: string
  voiceId?: string
  systemPrompt?: string
  firstMessage?: string
  tools?: ReadonlyArray<ConvaiClientTool>
  enableUserContextOverride?: boolean
  expressivity?: Expressivity
  audioTags?: string[] | null
  voiceSettings?: VoiceSettings
  ttsModelId?: string | null
  memoryBlock?: string | null
}

export interface TextToSpeechParams {
  voiceId: string
  text: string
  modelId?: string
  voiceSettings?: VoiceSettings
  /** Accept header; defaults to `audio/mpeg`. */
  accept?: string
}

/**
 * An error thrown when ElevenLabs returns a non-2xx response. Preserves the
 * status and response body so callers can decide how to surface it.
 */
export class ElevenLabsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message)
    this.name = 'ElevenLabsApiError'
  }
}

export class ElevenLabsClient {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(private readonly config: ElevenLabsClientConfig) {
    if (!config.apiKey) throw new Error('ElevenLabsClient: apiKey is required')
    this.baseUrl = (config.baseUrl ?? DEFAULT_ELEVENLABS_BASE_URL).replace(/\/+$/, '')
    this.fetchImpl = config.fetch ?? globalThis.fetch
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('ElevenLabsClient: global fetch is unavailable; pass config.fetch')
    }
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'xi-api-key': this.config.apiKey,
      ...extra,
    }
  }

  /** Create a new convai agent. Returns the new `agent_id`. */
  async createAgent(params: CreateAgentParams): Promise<string> {
    const prompt = composeAgentPrompt(params.systemPrompt, {
      expressivity: params.expressivity ?? 'subtle',
      audioTags: params.audioTags ?? null,
      memoryBlock: params.memoryBlock,
    })

    const ttsConfig: Record<string, unknown> = {
      voice_id: params.voiceId,
      model_id: resolveConvaiTtsModel(params.ttsModelId),
    }
    if (params.voiceSettings) ttsConfig.voice_settings = params.voiceSettings

    const body = {
      name: `Companion-${params.characterName}-for-${params.displayName}`,
      conversation_config: {
        agent: {
          prompt: {
            prompt,
            ...(params.tools ? { tools: params.tools } : {}),
          },
          first_message: params.firstMessage,
          language: params.language ?? 'en',
        },
        tts: ttsConfig,
      },
      platform_settings: {
        overrides: {
          conversation_config_override: {
            agent: { prompt: { prompt: true }, first_message: true, language: true },
            tts: { voice_id: true },
            conversation: { text_only: true },
          },
        },
        dynamic_variables: {
          dynamic_variable_placeholders: {
            user_context: 'No prior memories yet.',
            character_name: '',
            ...(params.dynamicVariablePlaceholders ?? {}),
          },
        },
      },
    }

    const res = await this.fetchImpl(`${this.baseUrl}/v1/convai/agents/create`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new ElevenLabsApiError(`createAgent failed: ${res.status}`, res.status, text)
    }
    const data = (await res.json()) as { agent_id: string }
    return data.agent_id
  }

  /** PATCH any subset of agent settings. Idempotent; only sends the keys you supply. */
  async patchAgent(agentId: string, params: PatchAgentParams): Promise<void> {
    const body: Record<string, unknown> = {}

    if (params.displayName !== undefined || params.characterName !== undefined) {
      body.name = `Companion-${params.characterName ?? ''}-for-${params.displayName ?? ''}`.replace(
        /-for-$/,
        '',
      )
    }

    const conv: Record<string, unknown> = {}
    const agent: Record<string, unknown> = {}
    const prompt: Record<string, unknown> = {}

    if (params.systemPrompt !== undefined) {
      prompt.prompt = composeAgentPrompt(params.systemPrompt, {
        expressivity: params.expressivity ?? 'subtle',
        audioTags: params.audioTags ?? null,
        memoryBlock: params.memoryBlock,
      })
    }
    if (params.tools) prompt.tools = params.tools
    if (Object.keys(prompt).length) agent.prompt = prompt
    if (params.firstMessage !== undefined) agent.first_message = params.firstMessage
    if (Object.keys(agent).length) conv.agent = agent

    const tts: Record<string, unknown> = {}
    if (params.voiceId !== undefined) tts.voice_id = params.voiceId
    if (params.voiceSettings) tts.voice_settings = params.voiceSettings
    if (params.ttsModelId !== undefined) tts.model_id = resolveConvaiTtsModel(params.ttsModelId)
    if (Object.keys(tts).length) conv.tts = tts

    if (Object.keys(conv).length) body.conversation_config = conv

    if (params.enableUserContextOverride) {
      body.platform_settings = {
        overrides: {
          conversation_config_override: {
            agent: { prompt: { prompt: true }, first_message: true, language: true },
            tts: { voice_id: true },
            conversation: { text_only: true },
          },
          custom_llm_extra_body: false,
          enable_conversation_initiation_client_data_from_webhook: false,
        },
        dynamic_variables: {
          dynamic_variable_placeholders: {
            user_context: 'No prior memories yet.',
            character_name: '',
          },
        },
      }
    }

    if (!Object.keys(body).length) return

    const res = await this.fetchImpl(`${this.baseUrl}/v1/convai/agents/${encodeURIComponent(agentId)}`, {
      method: 'PATCH',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new ElevenLabsApiError(`patchAgent failed: ${res.status}`, res.status, text)
    }
  }

  /**
   * Delete a convai agent. Best-effort: swallow errors so teardown during a
   * 500 response doesn't cascade into a second failure.
   */
  async deleteAgent(agentId: string): Promise<void> {
    try {
      await this.fetchImpl(`${this.baseUrl}/v1/convai/agents/${encodeURIComponent(agentId)}`, {
        method: 'DELETE',
        headers: this.headers(),
      })
    } catch {
      // ignore — orphaned agents can be cleaned up manually via the dashboard.
    }
  }

  /** Fetch a short-lived signed URL the browser can use to start a session. */
  async getSignedUrl(agentId: string): Promise<string> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`,
      { headers: this.headers() },
    )
    if (!res.ok) {
      const text = await res.text()
      throw new ElevenLabsApiError(`getSignedUrl failed: ${res.status}`, res.status, text)
    }
    const data = (await res.json()) as { signed_url: string }
    return data.signed_url
  }

  /**
   * One-shot TTS. Returns the raw audio bytes plus the model id that was
   * actually used (some models aren't available for every account, so we
   * fall back to `eleven_turbo_v2_5` on the first failure).
   */
  async textToSpeech(
    params: TextToSpeechParams,
  ): Promise<{ audio: ArrayBuffer; modelId: string; contentType: string }> {
    const modelId = params.modelId && params.modelId.length > 0 ? params.modelId : 'eleven_v3'
    const accept = params.accept ?? 'audio/mpeg'

    const attempt = async (m: string) => {
      const res = await this.fetchImpl(
        `${this.baseUrl}/v1/text-to-speech/${encodeURIComponent(params.voiceId)}`,
        {
          method: 'POST',
          headers: this.headers({ 'content-type': 'application/json', accept }),
          body: JSON.stringify({
            text: params.text,
            model_id: m,
            voice_settings: params.voiceSettings,
          }),
        },
      )
      return res
    }

    let res = await attempt(modelId)
    let used = modelId
    if (!res.ok && modelId !== 'eleven_turbo_v2_5') {
      res = await attempt('eleven_turbo_v2_5')
      used = 'eleven_turbo_v2_5'
    }
    if (!res.ok) {
      const text = await res.text()
      throw new ElevenLabsApiError(`textToSpeech failed: ${res.status}`, res.status, text)
    }
    const audio = await res.arrayBuffer()
    const contentType = res.headers.get('content-type') ?? accept
    return { audio, modelId: used, contentType }
  }

  /** Probe whether a given voice id still exists on the caller's account. */
  async voiceExists(voiceId: string): Promise<boolean> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/voices/${encodeURIComponent(voiceId)}`,
      { headers: this.headers() },
    )
    return res.ok
  }

  /**
   * Register a Twilio phone number with an ElevenLabs agent. EL becomes
   * the SIP target for inbound calls to that number — Twilio bridges
   * the call via EL's native integration and we never have to run a
   * Media Streams ↔ convai WebSocket bridge ourselves.
   *
   * Returns the ElevenLabs `phone_number_id` (distinct from the Twilio
   * `sid`) which is the handle used by `outboundCall` + `deletePhoneNumber`.
   */
  async createPhoneNumberTwilio(params: {
    phoneNumber: string
    label?: string
    agentId: string
    twilioAccountSid: string
    twilioAuthToken: string
  }): Promise<{ phoneNumberId: string }> {
    // Current EL API (late-2026): POST /v1/convai/phone-numbers with a
    // oneOf discriminator body. Agent assignment is NOT part of create
    // — we do it in a follow-up PATCH below. See
    // https://elevenlabs.io/docs/api-reference/phone-numbers/create
    const body = {
      phone_number: params.phoneNumber,
      label: params.label ?? params.phoneNumber,
      provider: 'twilio',
      sid: params.twilioAccountSid,
      token: params.twilioAuthToken,
    }
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/convai/phone-numbers`,
      {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify(body),
      },
    )
    if (!res.ok) {
      const text = await res.text()
      throw new ElevenLabsApiError(
        `createPhoneNumberTwilio failed: ${res.status}`,
        res.status,
        text,
      )
    }
    const data = (await res.json()) as { phone_number_id?: string; id?: string }
    const id = data.phone_number_id ?? data.id
    if (!id) {
      throw new ElevenLabsApiError(
        'createPhoneNumberTwilio returned no id',
        500,
        JSON.stringify(data),
      )
    }

    // Assign the agent via PATCH /v1/convai/phone-numbers/{id}.
    // On failure compensate by deleting the just-created EL phone-number
    // record so we don't leak a dangling unassigned import — the outer
    // caller still owns Twilio-side compensation (release the purchased
    // number) so that side stays balanced.
    const patchRes = await this.fetchImpl(
      `${this.baseUrl}/v1/convai/phone-numbers/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ agent_id: params.agentId }),
      },
    )
    if (!patchRes.ok) {
      const text = await patchRes.text()
      try {
        await this.deletePhoneNumber(id)
      } catch {}
      throw new ElevenLabsApiError(
        `assignAgentToPhoneNumber failed: ${patchRes.status}`,
        patchRes.status,
        text,
      )
    }

    return { phoneNumberId: id }
  }

  /** Detach a previously-registered phone number from ElevenLabs. */
  async deletePhoneNumber(phoneNumberId: string): Promise<void> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/convai/phone-numbers/${encodeURIComponent(phoneNumberId)}`,
      { method: 'DELETE', headers: this.headers() },
    )
    // 404 is acceptable — resource was already released.
    if (!res.ok && res.status !== 404) {
      const text = await res.text()
      throw new ElevenLabsApiError(
        `deletePhoneNumber failed: ${res.status}`,
        res.status,
        text,
      )
    }
  }

  /**
   * Place an outbound PSTN call via a previously-registered EL phone
   * number. EL drives Twilio under the hood — we just hand it the
   * destination number and the agent to bridge to. Returns the Twilio
   * `callSid` + EL `conversationId` for metering / tracing.
   */
  async outboundCall(params: {
    phoneNumberId: string
    agentId: string
    toNumber: string
    dynamicVariables?: Record<string, string>
  }): Promise<{ callSid: string; conversationId: string }> {
    const body: Record<string, unknown> = {
      agent_id: params.agentId,
      to_number: params.toNumber,
    }
    if (params.dynamicVariables) {
      body.conversation_initiation_client_data = {
        dynamic_variables: params.dynamicVariables,
      }
    }
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/convai/phone-numbers/${encodeURIComponent(
        params.phoneNumberId,
      )}/outbound-call`,
      {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify(body),
      },
    )
    if (!res.ok) {
      const text = await res.text()
      throw new ElevenLabsApiError(
        `outboundCall failed: ${res.status}`,
        res.status,
        text,
      )
    }
    const data = (await res.json()) as {
      call_sid?: string
      callSid?: string
      conversation_id?: string
      conversationId?: string
    }
    const callSid = data.call_sid ?? data.callSid
    const conversationId = data.conversation_id ?? data.conversationId
    if (!callSid || !conversationId) {
      throw new ElevenLabsApiError(
        'outboundCall missing callSid or conversationId',
        500,
        JSON.stringify(data),
      )
    }
    return { callSid, conversationId }
  }
}

/**
 * Canonical `add_memory` client-tool definition. Consumers can attach this to
 * their agent's prompt so the model knows it can persist user facts.
 */
export const MEMORY_CLIENT_TOOLS: ReadonlyArray<ConvaiClientTool> = [
  {
    type: 'client',
    name: 'add_memory',
    description:
      'Save a concise canonical fact about the user (preferences, decisions, personal details, follow-ups). Use whenever the user shares something worth remembering.',
    expects_response: true,
    parameters: {
      type: 'object',
      properties: {
        fact: {
          type: 'string',
          description:
            'A short normalized fact, e.g. "prefers window seats", "favorite color: green". Max 500 chars.',
        },
      },
      required: ['fact'],
    },
  },
]
