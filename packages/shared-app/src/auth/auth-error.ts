// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * What a failed email auth request actually was, and whether it is our fault.
 *
 * Better Auth's client rejects with the server's JSON body spread over the
 * fetch error, so an expected rejection and a broken server look identical to
 * a caller that only reads `message`: "wrong password" (401), "blocked
 * sign-up domain" (422) and "database is down" (500) all arrive the same way.
 * SHO-414 then reported every one of them to Sentry, filling the issue stream
 * with sign-ups the API had correctly refused.
 *
 * So the facts are kept on the error (`status`, `code`) and the reporting
 * decision is made here, once, instead of in each host's `onAuthError`.
 */

/** Email is not verified yet — a flow the UI drives, not a fault. */
export class EmailNotVerifiedError extends Error {
  /** The status the API answered with. Never reportable. */
  readonly status = 403

  constructor(message = 'Email is not verified') {
    super(message)
    this.name = 'EmailNotVerifiedError'
  }
}

/** A rejected auth request, with the facts the server gave us kept intact. */
export class AuthRequestError extends Error {
  /** HTTP status, when the request reached the server at all. */
  readonly status?: number
  /** The API's machine-readable code, e.g. `SIGNUP_BLOCKED`. */
  readonly code?: string

  constructor(message: string, options: { status?: number; code?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'AuthRequestError'
    this.status = options.status
    this.code = options.code
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value) return value
  }
  return undefined
}

/**
 * Wrap a Better Auth client error without losing what it told us. `message`
 * comes out unchanged, so every screen that shows `e.message` looks the same
 * as before.
 */
export function toAuthRequestError(err: unknown, fallbackMessage: string): AuthRequestError {
  const e = (err ?? {}) as {
    message?: unknown
    status?: unknown
    code?: unknown
    /** Better Fetch keeps the parsed body here; Better Auth also spreads it. */
    error?: { code?: unknown } | null
    body?: { code?: unknown } | null
  }
  return new AuthRequestError(
    firstString(e.message) ?? fallbackMessage,
    {
      status: typeof e.status === 'number' ? e.status : undefined,
      code: firstString(e.code, e.error?.code, e.body?.code),
      cause: err,
    },
  )
}

/**
 * Report only real faults.
 *
 * An expected rejection — blocked sign-up domain (422 `SIGNUP_BLOCKED`), wrong
 * password (401), account already exists (422), validation (400), rate limit
 * (429) — is the API working as designed: the user is shown the message and
 * Sentry has nothing to fix. A failure with no status at all (network down,
 * a thrown exception) or a 5xx is ours, and is worth an issue.
 */
export function shouldReportAuthError(error: unknown): boolean {
  const status = (error as { status?: unknown } | null | undefined)?.status
  if (typeof status !== 'number') return true
  return status >= 500
}
