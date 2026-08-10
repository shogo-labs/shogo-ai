// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Conditional (compare-and-swap) object writes, signed with AWS Signature
 * Version 4.
 *
 * Why this exists at all: the durable-backup guards need "write this object
 * ONLY if it is still the one I read". Doing that as HEAD-then-PUT is a
 * time-of-check/time-of-use race — two writers can both read ETag `E`, both
 * decide they are safe, and the loser silently destroys the winner's data. No
 * amount of care in the decision function closes that window, because the
 * decision and the write are not atomic.
 *
 * The storage layer offers the real primitive. S3 supports conditional writes
 * (`If-Match` for compare-and-swap, `If-None-Match: *` for create-only,
 * answering `412 Precondition Failed` when the condition does not hold), and
 * OCI Object Storage — where this actually runs — supports the same headers on
 * PutObject natively, with an S3 Compatibility API that is congruent with it.
 *
 * Why it is hand-rolled rather than using an SDK: Bun's built-in `S3Client`
 * cannot send conditional headers and offers no escape hatch for custom ones
 * (oven-sh/bun#17339, #16048), and the metal-agent deploy bundle ships `src/`
 * with NO `node_modules` — every host runs this straight from source, so a
 * dependency on `@aws-sdk/client-s3` would simply fail to resolve. That leaves
 * signing the request here, against Bun and node builtins only.
 *
 * The signing implementation is verified against botocore's signer in
 * `s3-conditional.test.ts`, so it is checked byte-for-byte rather than trusted.
 *
 * @see https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html
 * @see https://docs.oracle.com/en-us/iaas/Content/Object/Tasks/s3compatibleapi.htm
 */

import { createHash, createHmac } from 'node:crypto'

/** Everything needed to address and sign against a bucket. */
export interface S3Target {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
}

/**
 * Precondition for a write. Exactly one applies:
 *   { ifMatch: etag } — succeed only if the object is still exactly that one.
 *   { ifNoneMatch: '*' } — succeed only if the object does not exist.
 *   {} — unconditional (only for callers that have no invariant to protect).
 */
export interface WritePrecondition {
  ifMatch?: string | null
  ifNoneMatch?: '*' | null
}

/**
 * Outcome of a conditional write.
 *   ok                  — the write landed; `etag` identifies what we wrote.
 *   precondition-failed — the object was not what we required (HTTP 412). The
 *                         stored object is UNTOUCHED. This is the safe, normal
 *                         outcome of losing a race, not an error.
 *   conflict            — concurrent delete during the write (HTTP 409); the
 *                         caller may retry after re-reading.
 */
export type ConditionalPutResult =
  | { status: 'ok'; etag: string | null }
  | { status: 'precondition-failed' }
  | { status: 'conflict' }

const ALGORITHM = 'AWS4-HMAC-SHA256'
const SERVICE = 's3'

function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

/**
 * Percent-encode one path segment per SigV4's rules: unreserved characters
 * pass through, everything else is encoded, and `encodeURIComponent`'s four
 * stragglers (`!'()*`) have to be encoded by hand.
 */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

/**
 * Path-style canonical URI: `/{bucket}/{key…}`. Path-style is what OCI's S3
 * Compatibility API addresses buckets with, and `/` between key segments stays
 * literal (S3 does not double-encode the object key).
 */
export function canonicalUriFor(bucket: string, key: string): string {
  return `/${[bucket, ...key.split('/')].map(encodeSegment).join('/')}`
}

/** `20250807T000000Z` and `20250807`, the two date forms SigV4 wants. */
export function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  return { amzDate, dateStamp: amzDate.slice(0, 8) }
}

/**
 * Build the signed headers for a PUT. Split out from the request so the
 * signature can be compared against a reference implementation in tests
 * without any network involved.
 *
 * `host` must be the exact value sent on the wire (including a non-default
 * port), or the signature will not verify.
 */
export function signPutHeaders(input: {
  target: S3Target
  key: string
  payload: Uint8Array
  contentType: string
  precondition?: WritePrecondition
  now: Date
  /** Session token for temporary credentials, if any. */
  sessionToken?: string | null
}): Record<string, string> {
  const { target, key, payload, contentType, precondition, now } = input
  const url = new URL(`${target.endpoint.replace(/\/+$/, '')}${canonicalUriFor(target.bucket, key)}`)
  const { amzDate, dateStamp } = amzDates(now)
  const payloadHash = sha256Hex(payload)

  const headers: Record<string, string> = {
    host: url.host,
    'content-length': String(payload.byteLength),
    'content-type': contentType,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  }
  if (input.sessionToken) headers['x-amz-security-token'] = input.sessionToken
  if (precondition?.ifMatch) headers['if-match'] = precondition.ifMatch
  if (precondition?.ifNoneMatch) headers['if-none-match'] = precondition.ifNoneMatch

  const sortedNames = Object.keys(headers).sort()
  const canonicalHeaders = sortedNames.map((n) => `${n}:${headers[n]!.trim()}\n`).join('')
  const signedHeaders = sortedNames.join(';')

  const canonicalRequest = [
    'PUT',
    url.pathname,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  const scope = `${dateStamp}/${target.region}/${SERVICE}/aws4_request`
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n')

  const signature = hmac(
    hmac(
      hmac(hmac(hmac(`AWS4${target.secretAccessKey}`, dateStamp), target.region), SERVICE),
      'aws4_request',
    ),
    stringToSign,
  ).toString('hex')

  headers.authorization =
    `${ALGORITHM} Credential=${target.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`
  return headers
}

/** The URL a conditional PUT is sent to. Exported for tests and logging. */
export function objectUrl(target: S3Target, key: string): string {
  return `${target.endpoint.replace(/\/+$/, '')}${canonicalUriFor(target.bucket, key)}`
}

/**
 * PUT an object, honouring `precondition`. A failed precondition is returned,
 * not thrown: losing a compare-and-swap is an expected outcome the guards act
 * on. Anything else (auth, transport, 5xx) throws, so it cannot be mistaken
 * for a clean refusal.
 */
export async function conditionalPutObject(input: {
  target: S3Target
  key: string
  body: Uint8Array
  contentType?: string
  precondition?: WritePrecondition
  timeoutMs?: number
  /** Injectable for tests. */
  fetchImpl?: typeof fetch
  now?: Date
}): Promise<ConditionalPutResult> {
  const contentType = input.contentType ?? 'application/octet-stream'
  const doFetch = input.fetchImpl ?? fetch
  const headers = signPutHeaders({
    target: input.target,
    key: input.key,
    payload: input.body,
    contentType,
    precondition: input.precondition,
    now: input.now ?? new Date(),
  })

  const res = await doFetch(objectUrl(input.target, input.key), {
    method: 'PUT',
    headers,
    body: input.body,
    ...(input.timeoutMs ? { signal: AbortSignal.timeout(input.timeoutMs) } : {}),
  })

  if (res.status === 412) return { status: 'precondition-failed' }
  if (res.status === 409) return { status: 'conflict' }
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`PUT ${input.key} failed (${res.status}): ${detail.slice(0, 300)}`)
  }
  return { status: 'ok', etag: res.headers.get('etag') }
}
