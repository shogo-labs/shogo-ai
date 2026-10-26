// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The one reader for a provider resource id.
 *
 * Zernio is Mongo-backed: every resource it returns carries `_id`, and it is
 * usually wrapped in a named envelope — `{ profile: { _id } }`,
 * `{ accounts: [{ _id }] }`, `{ post: { _id } }`. A `.id` read therefore finds
 * nothing on a real response while every mock in this repo answered `{ id }`,
 * which is how a connect could die at profile resolution with CI green.
 *
 * Callers pass the wrappers they might receive, most specific first; the bare
 * `_id`/`id` on the payload itself is the last resort. Legacy `{ id }` shapes
 * still read, because tests and older relayed bodies use them.
 */
export function zernioId(payload: any, ...wrappers: string[]): string | null {
  for (const wrapper of wrappers) {
    if (!wrapper) continue
    const nested = payload?.[wrapper]
    if (typeof nested === 'string' && nested) return nested
    const nestedId = nested?._id ?? nested?.id
    if (typeof nestedId === 'string' && nestedId) return nestedId
  }
  const own = payload?._id ?? payload?.id
  return typeof own === 'string' && own ? own : null
}

/**
 * A provider profile reference, which arrives populated (`{ _id }`) or as a
 * plain id string depending on the endpoint.
 */
export function zernioRefId(value: any): string | null {
  if (typeof value === 'string') return value || null
  return zernioId(value)
}
