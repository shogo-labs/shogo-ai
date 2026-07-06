// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Thin wrapper over the SDK-generated CRUD API for this site's two runtime
// models. The generated routes return:
//   POST /api/<plural>        -> 201 { ok: true, data }   (create)
//   GET  /api/<plural>        -> 200 { ok: true, items, total }
// and on failure { error: { code, message } } with a 4xx/5xx status.
//
// We ALWAYS surface `body.error?.message` to the caller instead of a generic
// "something went wrong" — stranded users with no error text is a top pain
// point on the platform.

export interface ReservationInput {
  name: string
  email?: string
  phone?: string
  partySize: number
  date: string
  time: string
  notes?: string
}

export interface ContactInput {
  name: string
  email: string
  phone?: string
  subject?: string
  message: string
}

async function postJson<T>(path: string, payload: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch {
    throw new Error('Could not reach the server. Check your connection and try again.')
  }

  const body = await res.json().catch(() => ({}) as Record<string, unknown>)
  if (!res.ok || (body as { ok?: boolean }).ok === false) {
    const message =
      (body as { error?: { message?: string } }).error?.message ?? `Request failed (HTTP ${res.status})`
    throw new Error(message)
  }
  return (body as { data: T }).data
}

export function createReservation(input: ReservationInput) {
  return postJson<{ id: string }>('/api/reservations', input)
}

export function createContactMessage(input: ContactInput) {
  return postJson<{ id: string }>('/api/contact-messages', input)
}
