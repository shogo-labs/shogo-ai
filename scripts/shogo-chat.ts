#!/usr/bin/env bun
/**
 * Resilient Shogo chat driver.
 *
 * Usage:
 *   SHOGO_KEY=shogo_sk_... bun scripts/shogo-chat.ts <projectId> <sessionId> <message|@file>
 *
 * The API stream is treated as a resumable transport. Every parsed SSE frame
 * is persisted before it is displayed, and a dropped connection is resumed
 * from the last observed sequence after checking the durable turn snapshot.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const [projectId, sessionId, messageArg] = process.argv.slice(2)
const baseUrl = process.env.SHOGO_BASE ?? 'https://studio.shogo.ai'
const apiKey = process.env.SHOGO_KEY
const logPath = process.env.SHOGO_CHAT_LOG ?? resolve(`.shogo-chat-${sessionId ?? 'session'}.jsonl`)

if (!projectId || !sessionId || !messageArg || !apiKey) {
  console.error('Usage: SHOGO_KEY=... bun scripts/shogo-chat.ts <projectId> <sessionId> <message|@file>')
  process.exit(1)
}

const message = messageArg.startsWith('@')
  ? await Bun.file(messageArg.slice(1)).text()
  : messageArg

mkdirSync(dirname(logPath), { recursive: true })

let lastSeq = -1
let printedText = ''
let sawComplete = false

function persist(event: unknown): void {
  appendFileSync(logPath, `${JSON.stringify(event)}\n`, 'utf8')
}

function handleEvent(event: any): void {
  persist(event)
  if (event.type === 'data-turn-seq' && typeof event.data?.seq === 'number') {
    lastSeq = Math.max(lastSeq, event.data.seq)
  }
  if (event.type === 'text-delta' || event.type === 'text') {
    const text = event.delta ?? event.content ?? ''
    printedText += text
    process.stdout.write(text)
  }
  if (event.type === 'tool-input-available') {
    process.stdout.write(`\n[TOOL CALL] ${event.toolName} ${JSON.stringify(event.input ?? {})}\n`)
  }
  if (event.type === 'tool-output-available' || event.type === 'tool-result') {
    process.stdout.write(`[TOOL RESULT] ${JSON.stringify(event.result ?? event.output ?? {})}\n`)
  }
  if (event.type === 'data-turn-complete') sawComplete = true
  if (event.type === 'error') {
    process.stderr.write(`\n[STREAM ERROR] ${event.errorText ?? event.message ?? JSON.stringify(event)}\n`)
  }
}

async function readSse(response: Response): Promise<void> {
  if (!response.body) throw new Error('Response has no stream body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const payload = line.slice(6).trim()
      if (!payload || payload === '[DONE]' || payload === '{}') continue
      try { handleEvent(JSON.parse(payload)) } catch { /* keep the raw stream moving */ }
    }
  }
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
}

async function streamFrom(seq: number): Promise<void> {
  const response = await request(
    `/api/projects/${encodeURIComponent(projectId)}/chat/${encodeURIComponent(sessionId)}/stream?fromSeq=${Math.max(0, seq)}`,
    { signal: AbortSignal.timeout(90_000) },
  )
  if (!response.ok) throw new Error(`Stream HTTP ${response.status}: ${await response.text()}`)
  await readSse(response)
}

const post = await request(`/api/projects/${encodeURIComponent(projectId)}/chat`, {
  method: 'POST',
  headers: { 'x-chat-session-id': sessionId },
  body: JSON.stringify({
    messages: [{ role: 'user', parts: [{ type: 'text', text: message }] }],
    chatSessionId: sessionId,
  }),
})
if (!post.ok) throw new Error(`Chat HTTP ${post.status}: ${await post.text()}`)

try {
  await readSse(post)
} catch (error) {
  process.stderr.write(`\nInitial stream disconnected: ${error instanceof Error ? error.message : error}\n`)
}

while (!sawComplete) {
  const snapshot = await request(
    `/api/projects/${encodeURIComponent(projectId)}/chat/${encodeURIComponent(sessionId)}/turn`,
    { signal: AbortSignal.timeout(15_000) },
  ).then(response => response.json() as Promise<any>)
  if (snapshot.status === 'unknown') {
    throw new Error('Turn state expired before the stream completed; inspect the persisted JSONL log.')
  }
  if (snapshot.status !== 'active') break
  try {
    await streamFrom(lastSeq + 1)
  } catch (error) {
    process.stderr.write(`\nResume stream disconnected: ${error instanceof Error ? error.message : error}\n`)
    await new Promise(resolve => setTimeout(resolve, 2_000))
  }
}

process.stdout.write(`\n\nCompleted. ${printedText.length} text chars. Transcript: ${logPath}\n`)
