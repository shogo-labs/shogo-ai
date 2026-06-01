// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Live integration check for `ElevenLabsClient.composeMusic()`.
 *
 * Generates a real track via the ElevenLabs Music API (`POST /v1/music`)
 * and writes the audio to disk. Requires a paid-tier ElevenLabs key.
 *
 * Usage:
 *   ELEVENLABS_API_KEY=sk_... bun packages/voice/scripts/generate-music.ts
 *
 * Optional env:
 *   MUSIC_PROMPT       prompt text (default: an upbeat synthwave clip)
 *   MUSIC_LENGTH_MS    duration in ms, 3000–600000 (default: 10000)
 *   MUSIC_OUT          output file path (default: ./shogo-music-<ts>.mp3)
 *   MUSIC_OUTPUT_FORMAT EL output_format (default: mp3_44100_128)
 */

import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ElevenLabsApiError, ElevenLabsClient } from '../src/elevenlabs.js'

async function main(): Promise<void> {
  const apiKey = process.env.ELEVENLABS_API_KEY
  if (!apiKey) {
    console.error(
      'ELEVENLABS_API_KEY is required.\n' +
        '  ELEVENLABS_API_KEY=sk_... bun packages/voice/scripts/generate-music.ts',
    )
    process.exit(1)
  }

  const prompt =
    process.env.MUSIC_PROMPT ??
    'Upbeat retro synthwave with driving bass, bright arpeggios, and punchy drums. Around 110 BPM, optimistic and cinematic.'
  const musicLengthMs = Number(process.env.MUSIC_LENGTH_MS ?? '10000')
  const outputFormat = process.env.MUSIC_OUTPUT_FORMAT ?? 'mp3_44100_128'
  const out = resolve(
    process.env.MUSIC_OUT ?? `shogo-music-${Date.now()}.mp3`,
  )

  const el = new ElevenLabsClient({ apiKey })

  console.log('Composing music via ElevenLabs Music API…')
  console.log(`  prompt:        ${prompt}`)
  console.log(`  musicLengthMs: ${musicLengthMs}`)
  console.log(`  outputFormat:  ${outputFormat}`)

  const started = Date.now()
  try {
    const { audio, contentType } = await el.composeMusic({
      prompt,
      musicLengthMs,
      outputFormat,
    })
    await writeFile(out, Buffer.from(audio))
    const kb = (audio.byteLength / 1024).toFixed(1)
    const secs = ((Date.now() - started) / 1000).toFixed(1)
    console.log(`\nDone in ${secs}s.`)
    console.log(`  contentType: ${contentType}`)
    console.log(`  bytes:       ${audio.byteLength} (${kb} KB)`)
    console.log(`  saved to:    ${out}`)
  } catch (err) {
    if (err instanceof ElevenLabsApiError) {
      console.error(`\nElevenLabs API error ${err.status}:`)
      console.error(err.body)
      if (err.status === 401) {
        console.error('\nThe Music API is paid-tier only — check the key has music access.')
      }
    } else {
      console.error('\nUnexpected error:', err)
    }
    process.exit(1)
  }
}

void main()
