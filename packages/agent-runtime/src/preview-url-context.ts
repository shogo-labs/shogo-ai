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
}

/**
 * Build the "Running App Preview" block, or null when there's no URL to share.
 *
 * Priority: a distinct PUBLIC_PREVIEW_URL is always the user-facing address;
 * localhost is only ever shown as the *internal* address, never as the link to
 * hand the user.
 */
export function buildPreviewUrlBlock(opts: PreviewUrlBlockOptions): string | null {
  const publicUrl = (opts.publicUrl ?? '').trim()
  const internalUrl = `http://localhost:${opts.runtimePort}/`

  if (publicUrl.length === 0 && !opts.hasDist) return null

  const externalUrl = publicUrl.length > 0 ? publicUrl : internalUrl
  const hasDistinctPublic = publicUrl.length > 0 && publicUrl !== internalUrl

  const lines: string[] = [
    '## Running App Preview',
    '',
    `The user's app is running and reachable at **${externalUrl}**.`,
  ]
  if (hasDistinctPublic) {
    lines.push(`Internal (from inside this runtime): \`${internalUrl}\`.`)
  }
  lines.push(
    '',
    'When the user asks you to QA / test / try the app, spawn the **browser_qa** subagent and pass this URL as the target. This block is the single source of truth for the preview URL — do not read it from `vite.config.ts`, `package.json`, or any other file; those values are overridden by the launcher.',
  )
  return lines.join('\n')
}
