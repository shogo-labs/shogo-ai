// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared audio transcription helper (OpenAI Whisper / AI-proxy).
 * Extracted from createTranscribeAudioTool so it can also be used
 * by channel adapters (e.g. WhatsApp voice notes).
 */

export async function transcribeAudioBuffer(
  audioBuffer: Uint8Array | Buffer,
  opts: {
    ext?: string
    language?: string
    aiProxyUrl?: string
    aiProxyToken?: string
  } = {}
): Promise<{ text: string; duration?: number } | { error: string }> {
  const { ext = '.ogg', language, aiProxyUrl, aiProxyToken } = opts

  const proxyUrl = aiProxyUrl || process.env.AI_PROXY_URL
  const proxyToken = aiProxyToken || process.env.AI_PROXY_TOKEN
  const directKey = process.env.OPENAI_API_KEY

  // AI_PROXY_URL is `${apiBase}/api/ai/v1`; strip `/v1` to reach the proxy's
  // own transcription route instead of OpenAI directly.
  const apiBase = proxyUrl ? proxyUrl.replace(/\/v1$/, '') : 'https://api.openai.com'
  const apiKey = proxyToken || directKey

  if (!apiKey) {
    return { error: 'Audio transcription not available: no OpenAI API key configured.' }
  }

  const mimeMap: Record<string, string> = {
    '.mp3': 'audio/mpeg',
    '.mp4': 'audio/mp4',
    '.mpeg': 'audio/mpeg',
    '.mpga': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.wav': 'audio/wav',
    '.webm': 'audio/webm',
    '.ogg': 'audio/ogg',
    '.opus': 'audio/ogg',
  }
  const mimeType = mimeMap[ext] || 'audio/ogg'

  try {
    const formData = new FormData()
    formData.append('file', new Blob([audioBuffer], { type: mimeType }), `audio${ext}`)
    formData.append('model', 'whisper-1')
    formData.append('response_format', 'verbose_json')
    if (language) formData.append('language', language)

    const response = await fetch(`${apiBase}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
      signal: AbortSignal.timeout(120_000),
    })

    if (!response.ok) {
      const errBody = await response.text().catch(() => '')
      return { error: `Whisper API error (${response.status}): ${errBody.slice(0, 300)}` }
    }

    const result = (await response.json()) as { text: string; duration?: number }
    return { text: result.text, duration: result.duration }
  } catch (err: any) {
    return { error: `Audio transcription failed: ${err.message}` }
  }
}
