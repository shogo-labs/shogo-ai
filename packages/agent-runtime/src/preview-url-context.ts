// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Preview-URL system-prompt context (pure, unit-testable).
 *
 * Extracted from gateway.ts so the two decisions that produced the Subliminal
 * "shared a localhost URL from a cloud pod" regression can be tested in
 * isolation:
 *
 *   1. WHEN to inject the preview-URL block (`shouldInjectPreviewUrl`). The
 *      regression: the block was only injected in `canvas` mode, so in normal
 *      `app`/build mode the agent had no public URL and fell back to localhost.
 *
 *   2. WHAT the block says (`buildPreviewUrlBlock`). Given a public URL it must
 *      present that as the user-facing address — never localhost.
 */

export type PreviewActiveMode = 'canvas' | 'app' | 'plan' | 'none' | string

/**
 * Whether the preview-URL block should be injected for a given visual mode.
 *
 * The app preview exists whenever the runtime is serving a built app, which is
 * independent of the *visual* mode — so the URL must be available in every mode
 * where the user could ask for a link (canvas AND app/build/chat), not just
 * canvas.
 */
export function shouldInjectPreviewUrl(_activeMode: PreviewActiveMode): boolean {
  // The running app is reachable regardless of the *visual* mode, and the user
  // can ask "give me a link" in any mode. `buildPreviewUrlBlock` already returns
  // null when there is nothing to serve, so injecting in every mode is safe and
  // closes the "shared a localhost URL from a cloud pod" gap (previously gated
  // to canvas only).
  return true
}

export interface PreviewUrlBlockOptions {
  /** PUBLIC_PREVIEW_URL — the authoritative URL the user/browser sees, if set. */
  publicUrl?: string | null
  /** The runtime's own port (process.env.PORT), used for the internal fallback. */
  runtimePort: number
  /** Whether a built dist/index.html exists (the runtime is self-serving the app). */
  hasDist: boolean
  /**
   * Whether the runtime is running locally (a developer's machine) rather than
   * in a cloud pod. When local, the `localhost` address IS the URL the user
   * opens, so it is presented as the user-facing link. In cloud it is NEVER
   * presented as the user-facing link (the user cannot reach it) — only as the
   * clearly-labeled internal curl address. Defaults to `true` so non-cloud
   * callers keep the local behaviour; the gateway always passes the real value.
   */
  isLocal?: boolean
}

const QA_GUIDANCE =
  'When the user asks you to QA / test / try the app, spawn the **browser_qa** subagent and pass this URL as the target. This block is the single source of truth for the preview URL — do not read it from `vite.config.ts`, `package.json`, or any other file; those values are overridden by the launcher.'

/**
 * Build the "Running App Preview" block, or null when there's no URL to share.
 *
 * This block is what the agent's system prompt hands it as the preview URL, so
 * it is the *root cause* fix for "shared a localhost URL from a cloud pod":
 *
 *   - In cloud (a public URL exists, OR `isLocal` is false) the public preview
 *     URL is the ONLY user-facing link. `localhost` appears at most as the
 *     clearly-labeled internal curl address — never as the link to hand out.
 *   - Locally (`isLocal` true, no public URL) `localhost` IS the URL the user
 *     opens, so it is presented as the user-facing link — correct there.
 */
export function buildPreviewUrlBlock(opts: PreviewUrlBlockOptions): string | null {
  const publicUrl = (opts.publicUrl ?? '').trim()
  const internalUrl = `http://localhost:${opts.runtimePort}/`
  const isLocal = opts.isLocal ?? true

  if (publicUrl.length === 0 && !opts.hasDist) return null

  const hasDistinctPublic = publicUrl.length > 0 && publicUrl !== internalUrl
  const lines: string[] = ['## Running App Preview', '']

  // A distinct public URL exists (the normal cloud case): it is the link.
  if (hasDistinctPublic) {
    lines.push(
      `The user's app is running and reachable at **${publicUrl}**.`,
      `Internal (from inside this runtime, for your own curl checks only): \`${internalUrl}\`.`,
      '',
      QA_GUIDANCE,
    )
    return lines.join('\n')
  }

  // publicUrl === internalUrl: only happens locally, where a local dev server
  // advertised its own localhost port as PUBLIC_PREVIEW_URL. It IS the user's
  // URL, so present it as the link.
  if (publicUrl.length > 0) {
    lines.push(`The user's app is running and reachable at **${publicUrl}**.`, '', QA_GUIDANCE)
    return lines.join('\n')
  }

  // No public URL.
  if (isLocal) {
    // Local dev: localhost is the real URL the user opens.
    lines.push(`The user's app is running and reachable at **${internalUrl}**.`, '', QA_GUIDANCE)
    return lines.join('\n')
  }

  // Cloud with no public URL (an env miss): NEVER present localhost as the
  // link — the user cannot open it. Give only the labeled internal address and
  // point at Publish for a shareable link.
  lines.push(
    'The app is running inside this cloud runtime, but no public preview URL is currently available.',
    `Internal address (for your own curl checks only — the user CANNOT open this): \`${internalUrl}\`.`,
    'Do NOT give the user a localhost / 127.0.0.1 / bare-port URL — it will not load for them. If they need a shareable link, use the **publish** tool.',
    '',
    QA_GUIDANCE,
  )
  return lines.join('\n')
}
