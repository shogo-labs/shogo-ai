import { createHash } from 'node:crypto'

const CHAIN_SEED = 'shogo-chain-v2\0'

export interface ChainNodeBody {
  parent: string | null
  append: unknown[]
}

export interface ChainPlan {
  head: string | null
  tail: unknown[]
  writes: Array<{ key: string; body: ChainNodeBody }>
}

export type ChainWriter = (key: string, body: ChainNodeBody) => Promise<void>

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

// Boundaries are content-defined, so a node only ever grows by appending and
// two pods can never disagree about where a boundary falls.
function chunkSize(): number {
  const size = Math.floor(Number(process.env.PROXY_CAPTURE_CHAIN_CHUNK || 2))
  return Number.isFinite(size) && size >= 1 ? size : 2
}

export function chainNodeKey(workspaceId: string, prefix: string): string {
  return `v2/chain/${workspaceId}/${prefix}.json.gz`
}

export function buildChain(workspaceId: string, messages: unknown[]): ChainPlan {
  const writes: ChainPlan['writes'] = []
  // The workspace is part of the seed, so identical conversations in two
  // workspaces can never address the same node.
  let prefix = sha256(`${CHAIN_SEED}${workspaceId}`)
  let lastBoundary = -1
  let parent: string | null = null
  for (let index = 0; index < messages.length; index += 1) {
    prefix = sha256(prefix + sha256(stableStringify(messages[index])))
    if (parseInt(prefix.slice(0, 8), 16) % chunkSize() !== 0) continue
    const key = chainNodeKey(workspaceId, prefix)
    writes.push({ key, body: { parent, append: messages.slice(lastBoundary + 1, index + 1) } })
    parent = key
    lastBoundary = index
  }
  return { head: parent, tail: messages.slice(lastBoundary + 1), writes }
}

// Replaces the message list with the newest node key plus the messages that
// follow it. The tail stays inline, so a record never depends on a node that
// this same request did not just write.
export function chainRequest(
  request: Record<string, unknown>,
  workspaceId: string,
  writeNode: ChainWriter,
): { request: Record<string, unknown>; writes: Promise<void>[] } {
  if (request.chain) return { request, writes: [] }
  for (const listKey of ['messages', 'input'] as const) {
    const list = request[listKey]
    if (!Array.isArray(list) || list.length === 0) continue
    const chain = buildChain(workspaceId, list)
    if (!chain.head) return { request, writes: [] }
    const writes = chain.writes.map((node) => writeNode(node.key, node.body))
    const rest = Object.fromEntries(Object.entries(request).filter(([key]) => key !== listKey))
    return {
      request: { ...rest, chain: { head: chain.head, tail: chain.tail, list: listKey } },
      writes,
    }
  }
  return { request, writes: [] }
}
