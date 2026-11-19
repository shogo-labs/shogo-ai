// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * How much memory a transcript is holding (SHO-434).
 *
 * Every cap on cached chat history used to count *messages*, which stopped
 * meaning anything once a message could carry an image as an inline base64 URL:
 * fifty messages is a few hundred KB in a text chat and twenty megabytes in a
 * photo-heavy one. A budget in bytes is what actually bounds the heap, so both
 * the in-memory session cache and the device store trim against this.
 *
 * Deliberately not `JSON.stringify(...).length`: this runs on every render
 * while a reply streams, and serialising a transcript that holds a 5 MB image
 * part would allocate another 5 MB just to measure it. Walking the structure
 * sums the same lengths (UTF-16 code units, which is exact for the base64 and
 * ASCII that dominate) without building a string.
 *
 * Pure and dependency-free, so it is unit-testable and safe to import from the
 * auth bootstrap.
 */

export function estimateBytes(value: unknown, depth = 0): number {
  if (value === null || value === undefined) return 0
  switch (typeof value) {
    case 'string':
      return value.length
    case 'number':
    case 'boolean':
      return 8
    case 'object':
      break
    default:
      return 0
  }
  // Tool payloads nest, but not deeply; past this a message is not worth the
  // walk to measure exactly.
  if (depth > 8) return 64
  if (Array.isArray(value)) {
    let total = 0
    for (const item of value) total += estimateBytes(item, depth + 1)
    return total
  }
  if (value instanceof Date) return 8
  if (ArrayBuffer.isView(value)) return (value as ArrayBufferView).byteLength
  let total = 0
  for (const key of Object.keys(value as Record<string, unknown>)) {
    total += key.length + estimateBytes((value as Record<string, unknown>)[key], depth + 1)
  }
  return total
}

/**
 * A message object is stable between renders (the arrays around it are not),
 * so its size is measured once and reused. A streaming reply is a new object on
 * every token, which keeps the map churning — but weakly, so those entries are
 * collected with the objects themselves.
 */
const messageBytes = new WeakMap<object, number>()

export function messageBytesOf(message: unknown): number {
  if (!message || typeof message !== 'object') return estimateBytes(message)
  const known = messageBytes.get(message as object)
  if (known !== undefined) return known
  const bytes = estimateBytes(message)
  messageBytes.set(message as object, bytes)
  return bytes
}

export function transcriptBytes(messages: readonly unknown[]): number {
  let total = 0
  for (const message of messages) total += messageBytesOf(message)
  return total
}
