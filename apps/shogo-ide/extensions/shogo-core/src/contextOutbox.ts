import type { IdeChatReference } from './protocol'

/** Same cap as the chat composer's MAX_SELECTION_CHARS. */
export const MAX_CONTEXT_TEXT_LENGTH = 24_000

export function truncateText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_CONTEXT_TEXT_LENGTH) return { text, truncated: false }
  return { text: text.slice(0, MAX_CONTEXT_TEXT_LENGTH), truncated: true }
}

export interface ReferenceBatch {
  batchId: string
  references: IdeChatReference[]
}

/** Oldest batches are dropped beyond this many unacknowledged ones. */
export const MAX_PENDING_BATCHES = 50
/** A batch the chat never acknowledges (e.g. an older chat build) stops being re-sent after this. */
export const PENDING_BATCH_TTL_MS = 10 * 60_000

let batchCounter = 0
const newBatchId = () => `batch-${Date.now().toString(36)}-${(batchCounter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/**
 * References waiting to reach the Shogo chat composer. A batch stays here
 * until the chat iframe acknowledges it (`shogo.ide.referencesAck`), so items
 * added before the chat view first loads — or while it is reloading — are
 * re-sent on the next `ready` and delivered once (the chat dedupes by
 * `batchId`).
 */
export class ShogoContextOutbox {
  private batches: Array<ReferenceBatch & { enqueuedAt: number }> = []

  constructor(private readonly now: () => number = Date.now) {}

  enqueue(references: IdeChatReference[]): string {
    const batchId = newBatchId()
    this.batches.push({ batchId, references, enqueuedAt: this.now() })
    if (this.batches.length > MAX_PENDING_BATCHES) this.batches.splice(0, this.batches.length - MAX_PENDING_BATCHES)
    return batchId
  }

  pending(): ReferenceBatch[] {
    const cutoff = this.now() - PENDING_BATCH_TTL_MS
    this.batches = this.batches.filter((b) => b.enqueuedAt > cutoff)
    return this.batches.map((b) => ({ batchId: b.batchId, references: [...b.references] }))
  }

  ack(batchId: string): boolean {
    const before = this.batches.length
    this.batches = this.batches.filter((b) => b.batchId !== batchId)
    return this.batches.length !== before
  }

  clear(): void {
    this.batches = []
  }
}
