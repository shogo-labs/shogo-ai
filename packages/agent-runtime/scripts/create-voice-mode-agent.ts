// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Provision (or refresh) the shared "Shogo Mode" ElevenLabs convai
 * agent.
 *
 * The agent's prompt + tools + first_message live in
 * `src/voice-mode/translator-persona.ts`. This script is the only
 * thing that pushes those values to ElevenLabs. V1 uses one shared
 * agent across all users; the browser mints short-lived signed URLs
 * against it from `/api/voice/signed-url`.
 *
 * Two modes:
 *
 *   - Create (no `ELEVENLABS_VOICE_MODE_AGENT_ID` env / flag):
 *       creates a brand new agent and prints the id you should add
 *       to your server env.
 *
 *   - Update (`ELEVENLABS_VOICE_MODE_AGENT_ID=agent_...`):
 *       PATCHes the existing agent's persona prompt, tools, and
 *       first_message in place. The agent_id stays stable, so no
 *       env-var rotation needed. Use this to refresh the deployed
 *       persona after editing `translator-persona.ts`.
 *
 * Usage:
 *
 *   # Create new
 *   ELEVENLABS_API_KEY=sk_... \
 *     bun run packages/agent-runtime/scripts/create-voice-mode-agent.ts
 *
 *   # Refresh existing in place
 *   ELEVENLABS_API_KEY=sk_... \
 *   ELEVENLABS_VOICE_MODE_AGENT_ID=agent_xyz... \
 *     bun run packages/agent-runtime/scripts/create-voice-mode-agent.ts
 *
 * Optional env:
 *   - SHOGO_VOICE_MODE_VOICE_ID  — ElevenLabs voice id (default: Rachel / EXAVITQu4vr4xnSDxMaL).
 *   - SHOGO_VOICE_MODE_NAME      — Display name for the agent (default: "Shogo Mode").
 */

import { ElevenLabsClient } from '@shogo-ai/sdk/voice'
import {
  TRANSLATOR_SYSTEM_PROMPT,
  TRANSLATOR_ELEVENLABS_TOOLS,
  TRANSLATOR_FIRST_MESSAGE,
} from '../src/voice-mode/translator-persona'

const DEFAULT_VOICE_ID = 'EXAVITQu4vr4xnSDxMaL' // Rachel — calm, concierge-y.
const DEFAULT_DISPLAY_NAME = 'Shogo Mode'
// ElevenLabs rejects `eleven_turbo_v2_5` for English-only agents on most
// plans ("English Agents must use turbo or flash v2"). Default to
// `eleven_turbo_v2`, which is accepted everywhere; override via
// SHOGO_VOICE_MODE_TTS_MODEL if you need one of the multilingual variants.
const DEFAULT_TTS_MODEL = 'eleven_turbo_v2'

async function main() {
  const apiKey = process.env.ELEVENLABS_API_KEY
  if (!apiKey) {
    console.error(
      '[create-voice-mode-agent] ELEVENLABS_API_KEY is required. ' +
        'Get one at https://elevenlabs.io/app/speech-synthesis and re-run.',
    )
    process.exit(1)
  }

  const voiceId = process.env.SHOGO_VOICE_MODE_VOICE_ID || DEFAULT_VOICE_ID
  const displayName = process.env.SHOGO_VOICE_MODE_NAME || DEFAULT_DISPLAY_NAME
  const ttsModelId = process.env.SHOGO_VOICE_MODE_TTS_MODEL || DEFAULT_TTS_MODEL
  const existingAgentId = process.env.ELEVENLABS_VOICE_MODE_AGENT_ID

  const client = new ElevenLabsClient({ apiKey })

  if (existingAgentId) {
    console.log(
      `[create-voice-mode-agent] Refreshing convai agent ${existingAgentId} ` +
        '(persona + tools + first_message)…',
    )
    try {
      await client.patchAgent(existingAgentId, {
        displayName,
        characterName: 'Shogo',
        voiceId,
        ttsModelId,
        systemPrompt: TRANSLATOR_SYSTEM_PROMPT,
        firstMessage: TRANSLATOR_FIRST_MESSAGE,
        tools: TRANSLATOR_ELEVENLABS_TOOLS,
        memoryBlock: null,
        expressivity: 'subtle',
        // Re-assert that signed-URL sessions may override the system
        // prompt + first_message. Older agents may have been created
        // without this — re-running the script flips the bit on.
        enableUserContextOverride: true,
      })
      console.log('\n[create-voice-mode-agent] ✓ agent refreshed')
      console.log(`  agent_id: ${existingAgentId}`)
      console.log(
        '\nNo env changes required — the existing ELEVENLABS_VOICE_MODE_AGENT_ID ' +
          'still points at the same agent.',
      )
      return
    } catch (err: any) {
      console.error('[create-voice-mode-agent] patch failed:', err?.message || err)
      if (err?.body) console.error('  body:', err.body)
      if (err?.detail) console.error('  detail:', err.detail)
      process.exit(1)
    }
  }

  console.log(
    `[create-voice-mode-agent] Creating convai agent "${displayName}" with voice ${voiceId}…`,
  )

  try {
    const agentId = await client.createAgent({
      displayName,
      characterName: 'Shogo',
      voiceId,
      ttsModelId,
      systemPrompt: TRANSLATOR_SYSTEM_PROMPT,
      firstMessage: TRANSLATOR_FIRST_MESSAGE,
      tools: TRANSLATOR_ELEVENLABS_TOOLS,
      // No per-user memory for the translator; memoryBlock: null suppresses
      // the SDK's default memory prompt block so the persona stays pure.
      memoryBlock: null,
      expressivity: 'subtle',
      language: 'en',
    })

    console.log('\n[create-voice-mode-agent] ✓ agent created')
    console.log(`  agent_id: ${agentId}`)
    console.log(
      '\nAdd this to your server env as ELEVENLABS_VOICE_MODE_AGENT_ID and ' +
        'restart the API so /api/voice/signed-url can mint signed URLs.',
    )
  } catch (err: any) {
    console.error('[create-voice-mode-agent] failed:', err?.message || err)
    // ElevenLabsApiError surfaces the raw response body on `.body` — that's
    // where the real validation error lives when the API returns 4xx.
    if (err?.body) console.error('  body:', err.body)
    if (err?.detail) console.error('  detail:', err.detail)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('[create-voice-mode-agent] unexpected error:', err)
  process.exit(1)
})
