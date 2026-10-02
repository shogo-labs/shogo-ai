// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Scripted OpenAI-compatible model server for the desktop streaming e2e.
 *
 * The local API (SHOGO_LOCAL_MODE) sends every model call to
 * `LOCAL_LLM_BASE_URL/v1/chat/completions`, so pointing that at this server
 * lets the real app, API and agent runtime run a deterministic "model".
 *
 * A turn is scripted by a marker in the user's message:
 *
 *   [[e2e:long:tag=a1:n=1500:ms=10]]
 *       n numbered tokens, one every ms.
 *   [[e2e:hold:tag=a1:n=50:ms=10]]
 *       Waits for release(tag) before streaming, like a model that is slow to
 *       start. Nothing is emitted while held.
 *   [[e2e:tool:tag=a1:n=300:ms=10:rounds=2]]
 *       The n tokens are split into rounds+1 segments. After each of the first
 *       `rounds` segments the model calls a tool; the runtime runs it and
 *       calls the model again, which continues with the next segment. Add
 *       holdAt=R to wait for release(tag) before round R's segment starts
 *       (R=0 is the first request), and gap=ms to delay each continuation.
 *
 * Every token is `t<tag>w<NNNN>` so any view can be checked for gaps,
 * repeats and reordering just by parsing its text (see stream-probe.ts).
 * Token numbering continues across tool rounds, so a finished tool turn must
 * read exactly 1..n with the tool cards in between.
 * Requests without a marker get a short `ok` reply (titles, side calls).
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'

export type Script = 'long' | 'hold' | 'tool' | 'plain'

/** One request the app made to the model. */
export interface FakeTurn {
  id: number
  script: Script
  tag: string
  /** 0-based tool round this request continues (always 0 except for `tool`). */
  round: number
  startedAt: number
  /** Wall-clock ms at which each token of THIS request was written. */
  sentAt: number[]
  /** Set when the client (the API proxy) hung up before the request finished. */
  clientClosedAt?: number
  finishedAt?: number
  /** Name of the tool called at the end of this request, if any. */
  toolCalled?: string
  userText: string
}

interface Marker {
  script: 'long' | 'hold' | 'tool'
  tag: string
  n: number
  ms: number
  rounds: number
  holdAt: number | null
  gap: number
}

const MARKER = /\[\[e2e:(long|hold|tool)((?::[a-zA-Z]+=[\w-]+)*)\]\]/

/** Tool the fake model calls. `read_file` works on a missing path too: an error result still continues the turn. */
const TOOL_PREFERENCE = ['read_file', 'list_files', 'ls']
/**
 * The agent stops a turn that repeats the same tool call with identical input (loop
 * detection), or after several failing calls in a row. So every round reads a longer
 * slice of a file that exists: distinct input, always a success.
 */
const toolArgs = (_tag: string, round: number): Record<string, unknown> => ({ path: 'AGENTS.md', offset: 1, limit: round + 1 })

export function marker(
  script: 'long' | 'hold' | 'tool',
  tag: string,
  n: number,
  options: { ms?: number; rounds?: number; holdAt?: number; gap?: number } = {},
): string {
  const parts = [`tag=${tag}`, `n=${n}`, `ms=${options.ms ?? 10}`]
  if (options.rounds !== undefined) parts.push(`rounds=${options.rounds}`)
  if (options.holdAt !== undefined) parts.push(`holdAt=${options.holdAt}`)
  if (options.gap !== undefined) parts.push(`gap=${options.gap}`)
  return `[[e2e:${script}:${parts.join(':')}]]`
}

/** Token text for the 1-based position `i` of turn `tag`. */
export function token(tag: string, i: number): string {
  return `t${tag}w${String(i).padStart(4, '0')}`
}

export function expectedTokens(tag: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => token(tag, i + 1))
}

function parseMarker(text: string): Marker | null {
  const m = MARKER.exec(text)
  if (!m) return null
  const params: Record<string, string> = {}
  for (const part of m[2].split(':').filter(Boolean)) {
    const [k, v] = part.split('=')
    params[k] = v
  }
  const script = m[1] as Marker['script']
  return {
    script,
    tag: params.tag ?? 'x',
    n: Number(params.n ?? 100),
    ms: Number(params.ms ?? 10),
    rounds: script === 'tool' ? Math.max(1, Number(params.rounds ?? 1)) : 0,
    holdAt: script === 'hold' ? 0 : params.holdAt !== undefined ? Number(params.holdAt) : null,
    gap: Number(params.gap ?? 0),
  }
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
      .join('\n')
  }
  return ''
}

/** The last user message, and how many tool results follow it (the tool round). */
function conversationState(messages: any[]): { userText: string; round: number } {
  let lastUser = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      lastUser = i
      break
    }
  }
  if (lastUser < 0) return { userText: '', round: 0 }
  let round = 0
  for (let i = lastUser + 1; i < messages.length; i++) if (messages[i]?.role === 'tool') round++
  return { userText: contentText(messages[lastUser].content), round }
}

export class FakeLlmServer {
  readonly turns: FakeTurn[] = []
  private server: http.Server | null = null
  private nextId = 1
  private readonly holds = new Map<string, () => void>()
  private readonly released = new Set<string>()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  /** Per tag: wall-clock ms at which token i (index i-1) was written, across all rounds. */
  private readonly sent = new Map<string, number[]>()

  get url(): string {
    const address = this.server?.address() as AddressInfo | null
    if (!address) throw new Error('fake LLM server is not listening')
    return `http://127.0.0.1:${address.port}`
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
  }

  async stop(): Promise<void> {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    for (const release of this.holds.values()) release()
    this.server?.closeAllConnections?.()
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()))
    this.server = null
  }

  /** Lets a held request start streaming. Safe to call before the request arrives. */
  release(tag: string): void {
    this.released.add(tag)
    this.holds.get(tag)?.()
  }

  /** Token send times for `tag` across every round, token i at index i-1. */
  sentAt(tag: string): number[] {
    return (this.sent.get(tag) ?? []).filter((t) => t !== undefined)
  }

  /** The most recent request for `tag`. */
  turn(tag: string): FakeTurn | undefined {
    for (let i = this.turns.length - 1; i >= 0; i--) if (this.turns[i].tag === tag) return this.turns[i]
    return undefined
  }

  requestsFor(tag: string): FakeTurn[] {
    return this.turns.filter((t) => t.tag === tag)
  }

  /** True once the proxy hung up on a request for `tag` before it finished. */
  wasCancelled(tag: string): boolean {
    return this.requestsFor(tag).some((t) => t.clientClosedAt !== undefined)
  }

  async waitForTurn(tag: string, timeoutMs = 60_000): Promise<FakeTurn> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const turn = this.turn(tag)
      if (turn) return turn
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error(`fake LLM never received a request for turn "${tag}" within ${timeoutMs}ms`)
  }

  async waitForTokens(tag: string, count: number, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.sentAt(tag).length >= count) return
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error(`turn "${tag}" reached ${this.sentAt(tag).length}/${count} tokens within ${timeoutMs}ms`)
  }

  async waitForRequestCount(tag: string, count: number, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.requestsFor(tag).length >= count) return
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error(`turn "${tag}" had ${this.requestsFor(tag).length}/${count} model requests within ${timeoutMs}ms`)
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x')
    if (req.method === 'GET' && url.pathname.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-stream', object: 'model' }] }))
      return
    }
    if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
      res.writeHead(404).end()
      return
    }

    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    let body: any = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      /* fall through with an empty body */
    }

    const { userText, round } = conversationState(Array.isArray(body.messages) ? body.messages : [])
    const toolNames: string[] = (Array.isArray(body.tools) ? body.tools : []).map((t: any) => t?.function?.name).filter(Boolean)
    // Only agent turns carry tools. Title generation and other side calls may
    // quote the user's text, marker included, and must stay plain.
    const parsed = toolNames.length > 0 ? parseMarker(userText) : null

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    // Real providers answer with headers right away, long before the first
    // token; the client must see an open stream while a request is held.
    res.flushHeaders()
    res.write(': open\n\n')

    const turn: FakeTurn = {
      id: this.nextId++,
      script: parsed?.script ?? 'plain',
      tag: parsed?.tag ?? `plain${this.nextId}`,
      round,
      startedAt: Date.now(),
      sentAt: [],
      userText,
    }
    this.turns.push(turn)

    let closed = false
    const onClientGone = () => {
      if (closed || res.writableEnded) return
      closed = true
      turn.clientClosedAt = Date.now()
      this.holds.get(turn.tag)?.()
    }
    // Different runtimes surface a hang-up on different objects.
    res.on('close', onClientGone)
    req.on('close', onClientGone)
    req.socket.on('close', onClientGone)

    const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: `c${turn.id}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    const finish = (reason: 'stop' | 'tool_calls') => {
      if (closed) return
      res.write(chunk({}, reason))
      // Real OpenAI-compatible servers end with a usage chunk when asked for one
      // (stream_options.include_usage). Without it the agent sees a turn with zero
      // output tokens and reports "Agent produced no output".
      const completion = Math.max(1, turn.sentAt.length)
      res.write(
        `data: ${JSON.stringify({ id: `c${turn.id}`, object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 200, completion_tokens: completion, total_tokens: 200 + completion } })}\n\n`,
      )
      res.write('data: [DONE]\n\n')
      res.end()
      turn.finishedAt = Date.now()
    }
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.timers.delete(timer)
          resolve()
        }, ms)
        this.timers.add(timer)
      })

    if (!parsed) {
      res.write(chunk({ content: 'ok' }))
      turn.sentAt.push(Date.now())
      finish('stop')
      return
    }

    // Continuations model a slow follow-up call after the tool ran.
    if (round > 0 && parsed.gap > 0) await sleep(parsed.gap)

    if (parsed.holdAt === round && !this.released.has(parsed.tag)) {
      // Keep the connection alive with SSE comments, like a model "thinking".
      const ping = setInterval(() => !closed && res.write(': keepalive\n\n'), 1000)
      await new Promise<void>((resolve) => {
        this.holds.set(parsed.tag, resolve)
      })
      this.holds.delete(parsed.tag)
      clearInterval(ping)
    }

    // This request's slice of the n tokens.
    const segments = parsed.rounds + 1
    const per = Math.floor(parsed.n / segments)
    const first = round * per + 1
    const last = round >= parsed.rounds ? parsed.n : (round + 1) * per

    // Absolute schedule, so a slow consumer can't stretch the whole stream.
    const t0 = Date.now()
    const log = this.sent.get(parsed.tag) ?? []
    this.sent.set(parsed.tag, log)
    for (let i = first; i <= last && !closed; i++) {
      const wait = t0 + (i - first) * parsed.ms - Date.now()
      if (wait > 0) await sleep(wait)
      if (closed) break
      // A paragraph break every 40 tokens keeps the markdown realistic.
      res.write(chunk({ content: `${token(parsed.tag, i)}${i % 40 === 0 ? '\n\n' : ' '}` }))
      const now = Date.now()
      turn.sentAt.push(now)
      log[i - 1] = now
    }
    if (closed) return

    if (round < parsed.rounds) {
      const name = TOOL_PREFERENCE.find((n) => toolNames.includes(n))
      if (name) {
        const args = JSON.stringify(toolArgs(parsed.tag, round))
        const id = `call_${parsed.tag}_${round}`
        res.write(chunk({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] }))
        res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(0, 8) } }] }))
        res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(8) } }] }))
        turn.toolCalled = name
        finish('tool_calls')
        return
      }
      // No usable tool in this runtime: say so loudly instead of passing silently.
      res.write(chunk({ content: ` [e2e: none of ${TOOL_PREFERENCE.join(', ')} offered; tools were: ${toolNames.join(',')}]` }))
    }
    finish('stop')
  }
}
