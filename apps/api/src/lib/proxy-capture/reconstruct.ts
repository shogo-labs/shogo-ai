export type ObjectLoader = (key: string) => Promise<unknown>

interface ChainReference {
  head?: string | null
  tail?: unknown[]
  list?: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

async function loadCached(key: string, load: ObjectLoader, cache: Map<string, unknown>): Promise<unknown> {
  if (cache.has(key)) return cache.get(key)
  const value = await load(key)
  cache.set(key, value)
  return value
}

async function resolveReferences(
  value: unknown,
  load: ObjectLoader,
  cache: Map<string, unknown>,
): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map((item) => resolveReferences(item, load, cache)))
  if (!isObject(value)) return value
  if (typeof value.$ref === 'string') {
    const target = await loadCached(value.$ref, load, cache)
    if (target !== undefined && target !== null) return resolveReferences(target, load, cache)
  }
  const entries = await Promise.all(
    Object.entries(value).map(async ([key, item]) => [key, await resolveReferences(item, load, cache)] as const),
  )
  return Object.fromEntries(entries)
}

async function readChainMessages(
  request: Record<string, unknown>,
  chain: ChainReference,
  load: ObjectLoader,
  cache: Map<string, unknown>,
): Promise<unknown[]> {
  const chunks: unknown[][] = []
  const visited = new Set<string>()
  let key = typeof chain.head === 'string' && chain.head ? chain.head : null
  while (key) {
    if (visited.has(key)) throw new Error(`[proxy-capture] chain cycle at ${key}`)
    visited.add(key)
    const node = await loadCached(key, load, cache)
    if (!isObject(node) || !Array.isArray(node.append)) {
      throw new Error(`[proxy-capture] chain node ${key} is missing or malformed`)
    }
    chunks.unshift(node.append as unknown[])
    key = typeof node.parent === 'string' && node.parent ? node.parent : null
  }
  const tail = Array.isArray(chain.tail) ? chain.tail : []
  return [...chunks.flat(), ...tail]
}

/**
 * Rebuilds the request a v1 or v2 record was written from, resolving `$ref`
 * blob references. Pass a capture record (anything with a `request` object) or
 * a bare request. `$media` placeholders are left in place: the training export
 * lists them and copies the media files separately.
 */
export async function reconstructRequest(
  record: unknown,
  load: ObjectLoader,
  cache: Map<string, unknown> = new Map(),
): Promise<unknown> {
  const request = isObject(record) && isObject((record as Record<string, unknown>).request)
    ? (record as Record<string, unknown>).request as Record<string, unknown>
    : record
  if (!isObject(request)) return request

  const chain = isObject(request.chain) ? request.chain as ChainReference : null
  let rebuilt: Record<string, unknown> = request
  if (chain) {
    const rest = Object.fromEntries(Object.entries(request).filter(([key]) => key !== 'chain'))
    const listKey = typeof chain.list === 'string' && chain.list ? chain.list : 'messages'
    rebuilt = { ...rest, [listKey]: await readChainMessages(request, chain, load, cache) }
  }
  return resolveReferences(rebuilt, load, cache)
}
