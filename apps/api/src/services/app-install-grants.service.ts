// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Marketplace app grants: what an install of an app with a `shogo.app.json`
 * may access, and the event subscriptions it owns.
 *
 * Install asks for consent (scopes + required Composio toolkits), creates an
 * `AppInstallGrant` and one install-owned `EventSubscription` per manifest
 * event, targeting the installed project. An update that asks for more scopes
 * parks them as `pendingScopes` until the installer re-consents; deliveries
 * keep the old scope set meanwhile. Uninstall revokes the grant, deletes the
 * subscriptions (and their Composio triggers) and revokes install tokens.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  APP_MANIFEST_FILE,
  EVENT_SCOPES,
  grantableScopes,
  parseAppManifest,
  type AppEventSpec,
  type ShogoAppManifest,
} from '@shogo-ai/sdk/events'
import { prisma } from '../lib/prisma'
import { decryptSecret, encryptSecret } from '../lib/secret-crypto'
import { getWorkspacesDir } from './marketplace-install.service'
import { composioEntityFor, composioTriggersClient, connectedToolkits } from './composio-triggers.service'
import { createSubscription, deleteSubscription, EventSubscriptionError } from './event-subscription.service'

const db = prisma as any

export class AppConsentError extends Error {
  constructor(
    public status: 400 | 403 | 404 | 409 | 502 | 503,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'AppConsentError'
  }
}

export interface AppConsentInput {
  accept: boolean
  /** Optional scopes the installer agrees to; required scopes are implied by `accept`. */
  optionalScopes?: string[]
}

export interface ConsentRequest {
  version: string
  scopes: Array<{ scope: string; description: string }>
  optionalScopes: Array<{ scope: string; description: string }>
  requiredToolkits: string[]
  events: Array<{ type: string; target: string; name?: string }>
}

function describeScope(scope: string): { scope: string; description: string } {
  const composio = /^composio:([^:]+):read$/.exec(scope)
  return { scope, description: EVENT_SCOPES[scope] ?? (composio ? `Receive ${composio[1]} events from your connected account` : scope) }
}

/** True when the manifest asks for anything that needs consent. */
export function manifestNeedsConsent(manifest: ShogoAppManifest | null): manifest is ShogoAppManifest {
  return !!manifest && (manifest.events.length > 0 || manifest.scopes.length > 0 || manifest.optionalScopes.length > 0 || manifest.requiredToolkits.length > 0)
}

export function consentRequestFor(manifest: ShogoAppManifest, version: string): ConsentRequest {
  return {
    version,
    scopes: manifest.scopes.map(describeScope),
    optionalScopes: manifest.optionalScopes.map(describeScope),
    requiredToolkits: manifest.requiredToolkits,
    events: manifest.events.map((e) => ({ type: e.type, target: e.target, ...(e.name ? { name: e.name } : {}) })),
  }
}

function manifestFromSnapshot(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null
  const root = snapshot as Record<string, any>
  const files = root.files && typeof root.files === 'object' && !Array.isArray(root.files) ? root.files : root
  const entry = files[APP_MANIFEST_FILE]
  if (typeof entry === 'string') return entry
  if (entry && typeof entry.data === 'string') {
    return entry.encoding === 'base64' ? Buffer.from(entry.data, 'base64').toString('utf8') : entry.data
  }
  return null
}

/**
 * The `shogo.app.json` a version being published ships: from the supplied
 * snapshot, else the source project's workspace. `null` when there is none;
 * throws `invalid_app_manifest` (400, `errors`) when it doesn't validate.
 */
export function readAppManifestForPublish(sourceProjectId: string, snapshot?: unknown): ShogoAppManifest | null {
  let raw = manifestFromSnapshot(snapshot)
  if (raw === null) {
    const path = join(getWorkspacesDir(), sourceProjectId, APP_MANIFEST_FILE)
    if (!existsSync(path)) return null
    raw = readFileSync(path, 'utf8')
  }
  const parsed = parseAppManifest(raw)
  if (!parsed.ok) {
    throw new AppConsentError(400, 'invalid_app_manifest', `${APP_MANIFEST_FILE} is invalid: ${parsed.errors.join('; ')}`, { errors: parsed.errors })
  }
  return parsed.manifest
}

/** The stored manifest of a listing version (null when the app has none). */
export async function loadVersionManifest(listingId: string, version: string): Promise<ShogoAppManifest | null> {
  const row = await db.marketplaceListingVersion.findFirst({ where: { listingId, version }, select: { appManifest: true } })
  if (!row?.appManifest) return null
  const parsed = parseAppManifest(row.appManifest)
  return parsed.ok ? parsed.manifest : null
}

/** Throws `consent_required` (409, with the consent request) unless `consent.accept`. Returns the scopes to grant. */
export function resolveConsent(manifest: ShogoAppManifest, version: string, consent: AppConsentInput | null | undefined): string[] {
  if (!consent || consent.accept !== true) {
    throw new AppConsentError(409, 'consent_required', 'This app needs your approval for the access it requests', {
      consent: consentRequestFor(manifest, version),
    })
  }
  const optional = Array.isArray(consent.optionalScopes) ? consent.optionalScopes.filter((s) => typeof s === 'string') : []
  return grantableScopes(manifest, optional)
}

/** Throws `needs_connection` (409, `toolkits`) when the installer hasn't connected a required toolkit. */
export async function assertToolkitsConnected(workspaceId: string, userId: string, toolkits: readonly string[]): Promise<void> {
  if (toolkits.length === 0) return
  if (!composioTriggersClient()) {
    throw new AppConsentError(503, 'composio_unavailable', `This app needs ${toolkits.join(', ')}, but integrations are not configured here`)
  }
  const entityId = await composioEntityFor(workspaceId, userId, null)
  const connected = new Set((await connectedToolkits(entityId)).map((c) => c.toolkit))
  const missing = toolkits.filter((t) => !connected.has(t))
  if (missing.length) {
    throw new AppConsentError(409, 'needs_connection', `Connect ${missing.join(', ')} before installing this app`, { toolkits: missing })
  }
}

function subscriptionName(appName: string, spec: AppEventSpec): string {
  return `${appName}: ${spec.name ?? spec.type}${spec.target === 'agent' ? ' (agent)' : ''}`.slice(0, 200)
}

/**
 * Make the install's subscriptions match `manifest`: create missing ones,
 * delete ones the manifest no longer lists. Keyed by subscription name.
 */
export async function syncInstallSubscriptions(input: {
  installId: string
  workspaceId: string
  userId: string
  projectId: string
  appName: string
  manifest: ShogoAppManifest
}): Promise<{ created: number; deleted: number }> {
  const existing: any[] = await db.eventSubscription.findMany({ where: { installId: input.installId } })
  const wanted = new Map(input.manifest.events.map((spec) => [subscriptionName(input.appName, spec), spec]))
  let deleted = 0
  for (const sub of existing) {
    if (!wanted.has(sub.name)) {
      await deleteSubscription(input.workspaceId, sub.id, { allowAppManaged: true })
      deleted++
    }
  }
  const have = new Set(existing.map((s) => s.name))
  let created = 0
  for (const [name, spec] of wanted) {
    if (have.has(name)) continue
    await createSubscription({
      workspaceId: input.workspaceId,
      ownerUserId: input.userId,
      name,
      eventType: spec.type,
      filter: spec.filter ?? null,
      target: 'project',
      targetProjectId: input.projectId,
      targetMode: spec.target,
      prompt: spec.prompt ?? null,
      triggerConfig: spec.config ?? null,
      installId: input.installId,
    })
    created++
  }
  return { created, deleted }
}

/** Mint the install token: an `app` ApiKey carrying the grant's scopes. Returns the bearer and its encrypted copy. */
async function mintInstallToken(input: { installId: string; workspaceId: string; userId: string; appName: string; scopes: string[] }) {
  const { generateApiKey } = await import('../lib/api-keys-mint')
  const { fullKey, keyHash, keyPrefix } = await generateApiKey()
  await db.apiKey.create({
    data: {
      name: `${input.appName} (app)`.slice(0, 120),
      keyHash,
      keyPrefix,
      workspaceId: input.workspaceId,
      userId: input.userId,
      kind: 'app',
      installId: input.installId,
      grantedScopes: input.scopes,
    },
  })
  return { token: fullKey, encryptedToken: encryptSecret(fullKey) }
}

/** Create the grant, its install token, and the install's subscriptions. Rolls back if any subscription fails. */
export async function provisionInstallGrant(input: {
  installId: string
  workspaceId: string
  listingId: string
  userId: string
  projectId: string
  version: string
  appName: string
  manifest: ShogoAppManifest
  grantedScopes: string[]
}) {
  const { encryptedToken } = await mintInstallToken({
    installId: input.installId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    appName: input.appName,
    scopes: input.grantedScopes,
  })
  const grant = await db.appInstallGrant.create({
    data: {
      installId: input.installId,
      workspaceId: input.workspaceId,
      listingId: input.listingId,
      grantedByUserId: input.userId,
      version: input.version,
      grantedScopes: input.grantedScopes,
      grantedToolkits: input.manifest.requiredToolkits,
      pendingScopes: [],
      encryptedToken,
      status: 'active',
    },
  })
  try {
    await syncInstallSubscriptions(input)
  } catch (error) {
    await revokeInstallGrant(input.installId).catch(() => {})
    if (error instanceof EventSubscriptionError) {
      throw new AppConsentError(error.status, error.code, error.message, error.details)
    }
    throw error
  }
  return grant
}

export async function getInstallGrant(installId: string) {
  return db.appInstallGrant.findUnique({ where: { installId } })
}

/**
 * After an install moves to `version`: scopes the new manifest needs beyond
 * the grant become pending (subscriptions wait for re-consent); otherwise the
 * subscriptions are synced right away.
 */
export async function onInstallUpdated(input: { installId: string; version: string }): Promise<{ pendingScopes: string[] } | null> {
  const install = await db.marketplaceInstall.findUnique({ where: { id: input.installId }, include: { listing: { select: { title: true } } } })
  if (!install) return null
  const manifest = await loadVersionManifest(install.listingId, input.version)
  const grant = await getInstallGrant(input.installId)
  if (!manifestNeedsConsent(manifest)) {
    if (grant && grant.status === 'active') await revokeInstallGrant(input.installId)
    return { pendingScopes: [] }
  }
  const granted: string[] = grant?.status === 'active' ? grant.grantedScopes : []
  const missing = grantableScopes(manifest).filter((s) => !granted.includes(s))
  if (!grant || grant.status !== 'active' || missing.length) {
    if (grant) {
      await db.appInstallGrant.update({ where: { installId: input.installId }, data: { pendingScopes: missing, pendingVersion: input.version } })
    }
    return { pendingScopes: missing }
  }
  await syncInstallSubscriptions({
    installId: input.installId,
    workspaceId: install.workspaceId,
    userId: install.userId,
    projectId: install.projectId,
    appName: install.listing.title,
    manifest,
  })
  await db.appInstallGrant.update({ where: { installId: input.installId }, data: { version: input.version, pendingScopes: [], pendingVersion: null } })
  return { pendingScopes: [] }
}

/** The installer approves the access the installed version asks for. */
export async function consentToInstall(input: { installId: string; userId: string; consent: AppConsentInput }) {
  const install = await db.marketplaceInstall.findUnique({ where: { id: input.installId }, include: { listing: { select: { title: true } } } })
  if (!install) throw new AppConsentError(404, 'install_not_found', 'Install not found')
  if (install.userId !== input.userId) throw new AppConsentError(403, 'install_access_denied', 'Only the person who installed the app can approve its access')
  if (install.status !== 'active') throw new AppConsentError(409, 'install_not_active', 'This install is not active')
  const version = install.installedVersion
  const manifest = await loadVersionManifest(install.listingId, version)
  if (!manifestNeedsConsent(manifest)) throw new AppConsentError(409, 'nothing_to_consent', 'This version of the app requests no access')
  const grantedScopes = resolveConsent(manifest, version, input.consent)
  await assertToolkitsConnected(install.workspaceId, install.userId, manifest.requiredToolkits)
  const existing = await getInstallGrant(input.installId)
  if (!existing || existing.status !== 'active') {
    if (existing) await db.appInstallGrant.delete({ where: { installId: input.installId } })
    return provisionInstallGrant({
      installId: input.installId,
      workspaceId: install.workspaceId,
      listingId: install.listingId,
      userId: install.userId,
      projectId: install.projectId,
      version,
      appName: install.listing.title,
      manifest,
      grantedScopes,
    })
  }
  await db.appInstallGrant.update({
    where: { installId: input.installId },
    data: { grantedScopes, grantedToolkits: manifest.requiredToolkits, version, pendingScopes: [], pendingVersion: null },
  })
  await db.apiKey.updateMany({ where: { installId: input.installId, revokedAt: null }, data: { grantedScopes } })
  try {
    await syncInstallSubscriptions({
      installId: input.installId,
      workspaceId: install.workspaceId,
      userId: install.userId,
      projectId: install.projectId,
      appName: install.listing.title,
      manifest,
    })
  } catch (error) {
    if (error instanceof EventSubscriptionError) throw new AppConsentError(error.status, error.code, error.message, error.details)
    throw error
  }
  return getInstallGrant(input.installId)
}

/** Revoke the grant: delete the install's subscriptions (and Composio triggers) and its tokens. */
export async function revokeInstallGrant(installId: string): Promise<{ subscriptions: number; tokens: number }> {
  const subs: any[] = await db.eventSubscription.findMany({ where: { installId }, select: { id: true, workspaceId: true } })
  for (const sub of subs) await deleteSubscription(sub.workspaceId, sub.id, { allowAppManaged: true })
  const now = new Date()
  const tokens = await db.apiKey.updateMany({ where: { installId, revokedAt: null }, data: { revokedAt: now } })
  await db.appInstallGrant.updateMany({
    where: { installId, status: 'active' },
    data: { status: 'revoked', revokedAt: now, pendingScopes: [], pendingVersion: null, encryptedToken: null },
  })
  return { subscriptions: subs.length, tokens: tokens.count }
}

/** The live install token for an app's project (`SHOGO_APP_TOKEN`), or null. */
export async function appTokenForProject(projectId: string): Promise<string | null> {
  const install = await db.marketplaceInstall.findFirst({ where: { projectId, status: 'active' }, select: { id: true } })
  return install ? appTokenForInstall(install.id) : null
}

export async function appTokenForInstall(installId: string): Promise<string | null> {
  const grant = await getInstallGrant(installId)
  if (!grant || grant.status !== 'active' || !grant.encryptedToken) return null
  try {
    return decryptSecret(grant.encryptedToken)
  } catch {
    return null
  }
}

/** Never expose the token ciphertext through the API. */
export function serializeGrant(grant: any) {
  if (!grant) return grant
  const { encryptedToken, ...rest } = grant
  return { ...rest, hasToken: !!encryptedToken }
}

/** Every app granted access to the workspace (active and revoked), for settings. */
export async function listWorkspaceGrants(workspaceId: string) {
  const grants = await db.appInstallGrant.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' } })
  if (!grants.length) return []
  const installs = await db.marketplaceInstall.findMany({
    where: { id: { in: grants.map((g: any) => g.installId) } },
    select: { id: true, projectId: true, status: true, installedVersion: true, listing: { select: { slug: true, title: true, iconUrl: true } } },
  })
  const users = await db.user.findMany({
    where: { id: { in: [...new Set(grants.map((g: any) => g.grantedByUserId))] as string[] } },
    select: { id: true, name: true, email: true },
  })
  const installById = new Map(installs.map((i: any) => [i.id, i]))
  const userById = new Map(users.map((u: any) => [u.id, u]))
  return grants.map((grant: any) => {
    const install: any = installById.get(grant.installId)
    const user: any = userById.get(grant.grantedByUserId)
    return {
      ...serializeGrant(grant),
      app: install ? { slug: install.listing.slug, title: install.listing.title, iconUrl: install.listing.iconUrl ?? null } : null,
      projectId: install?.projectId ?? null,
      installStatus: install?.status ?? null,
      grantedBy: user ? { id: user.id, name: user.name ?? user.email } : null,
    }
  })
}

/** Scopes deliveries to an app-owned subscription may see; `null` = no live grant (deliver nothing). */
export async function grantedScopesForInstall(installId: string): Promise<string[] | null> {
  const grant = await getInstallGrant(installId)
  return grant && grant.status === 'active' ? grant.grantedScopes : null
}
