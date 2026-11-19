// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Why a refused send has to be recorded instead of caught (SHO-431).
 *
 * `Chat.sendMessage` — the one `useChat` hands back — runs every transport
 * failure through `AbstractChat.makeRequest`'s `catch`: it reports the error to
 * `onError`, sets the status to `"error"`, and resolves. The promise a send
 * awaits therefore settles successfully whether the turn streamed or the API
 * refused the session, so a `try { await sendMessage() } catch` never sees a
 * 401. That is not a detail we can paper over at the call site: the refusal has
 * to be recorded where it lands (`onError`) and read back afterwards, which is
 * what this module is for.
 */

/** A send the API refused for want of a session. */
export interface RefusedSend {
  /** `X-Client-Turn-Id` of the request that was refused. */
  clientTurnId: string | null
}

/** The refusal `onError` saw, tagged with the turn that was in flight. */
export function refusedSendFor(
  clientTurnId: string | null | undefined,
): RefusedSend {
  return { clientTurnId: clientTurnId ?? null }
}

/**
 * Whether `refusal` is about the send whose turn id this is. `onError` can
 * land after the person has moved on to the next message, so a refusal from an
 * earlier turn must not put that turn's text back into a composer someone is
 * typing in.
 */
export function refusalIsFor(
  refusal: RefusedSend | null | undefined,
  clientTurnId: string | null | undefined,
): boolean {
  if (!refusal) return false
  return refusal.clientTurnId === (clientTurnId ?? null)
}

/**
 * The transcript without the bubble a refused send left behind.
 *
 * `sendMessage` pushes the person's message into the SDK's list before the
 * request goes out, so a refused send leaves a bubble for a message no row was
 * ever written for. With the text handed back to the composer that bubble is
 * the same message twice, and it cannot survive the next history paint anyway.
 * Only a trailing user message can be that bubble.
 */
export function withoutRefusedSend<T extends { role: string }>(
  messages: T[],
): T[] {
  const last = messages[messages.length - 1]
  return last?.role === "user" ? messages.slice(0, -1) : messages
}
