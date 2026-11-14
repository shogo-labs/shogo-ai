// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Hono } from 'hono'
import { generateProxyToken } from '../lib/ai-proxy-token'
import { resolveApiBaseUrl } from '../lib/internal-proxy-config'
import {
  DICTATION_MAX_BYTES,
  friendlyMeetingError,
  resolvePersonalWorkspaceId,
  transcribeDictation,
} from '../services/meeting.service'

export const dictationRoutes = new Hono()

/** Short chat-composer dictation, available in both local and cloud mode. */
dictationRoutes.post('/dictation/transcribe', async (c) => {
  const localMode = process.env.SHOGO_LOCAL_MODE === 'true'
  const auth = c.get('auth') as { isAuthenticated?: boolean; userId?: string; via?: string } | undefined
  if (!localMode && (!auth?.isAuthenticated || !auth.userId)) {
    return c.json({ error: 'Please sign in to use voice typing.' }, 401)
  }
  // Runtime and API-key identities can carry an owner's userId without being
  // that person. Dictation is a personal-workspace, user-initiated operation.
  if (!localMode && auth?.via !== 'session' && auth?.via !== 'tunnel') {
    return c.json({ error: 'Voice typing requires a user session.' }, 403)
  }

  const declared = Number(c.req.header('content-length') || 0)
  if (declared > DICTATION_MAX_BYTES) {
    return c.json({ error: 'Audio clip is too large' }, 413)
  }

  let audio: Buffer
  try {
    const reader = c.req.raw.body?.getReader()
    if (!reader) return c.json({ error: 'Could not read the audio clip' }, 400)
    const chunks: Buffer[] = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > DICTATION_MAX_BYTES) {
        void reader.cancel().catch(() => {})
        return c.json({ error: 'Audio clip is too large' }, 413)
      }
      chunks.push(Buffer.from(value))
    }
    audio = Buffer.concat(chunks, size)
  } catch (error) {
    if ((error as { name?: string })?.name === 'BodyLimitError') {
      return c.json({ error: 'Audio clip is too large' }, 413)
    }
    return c.json({ error: 'Could not read the audio clip' }, 400)
  }

  try {
    if (localMode) {
      const result = await transcribeDictation(audio)
      if (!result.ok) return c.json({ error: 'Send a WAV clip of 8 MB or less' }, 400)
      return c.json({ text: result.text })
    }

    const workspaceId = await resolvePersonalWorkspaceId(auth.userId)
    if (!workspaceId) {
      return c.json({ error: 'A personal workspace is required for voice typing.' }, 404)
    }

    const proxyToken = await generateProxyToken(
      'workspace',
      workspaceId,
      auth.userId,
      5 * 60 * 1000,
    )
    const result = await transcribeDictation(audio, {
      cloudAuth: {
        proxyUrl: `${resolveApiBaseUrl()}/api/ai/v1`,
        proxyToken,
      },
    })
    if (!result.ok) return c.json({ error: 'Send a WAV clip of 8 MB or less' }, 400)
    return c.json({ text: result.text })
  } catch (err: any) {
    console.warn('[Dictation] Transcription failed:', err?.message ?? err)
    return c.json({ error: friendlyMeetingError('transcript', err) }, 503)
  }
})
