// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The Shogo project ↔ EAS project mapping, and the one place an EAS project is
 * created.
 *
 * `ensureNativeApp` is idempotent: the `native_apps` row is the lock, so calling
 * it twice creates one Expo project, one BUILD webhook and one SUBMIT webhook.
 * It is called on every release start, because a project's app can be missing
 * for reasons that have nothing to do with the release (a failed `createApp`, a
 * race between two releases, a row deleted by hand).
 *
 * There is no `ensureExpoOrg`. Russell's 2026-11-06 decision put every project on
 * one Shogo Expo account, and the public API has no mutation to create an
 * organisation anyway — see `docs/native-release/eas-graphql.md`.
 */

import { prisma } from '../../lib/prisma'
import { NativeReleaseError, easClientFor, type EasCredentials } from './client'
import { createApp, createWebhook, meActor } from './eas-graphql'
import { alertOps } from './alerts'

const db = prisma as any

/** The one Expo project name we auto-create per Shogo project. */
export function defaultProjectName(projectId: string): string {
  return `shogo-${projectId.replace(/-/g, '').slice(0, 12)}`
}

export function defaultBundleIdentifier(slug: string): string {
  return `ai.shogo.app.${slug.replace(/[^a-z0-9]+/gi, '').toLowerCase() || 'app'}`
}

export interface NativeAppRow {
  id: string
  workspaceId: string
  projectId: string
  mode: string
  easAccountId: string | null
  easAppId: string | null
  bundleIdentifier: string | null
  androidPackage: string | null
  ascAppId: string | null
  idsLockedAt: Date | null
  firstPlaySubmissionAt: Date | null
}

const WEBHOOK_PATH = '/api/webhooks/eas'

/**
 * Resolve the account to create apps on. In `cloud` it comes from the env; in
 * `byok` it is whichever account the token can act for, preferring an exact
 * match (`EXPO_ACCOUNT_ID`) and otherwise the only account — never a guess when
 * there are several, because creating an app on the wrong account is expensive
 * to undo.
 */
export async function resolveAccountId(
  credentials: EasCredentials,
  client = easClientFor(credentials),
): Promise<string> {
  if (credentials.accountId) return credentials.accountId
  const me = await meActor(client)
  if (me.accounts.length === 1) return me.accounts[0].id
  if (me.accounts.length === 0) {
    throw new NativeReleaseError(
      412,
      'expo_account_missing',
      'That Expo token cannot act for any account.',
    )
  }
  throw new NativeReleaseError(
    400,
    'expo_account_ambiguous',
    'That Expo token can act for more than one account; set EXPO_ACCOUNT_ID to choose one.',
    { accounts: me.accounts.map((a) => a.name) },
  )
}

export interface EnsureNativeAppOptions {
  projectId: string
  workspaceId: string
  credentials: EasCredentials
  /** Public API base, for the webhook URL. */
  apiBaseUrl: string
  webhookSecret?: string
}

/**
 * Get or create the `NativeApp` row *and* its EAS project.
 *
 * The row is created first (empty), and only then is `createApp` called: if Expo
 * fails, the next release retries against the same row instead of leaking a
 * second EAS project. `easAppId` being null is exactly "not created yet".
 */
export async function ensureNativeApp(opts: EnsureNativeAppOptions): Promise<NativeAppRow> {
  const existing = await db.nativeApp.findUnique({ where: { projectId: opts.projectId } })
  const row: NativeAppRow =
    existing ??
    (await db.nativeApp.create({
      data: {
        projectId: opts.projectId,
        workspaceId: opts.workspaceId,
        mode: opts.credentials.mode === 'cloud' ? 'managed' : 'byok',
        easAccountId: opts.credentials.accountId,
      },
    }))

  if (row.easAppId) return row

  const client = easClientFor(opts.credentials)
  const accountId = await resolveAccountId(opts.credentials, client)

  let created: { id: string; slug: string }
  try {
    created = await createApp(client, {
      accountId,
      projectName: defaultProjectName(opts.projectId),
    })
  } catch (err) {
    // Expo refuses past the account's project cap. That is a capacity problem
    // for us, not the user's mistake, so it must not look like a bad request.
    if (err instanceof NativeReleaseError && /project.*limit|too many projects/i.test(err.message)) {
      await alertOps('native_app_capacity', { projectId: opts.projectId, accountId })
      throw new NativeReleaseError(
        503,
        'native_capacity',
        'Native release is at capacity right now. We have been alerted; try again shortly.',
      )
    }
    throw err
  }

  const updated = await db.nativeApp.update({
    where: { id: row.id },
    data: { easAppId: created.id, easAccountId: accountId },
  })

  const secret = opts.webhookSecret ?? process.env.EAS_WEBHOOK_SECRET
  if (secret) {
    const url = `${opts.apiBaseUrl.replace(/\/$/, '')}${WEBHOOK_PATH}`
    for (const event of ['BUILD', 'SUBMIT'] as const) {
      await createWebhook(client, { appId: created.id, url, secret, event })
    }
  }

  return updated
}

/**
 * Which bundle id / package a project ships under. Locked once it has been sent
 * to a store: changing it afterwards would publish to a different app record.
 */
export async function setAppIdentifiers(
  projectId: string,
  input: { bundleIdentifier?: string; androidPackage?: string; ascAppId?: string },
): Promise<NativeAppRow> {
  const app = await db.nativeApp.findUnique({ where: { projectId } })
  if (!app) {
    throw new NativeReleaseError(404, 'native_app_missing', 'This project has no native app yet.')
  }
  if (app.idsLockedAt) {
    throw new NativeReleaseError(
      409,
      'native_ids_locked',
      'The bundle id and package are locked after the first store upload.',
    )
  }
  return db.nativeApp.update({ where: { projectId }, data: { ...input } })
}

/** Called once a store upload has gone out, so the ids stop being editable. */
export async function lockAppIdentifiers(projectId: string, platform: 'ios' | 'android'): Promise<void> {
  const data: Record<string, unknown> = { idsLockedAt: new Date() }
  if (platform === 'android') data.firstPlaySubmissionAt = new Date()
  await db.nativeApp.update({ where: { projectId }, data })
}
