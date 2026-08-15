// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared reader for Cloudflare API responses.
 *
 * Cloudflare answers with `{ success, errors, result }`, and every caller here
 * reads `env.success` on the very next line. It does not answer that way when
 * something goes wrong upstream: the custom-domain reconciler logged 1,481
 * `null is not an object (evaluating 'env.success')` TypeErrors in 48 hours in
 * production — 60% of all error-level records — because the response body was
 * the literal `null`, which `JSON.parse` happily returns. Bun throws on every
 * other malformed body (empty, whitespace, HTML error page), so `null` is the
 * one shape that slips past a bare `as CfEnvelope<T>` cast and crashes later.
 *
 * The crash was also the only signal, which made it undiagnosable: it replaced
 * the HTTP status and body we needed, and it aborted `refreshCustomDomain`
 * before it could persist a status, so those rows never reached a terminal state
 * and were re-polled indefinitely.
 *
 * Hence: parse defensively, and synthesize a failed envelope for anything that
 * isn't one, carrying the status and a body snippet. Callers keep their existing
 * `!env.success` handling and get a diagnosable warning instead of a TypeError.
 */

export interface CfEnvelope<T> {
  success: boolean
  errors: Array<{ code: number; message: string }>
  result: T | null
}

/**
 * Read a Cloudflare response as an envelope, never throwing on a malformed body.
 * `label` identifies the call in the warning (e.g. `GET /zones/x/custom_hostnames/y`).
 */
export async function readCfEnvelope<T>(
  res: Response,
  label: string,
): Promise<CfEnvelope<T>> {
  const text = await res.text()

  let parsed: unknown = null
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null
  } catch {
    parsed = null
  }

  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    typeof (parsed as CfEnvelope<T>).success !== 'boolean'
  ) {
    console.warn(
      `[cloudflare] ${label} -> HTTP ${res.status} with a non-envelope body: ` +
        `${text.slice(0, 200) || '(empty)'}`,
    )
    return {
      success: false,
      errors: [
        {
          code: res.status,
          message: `Cloudflare returned a non-envelope body (HTTP ${res.status})`,
        },
      ],
      result: null,
    }
  }

  const env = parsed as CfEnvelope<T>
  // Spread so pagination fields (result_info) survive for any future caller,
  // but guarantee the two properties callers dereference unguarded.
  return { ...env, errors: env.errors ?? [], result: env.result ?? null }
}
