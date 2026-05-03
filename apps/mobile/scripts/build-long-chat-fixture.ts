// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Convert the NDJSON dump of a long chat session (produced via `sqlite3
 * shogo.db "SELECT json_object(...) FROM chat_messages ..."`) into a
 * compact JSON fixture the profiler harness can import.
 *
 * Usage:
 *   sqlite3 shogo.db "SELECT json_object('id', id, 'role', role, \
 *     'content', content, 'parts', parts) \
 *     FROM chat_messages WHERE sessionId='<id>' ORDER BY createdAt;" \
 *     > /tmp/long-chat-raw.ndjson
 *   bun run apps/mobile/scripts/build-long-chat-fixture.ts \
 *     /tmp/long-chat-raw.ndjson \
 *     apps/mobile/test/fixtures/long-chat-session.json
 *
 * What it does:
 *   - Drops messages whose parts payload is voice ({kind:"voice"}) — those
 *     are rendered specially in the real app and aren't representative of
 *     the streaming render hot path we want to profile.
 *   - Caps each message's parts at 50 KB so the dev bundle stays sane.
 *     Truncated messages get a sentinel "[truncated for fixture]" suffix.
 *   - Normalizes parts so every fixture message has a real array of
 *     UIMessage-shaped parts, falling back to a synthetic text part when
 *     parts is missing or invalid.
 */

const MAX_PARTS_BYTES = 5_000

interface RawRow {
  id: string
  role: string
  content: string
  parts: string | null
}

interface FixturePart {
  type: 'text' | 'tool-invocation' | 'file' | 'reasoning' | string
  [k: string]: unknown
}

interface FixtureMessage {
  id: string
  role: 'user' | 'assistant' | string
  parts: FixturePart[]
}

function safeParseParts(raw: string | null): unknown {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + ' [truncated for fixture]'
}

function truncateStrings(value: unknown, max: number): unknown {
  if (typeof value === 'string') return truncate(value, max)
  if (Array.isArray(value)) return value.map((v) => truncateStrings(v, max))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = truncateStrings(v, max)
    }
    return out
  }
  return value
}

function normalizeMessage(row: RawRow): FixtureMessage | null {
  const partsRaw = safeParseParts(row.parts)

  // Voice message rows store {kind:"voice"} in `parts`. Skip them; they go
  // through a separate render path.
  if (partsRaw && typeof partsRaw === 'object' && !Array.isArray(partsRaw)) {
    const obj = partsRaw as Record<string, unknown>
    if (obj.kind === 'voice') return null
  }

  let parts: FixturePart[]
  if (Array.isArray(partsRaw)) {
    parts = partsRaw as FixturePart[]
  } else {
    parts = [{ type: 'text', text: row.content || '' }]
  }

  // Recursively truncate any string field above the cap so tool
  // input/output blobs don't dominate the fixture bundle.
  parts = parts.map((p) => truncateStrings(p, MAX_PARTS_BYTES) as FixturePart)

  return {
    id: row.id,
    role: (row.role === 'user' || row.role === 'assistant') ? row.role : row.role,
    parts,
  }
}

async function main() {
  const [, , inputPath, outputPath] = process.argv
  if (!inputPath || !outputPath) {
    console.error('Usage: build-long-chat-fixture.ts <input.ndjson> <output.json>')
    process.exit(1)
  }

  const text = await Bun.file(inputPath).text()
  const lines = text.split('\n').filter((l) => l.trim().length > 0)

  const messages: FixtureMessage[] = []
  let skipped = 0
  for (const line of lines) {
    const row = JSON.parse(line) as RawRow
    const msg = normalizeMessage(row)
    if (msg) messages.push(msg)
    else skipped++
  }

  const out = {
    sourceSessionId: 'fbe015c8-f159-4750-8dae-25e7e9fd03a9',
    messageCount: messages.length,
    skippedVoice: skipped,
    messages,
  }

  const json = JSON.stringify(out)
  await Bun.write(outputPath, json)
  console.log(
    `wrote ${outputPath}  ${json.length.toLocaleString()} bytes  ` +
      `${messages.length} messages (${skipped} voice messages skipped)`,
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
