// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * What the agent should do next, and what it should say.
 *
 * A native release is a five-step procedure with two steps a human has to do by
 * hand (invite the publisher account in Play Console; create the app record in
 * App Store Connect, or upload once to Play). Every one of those steps used to
 * live in a docs page and in the agent's memory, which is not a place a
 * procedure survives — the Samsara run stalled on exactly that.
 *
 * So the tool answers with one `next_action` instead of prose: the agent reads it
 * and knows the single next thing, and `user_message` is the sentence to say. The
 * mapping is a pure function of the facts, so each state is a test.
 */

export type NativeNextAction =
  | 'confirm_bundle_id'
  | 'publish_web'
  | 'connect_play'
  | 'connect_asc'
  | 'play_first_upload'
  | 'asc_app_record'
  | 'needs_icon'
  | 'building'
  | 'testing'
  | 'submitted'
  | 'test_failed'
  | 'live'

export interface NativeReleaseFacts {
  /** No bundle identifier recorded on the app yet. */
  needsBundleId: boolean
  /** The project has `server.tsx` / `custom-routes.ts` / a Prisma schema. */
  hasServerFiles: boolean
  backend: { published: boolean; url: string | null }
  connections: {
    play: { keyAvailable: boolean; publisherEmail: string | null; firstUploadDone: boolean }
    asc: { keyAvailable: boolean; appRecord: boolean }
  }
  /** An icon of the project's own, not the stack template's placeholder. */
  hasStoreIcon: boolean
  /** The bundle id / package the next action is about. */
  bundleIdentifier: string
  androidPackage: string
}

export interface NativeReleaseStatusFacts {
  status: string
  step: string | null
  testOutcome: string | null
  kind: string
  error?: string | null
}

export interface NativeNextStep {
  state: string
  next_action: NativeNextAction
  user_message: string
  links: Record<string, string>
}

const PLAY_INVITE =
  'In Google Play Console → Users and permissions, invite {email} and grant "Release apps to testing tracks" on this app (add production when you are ready to go live).'

/**
 * One next action for the whole flow.
 *
 * Pre-release checks come before any status: a release cannot be usefully
 * reported as `building` if the app has no bundle id, and the user should not be
 * asked for an icon before the account that will receive the build is connected.
 */
export function nativeNextStep(input: {
  facts: NativeReleaseFacts
  platforms: ('ios' | 'android')[]
  release?: NativeReleaseStatusFacts | null
}): NativeNextStep {
  const { facts, platforms, release } = input
  const wantsIos = platforms.includes('ios')
  const wantsAndroid = platforms.includes('android')

  if (facts.needsBundleId) {
    return {
      state: 'identifiers',
      next_action: 'confirm_bundle_id',
      user_message: `Confirm the app id before the first store upload: iOS ${facts.bundleIdentifier}, Android ${facts.androidPackage}. They are locked once a build is submitted.`,
      links: {},
    }
  }

  // A device app that calls relative `/api/...` is dead on arrival: the phone has
  // no origin. Samsara built fine and could not load a single request.
  if (facts.hasServerFiles && !facts.backend.published) {
    return {
      state: 'backend',
      next_action: 'publish_web',
      user_message:
        'This app talks to its own backend, so it needs the web version published first — that is the address the app will call. Publish it, then ship to the store.',
      links: {},
    }
  }

  if (wantsAndroid && !facts.connections.play.keyAvailable) {
    // With no publisher account configured (the live byok default) there is no
    // email to invite, and saying "invite the Shogo publisher account" is an
    // instruction nobody can carry out. The user's own key is the only way in.
    const email = facts.connections.play.publisherEmail
    return {
      state: 'play',
      next_action: 'connect_play',
      user_message: email
        ? PLAY_INVITE.replace('{email}', email)
        : `Connect a Google Play service account in Project → App stores: Play Console → Setup → API access → create a service account, download its JSON key, and grant it "Release apps to testing tracks" on ${facts.androidPackage}. No publisher account is configured, so the release has nothing to submit with.`,
      links: {},
    }
  }

  if (wantsIos && !facts.connections.asc.keyAvailable) {
    return {
      state: 'asc',
      next_action: 'connect_asc',
      user_message:
        'Add an App Store Connect API key in Project → App stores (App Store Connect → Users and Access → Integrations → App Store Connect API). Apple has no way to grant Shogo publishing rights, so the key has to be yours.',
      links: {},
    }
  }

  if (wantsAndroid && !facts.connections.play.firstUploadDone) {
    return {
      state: 'play_first_upload',
      next_action: 'play_first_upload',
      user_message: `Google has never seen ${facts.androidPackage}. Download this release's build and upload it once in Play Console — that creates the app record — then ship from Shogo with no further hand steps.`,
      links: { download: '/api/native-release/builds/latest' },
    }
  }

  if (wantsIos && !facts.connections.asc.appRecord) {
    return {
      state: 'asc_app_record',
      next_action: 'asc_app_record',
      user_message: `Create the app for ${facts.bundleIdentifier} in App Store Connect (Apps → + → New App). Apple requires the record to exist before anything can be submitted to it.`,
      links: {},
    }
  }

  if (!facts.hasStoreIcon) {
    return {
      state: 'icon',
      next_action: 'needs_icon',
      user_message:
        'This project still has the starter icon. Send a logo (any square image) and Shogo will generate the iOS icon, the Android adaptive icon, the splash icon and the Play icon from it.',
      links: {},
    }
  }

  if (!release) {
    return {
      state: 'ready',
      next_action: 'building',
      user_message: 'Everything is connected. Starting the test build now.',
      links: {},
    }
  }

  const failed = release.testOutcome === 'failed' || release.status === 'failed'
  if (failed) {
    const detail = release.error ? ` ${release.error}` : ''
    return {
      state: 'failed',
      next_action: 'test_failed',
      user_message: `The test build or a Maestro flow failed, so nothing was sent to the store and no store build was charged.${detail} Fix the failing flow and ship again.`,
      links: { logs: '/api/native-release/logs' },
    }
  }

  if (release.status === 'done') {
    return {
      state: 'live',
      next_action: 'live',
      user_message:
        release.kind === 'update'
          ? 'The update is live on existing installs.'
          : 'The build is submitted. It is in review on the store side now.',
      links: {},
    }
  }

  if (release.status === 'testing' || release.testOutcome === 'pending') {
    return {
      state: 'testing',
      next_action: 'testing',
      user_message: 'The test build is running and the Maestro flows run against it. Nothing has been sent to the store yet.',
      links: { logs: '/api/native-release/logs' },
    }
  }

  if (release.status === 'submitting') {
    return {
      state: 'submitted',
      next_action: 'submitted',
      user_message: 'The build passed its tests and is being submitted to the store.',
      links: {},
    }
  }

  return {
    state: 'building',
    next_action: 'building',
    user_message: `Building (${release.step ?? release.status}). This returns immediately — check back with the release id rather than waiting.`,
    links: { logs: '/api/native-release/logs' },
  }
}

/**
 * "Everything before the build is done."
 *
 * A status poll is about a release that already exists, so the pre-release gates
 * are by definition satisfied. Spelling that out keeps `nativeNextStep` one
 * function for both paths instead of two that drift.
 */
export const RELEASE_ONLY_FACTS: NativeReleaseFacts = {
  needsBundleId: false,
  hasServerFiles: false,
  backend: { published: true, url: null },
  connections: {
    play: { keyAvailable: true, publisherEmail: null, firstUploadDone: true },
    asc: { keyAvailable: true, appRecord: true },
  },
  hasStoreIcon: true,
  bundleIdentifier: '',
  androidPackage: '',
}

/**
 * Does this project have a store icon of its own?
 *
 * The Expo stack templates ship **no** icon at all (no `expo.icon`, no
 * `assets/images/icon.png`), so the question is simply whether the project has
 * one yet. A project that never adds one would submit Shogo's build with no
 * listing artwork at all, which the stores reject — so `needs_icon` comes before
 * any build.
 */
export function hasCustomStoreIcon(opts: {
  /** Paths that exist in the project, project-relative. */
  files: string[]
  /** `expo.icon` from app.json / app.config, when the project sets it. */
  iconFromConfig?: string | null
}): boolean {
  if (opts.iconFromConfig) return true
  return ['assets/images/icon.png', 'assets/icon.png', 'icon.png', 'assets/images/icon.jpg'].some((p) =>
    opts.files.includes(p),
  )
}
