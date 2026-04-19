// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Framework-agnostic HTTP handlers for ElevenLabs-style client tools:
 * POST JSON `{ user_id, query, limit? }` → retrieve
 * POST JSON `{ user_id, fact }` → add
 */
import type { MemoryStore } from './store.js'

export type GetMemoryStore = (ctx: { userId: string }) => MemoryStore

export interface RetrieveBody {
  user_id: string
  query: string
  limit?: number
}

export interface AddBody {
  user_id: string
  fact: string
}

export interface IngestBody {
  user_id: string
  transcript: string
  /** Default `true`: merge + dedupe + resolve conflicts via the summarizer's `consolidate`. */
  consolidate?: boolean
  /** If `consolidate` is false, whether to route the transcript through `summarize`. */
  summarize?: boolean
}

export interface MemoryHandlers {
  retrieve: (req: Request) => Promise<Response>
  add: (req: Request) => Promise<Response>
  ingest: (req: Request) => Promise<Response>
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function readJson(req: Request): Promise<unknown> {
  try {
    const text = await req.text()
    if (!text) return {}
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

export function createMemoryHandlers(getStore: GetMemoryStore): MemoryHandlers {
  return {
    async retrieve(req: Request): Promise<Response> {
      if (req.method !== 'POST') {
        return json({ error: 'Method Not Allowed' }, 405)
      }
      const raw = await readJson(req)
      if (raw === null || typeof raw !== 'object' || raw === null) {
        return json({ error: 'Invalid JSON body' }, 400)
      }
      const body = raw as Partial<RetrieveBody>
      const user_id = typeof body.user_id === 'string' ? body.user_id : ''
      const query = typeof body.query === 'string' ? body.query : ''
      const limit = typeof body.limit === 'number' ? body.limit : undefined

      if (!user_id.trim()) {
        return json({ error: 'Missing user_id' }, 400)
      }
      if (!query.trim()) {
        return json({ error: 'Missing query' }, 400)
      }

      try {
        const store = getStore({ userId: user_id })
        const hits = store.search(query, { limit: limit ?? 8 })
        return json({
          query,
          results: hits.map(h => ({
            file: h.file,
            lines: `${h.lineStart}-${h.lineEnd}`,
            score: Math.round(h.score * 100) / 100,
            matchType: h.matchType,
            content: h.chunk,
          })),
          totalMatches: hits.length,
        })
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        return json({ error: message }, 500)
      }
    },

    async add(req: Request): Promise<Response> {
      if (req.method !== 'POST') {
        return json({ error: 'Method Not Allowed' }, 405)
      }
      const raw = await readJson(req)
      if (raw === null || typeof raw !== 'object' || raw === null) {
        return json({ error: 'Invalid JSON body' }, 400)
      }
      const body = raw as Partial<AddBody>
      const user_id = typeof body.user_id === 'string' ? body.user_id : ''
      const fact = typeof body.fact === 'string' ? body.fact : ''

      if (!user_id.trim()) {
        return json({ error: 'Missing user_id' }, 400)
      }
      if (!fact.trim()) {
        return json({ error: 'Missing fact' }, 400)
      }

      try {
        const store = getStore({ userId: user_id })
        store.add(fact)
        return json({ ok: true })
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        return json({ error: message }, 500)
      }
    },

    async ingest(req: Request): Promise<Response> {
      if (req.method !== 'POST') {
        return json({ error: 'Method Not Allowed' }, 405)
      }
      const raw = await readJson(req)
      if (raw === null || typeof raw !== 'object' || raw === null) {
        return json({ error: 'Invalid JSON body' }, 400)
      }
      const body = raw as Partial<IngestBody>
      const user_id = typeof body.user_id === 'string' ? body.user_id : ''
      const transcript = typeof body.transcript === 'string' ? body.transcript : ''
      const consolidate = typeof body.consolidate === 'boolean' ? body.consolidate : true
      const summarize = typeof body.summarize === 'boolean' ? body.summarize : false

      if (!user_id.trim()) {
        return json({ error: 'Missing user_id' }, 400)
      }
      if (!transcript.trim()) {
        return json({ error: 'Missing transcript' }, 400)
      }

      let store: ReturnType<GetMemoryStore>
      try {
        store = getStore({ userId: user_id })
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        return json({ error: message }, 500)
      }

      try {
        const result = await store.ingestTranscript(transcript, { consolidate, summarize })
        return json({ ok: true, ...result })
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        return json({ ok: false, error: 'consolidation_failed', detail: message }, 502)
      }
    },
  }
}

/** Wrap a handler for Node `http.createServer` style callbacks */
export function toNodeListener(
  handler: (req: Request) => Promise<Response>,
): (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void {
  return (nodeReq, nodeRes) => {
    void (async () => {
      const url = `http://${nodeReq.headers.host ?? 'localhost'}${nodeReq.url ?? '/'}`
      const chunks: Buffer[] = []
      for await (const chunk of nodeReq) {
        chunks.push(chunk as Buffer)
      }
      const body = Buffer.concat(chunks)
      const init: RequestInit = {
        method: nodeReq.method,
        headers: nodeReq.headers as HeadersInit,
      }
      if (body.length > 0) {
        init.body = body
      }
      const req = new Request(url, init)
      const res = await handler(req)
      nodeRes.statusCode = res.status
      res.headers.forEach((value, key) => {
        nodeRes.setHeader(key, value)
      })
      const buf = Buffer.from(await res.arrayBuffer())
      nodeRes.end(buf)
    })().catch(err => {
      nodeRes.statusCode = 500
      nodeRes.end(err instanceof Error ? err.message : String(err))
    })
  }
}
