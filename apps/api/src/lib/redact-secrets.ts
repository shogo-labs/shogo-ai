// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Credential redaction used by agent work logs, the abuse judge, the digest
 * collector, and any other surface that must not store or forward secrets.
 *
 * SHO-459: moved out of services/agent-work-log.ts so the abuse-check job
 * can import it without pulling in the whole work-log module. agent-work-log
 * re-exports `redactSecrets` from here for backward compatibility.
 */

/** Patterns that match common bearer credentials. Order is significant: more
 *  specific prefixes (shogo_sk_, sk-ant-) must come before the generic sk-. */
const SECRET_PATTERNS: RegExp[] = [
  /shogo_sk_[A-Za-z0-9]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  // Anthropic keys first (sk-ant-…) then generic OpenAI-shape sk-…
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk_live_[A-Za-z0-9]{16,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
]

/** Mask anything that looks like a credential. */
export function redactSecrets(value: string): string {
  let out = value
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]')
  out = out.replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')
  out = out.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g, '$1 [redacted]')
  out = out.replace(
    /((?:api[_-]?key|token|secret|password|passwd|authorization)["']?\s*[=:]\s*["']?)[^\s"',;&]{6,}/gi,
    '$1[redacted]',
  )
  return out
}
