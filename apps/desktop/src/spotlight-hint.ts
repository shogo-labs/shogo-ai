// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The one-time Spotlight hint (SHO-152).
 *
 * `spotlight-exclusion.ts` normally stops Spotlight indexing Shogo's
 * workspaces by renaming the directory to `workspaces.noindex`. When it can't
 * (both dirs already exist, the dir is a foreign symlink, the rename failed)
 * the user still has >1 core of `mds_stores` and nothing in the app says why.
 * This dialog explains it once and offers the only fix that is left — adding
 * the folder to the Spotlight privacy list, which macOS only exposes in System
 * Settings.
 *
 * Pure on purpose: the Electron dialog and `shell.openExternal` are injected so
 * the "show once, remember the dismissal, open the right pane" contract is
 * testable without Electron (`src/__tests__/spotlight-hint.test.ts`).
 */
import type { SpotlightBlockedReason } from './spotlight-exclusion'

/** Deep link to System Settings → Spotlight (macOS 13+ extension URL). */
export const SPOTLIGHT_SETTINGS_URL = 'x-apple.systempreferences:com.apple.Spotlight-Settings.extension'

export const SPOTLIGHT_HINT_OPEN_SETTINGS = 'Open Spotlight Settings'
export const SPOTLIGHT_HINT_NOT_NOW = 'Not Now'

export interface SpotlightHintDeps {
  /** True when the user already dismissed this hint (persisted in desktop config). */
  isDismissed: () => boolean
  /** Persist the dismissal so the hint never shows again. */
  rememberDismissed: () => void
  openSettings: () => void
  /** Resolve with the index of the button the user pressed. */
  ask: (options: { message: string; detail: string; buttons: string[] }) => Promise<number>
}

export type SpotlightHintOutcome = 'skipped' | 'opened-settings' | 'dismissed'

export interface SpotlightHintContext {
  /** The folder we use for workspaces — the one Spotlight keeps indexing. */
  workspacesDir: string
  /** Why it could not be excluded; drives the explanation line. */
  blocked: SpotlightBlockedReason | null
  /** Raw detail from the migration (`EPERM: …`, the leftover dir, the link target). */
  detail?: string
}

/** One sentence on why the folder is still indexed, in plain language. */
export function spotlightHintReason(context: SpotlightHintContext): string {
  switch (context.blocked) {
    case 'both-exist':
      return (
        `The folder exists twice on disk (${context.detail ?? 'workspaces and workspaces.noindex'}), ` +
        `so Shogo could not rename it and left both in place.`
      )
    case 'foreign-symlink':
      return (
        `The workspaces folder is a symlink Shogo did not create ` +
        `(${context.detail ?? 'unknown target'}), so Shogo left it alone.`
      )
    case 'rename-failed':
      return `Moving the folder failed (${context.detail ?? 'unknown error'}).`
    default:
      return 'Shogo could not move the folder out of Spotlight’s reach.'
  }
}

export function spotlightHintDetail(context: SpotlightHintContext): string {
  return (
    `macOS is indexing Shogo's project files, including every node_modules, ` +
    `and re-indexes them after each install or build.\n\n` +
    `${spotlightHintReason(context)}\n\n` +
    `Add\n${context.workspacesDir}\n` +
    `to the Spotlight privacy list to stop the indexing. Shogo's project ` +
    `switcher, terminals and IDE are unaffected either way.`
  )
}

/**
 * Show the hint at most once per install. Any answer counts as dismissal, so
 * nobody is nagged twice.
 */
export async function runSpotlightHint(
  context: SpotlightHintContext,
  deps: SpotlightHintDeps,
): Promise<SpotlightHintOutcome> {
  if (deps.isDismissed()) return 'skipped'

  let choice = -1
  try {
    choice = await deps.ask({
      message: "Spotlight is indexing Shogo's workspaces, which uses a lot of CPU",
      detail: spotlightHintDetail(context),
      buttons: [SPOTLIGHT_HINT_OPEN_SETTINGS, SPOTLIGHT_HINT_NOT_NOW],
    })
  } catch {
    // No display (headless / e2e host). Don't remember a dismissal the user
    // never saw — the hint can still be shown on a real launch.
    return 'skipped'
  }

  deps.rememberDismissed()
  if (choice === 0) {
    try {
      deps.openSettings()
    } catch {
      // Settings simply didn't open; the dismissal already stuck.
    }
    return 'opened-settings'
  }
  return 'dismissed'
}
