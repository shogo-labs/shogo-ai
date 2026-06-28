// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Localhost -> public-preview link rewriting (pure, unit-testable).
 *
 * Defense-in-depth for "shared a localhost URL from a cloud pod": even after
 * the system prompt is fixed (see preview-url-context.ts), the model can still
 * free-type a `http://localhost:PORT/...` URL into its answer. In cloud the
 * user cannot open that, so we rewrite any *user-facing* localhost link to the
 * deterministic public preview URL (`PUBLIC_PREVIEW_URL`).
 *
 * Crucially, the agent legitimately writes `localhost` for its OWN `curl`
 * checks (the prompt even tells it to). Rewriting those would corrupt accurate
 * internal references, so the scanner NEVER rewrites:
 *   - text inside inline code (`...`) or fenced code blocks (```...```), tracked
 *     by backtick parity, and
 *   - any line that contains a `curl` invocation.
 *
 * The same {@link Scanner} backs both the post-turn whole-text rewrite
 * (`rewriteLocalhostLinks`) and the streaming wrapper (`LocalhostLinkRewriter`)
 * so the live UI stream and the persisted/returned text stay consistent.
 */

// Sticky (`y`) so we can test for a match anchored exactly at a given index.
// The host alternation is required, so the smallest possible match is the bare
// host token (`localhost` / `127.0.0.1` / `0.0.0.0`); the scheme, port and path
// are optional. The path stops at whitespace, `)` and `]` so markdown links and
// parentheticals are preserved.
const LOCALHOST_TOKEN =
  /(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(\/[^\s)\]]*)?/y

// Only attempt the (relatively expensive) sticky match when the current char
// could begin a localhost token: h(ttp), l(ocalhost), 1(27.x), 0(.0.0.0).
const URL_START_CHARS = new Set(['h', 'l', '1', '0'])

function normalizeOrigin(publicUrl?: string | null): string {
  return (publicUrl ?? '').trim().replace(/\/+$/, '')
}

/**
 * Stateful scanner that rewrites localhost links to `origin`, skipping code
 * spans/fences and `curl` lines. State (code parity, current line) persists
 * across `process()` calls so it can drive the streaming rewriter; feed text
 * strictly in order.
 */
class Scanner {
  /** Inside inline/fenced code — toggled by every backtick (parity). */
  inCode = false
  private line = ''
  private lineHasCurl = false

  constructor(private readonly origin: string) {}

  process(s: string): string {
    let out = ''
    let i = 0
    while (i < s.length) {
      const ch = s[i]

      if (ch === '\n') {
        out += ch
        this.line = ''
        this.lineHasCurl = false
        i++
        continue
      }

      // Any backtick flips code state. A triple-backtick fence has odd parity
      // for its content region, so a single `inCode` flag covers inline AND
      // fenced code without separate fence bookkeeping.
      if (ch === '`') {
        out += ch
        this.inCode = !this.inCode
        this.line += ch
        i++
        continue
      }

      if (!this.inCode && !this.lineHasCurl && URL_START_CHARS.has(ch.toLowerCase())) {
        LOCALHOST_TOKEN.lastIndex = i
        const m = LOCALHOST_TOKEN.exec(s)
        if (m && m.index === i && m[0].length > 0) {
          const path = m[1] ?? ''
          out += this.origin + path
          this.line += m[0]
          i += m[0].length
          continue
        }
      }

      out += ch
      this.line += ch
      // Detect a `curl` on this line so we leave its (internal) localhost
      // reference untouched. Cheap-gated on the trailing 'l'.
      if (!this.lineHasCurl && (ch === 'l' || ch === 'L') && /\bcurl\b/i.test(this.line)) {
        this.lineHasCurl = true
      }
      i++
    }
    return out
  }
}

/**
 * Rewrite any user-facing localhost link in `text` to `publicUrl`'s origin
 * (preserving the path/query). No-op when `publicUrl` is empty (local dev) or
 * `text` is empty. Code spans/fences and `curl` lines are left untouched.
 */
export function rewriteLocalhostLinks(text: string, publicUrl?: string | null): string {
  const origin = normalizeOrigin(publicUrl)
  if (!origin || !text) return text
  return new Scanner(origin).process(text)
}

/**
 * Streaming wrapper around {@link Scanner}. `push(delta)` returns the rewritten
 * text safe to forward, holding back the trailing partial token (everything
 * after the last whitespace) so a localhost URL split across deltas is never
 * emitted half-rewritten; `flush()` drains the held tail. When `publicUrl` is
 * empty the wrapper is a pass-through (local dev), so live streaming is
 * unaffected.
 */
export class LocalhostLinkRewriter {
  private readonly scanner: Scanner | null
  private buffer = ''

  constructor(publicUrl?: string | null) {
    const origin = normalizeOrigin(publicUrl)
    this.scanner = origin ? new Scanner(origin) : null
  }

  /** Whether rewriting is active (a public URL was provided). */
  get active(): boolean {
    return this.scanner !== null
  }

  push(delta: string): string {
    if (!this.scanner) return delta
    this.buffer += delta

    let cut = -1
    for (let k = this.buffer.length - 1; k >= 0; k--) {
      const c = this.buffer[k]
      if (c === ' ' || c === '\n' || c === '\t' || c === '\r') {
        cut = k
        break
      }
    }
    if (cut < 0) return '' // whole buffer may be part of a URL — hold it

    const emittable = this.buffer.slice(0, cut + 1)
    this.buffer = this.buffer.slice(cut + 1)
    return this.scanner.process(emittable)
  }

  flush(): string {
    if (!this.scanner) {
      const rest = this.buffer
      this.buffer = ''
      return rest
    }
    const out = this.scanner.process(this.buffer)
    this.buffer = ''
    return out
  }
}
