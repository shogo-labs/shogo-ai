// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Swapping one person's two account ids in a request or a reply.
 *
 * The same person has a cloud account and a local account on each desktop,
 * with different ids. Wherever one side reads or writes the other's rows — the
 * desktop as a client of a cloud workspace (`routes/local-cloud-proxy`), the
 * cloud serving a paired machine's workspace (`lib/machine-identity`) — exact
 * matches are swapped so each side only ever sees its own id for "me".
 */

/** `from id → to id`. Exact string matches only: never a substring. */
export type IdentityMap = Map<string, string>

export function translate(value: unknown, map: IdentityMap): unknown {
  if (typeof value === 'string') return map.get(value) ?? value
  if (Array.isArray(value)) return value.map((v) => translate(v, map))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [map.get(k) ?? k, translate(v, map)]))
  }
  return value
}

function mentions(text: string, map: IdentityMap): boolean {
  for (const k of map.keys()) if (text.includes(k)) return true
  return false
}

/** Swaps ids inside a JSON text; anything that isn't JSON passes through. */
export function translateJsonText(text: string, map: IdentityMap): string {
  if (map.size === 0 || !mentions(text, map)) return text
  try {
    return JSON.stringify(translate(JSON.parse(text), map))
  } catch {
    return text
  }
}

/** Swaps ids in each `data:` line of a server-sent event stream. */
export function translateEventStream(body: ReadableStream<Uint8Array>, map: IdentityMap): ReadableStream<Uint8Array> {
  if (map.size === 0) return body
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffered = ''
  const line = (l: string) => {
    const m = /^data: ?(.*)$/.exec(l)
    return m ? `data: ${translateJsonText(m[1]!, map)}` : l
  }
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffered += decoder.decode(chunk, { stream: true })
        const lines = buffered.split('\n')
        buffered = lines.pop() ?? ''
        if (lines.length) controller.enqueue(encoder.encode(lines.map(line).join('\n') + '\n'))
      },
      flush(controller) {
        buffered += decoder.decode()
        if (buffered) controller.enqueue(encoder.encode(line(buffered)))
      },
    }),
  )
}

/** A reply's body with ids swapped: JSON and event streams; anything else untouched. */
export async function translateResponseBody(resp: Response, map: IdentityMap): Promise<BodyInit | null> {
  if (map.size === 0 || !resp.body) return resp.body
  const type = resp.headers.get('content-type') ?? ''
  if (type.includes('text/event-stream')) return translateEventStream(resp.body, map)
  if (type.includes('application/json')) return translateJsonText(await resp.text(), map)
  return resp.body
}

/** Swaps whole path segments and whole query values. */
export function translatePathAndSearch(path: string, search: string, map: IdentityMap): { path: string; search: string } {
  if (map.size === 0) return { path, search }
  const translatedPath = path
    .split('/')
    .map((seg) => {
      const decoded = (() => { try { return decodeURIComponent(seg) } catch { return seg } })()
      const hit = map.get(decoded)
      return hit ? encodeURIComponent(hit) : seg
    })
    .join('/')
  const params = new URLSearchParams(search)
  let changed = false
  for (const [k, v] of [...params]) {
    const hit = map.get(v)
    if (hit) { params.set(k, hit); changed = true }
  }
  return { path: translatedPath, search: changed ? `?${params}` : search }
}
