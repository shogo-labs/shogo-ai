// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Publish API Routes
 *
 * Endpoints for publishing projects to subdomain.shogo.one URLs.
 * Platform lives at shogo.ai, published apps at shogo.one for isolation.
 * 
 * Architecture:
 *   1. Trigger build in dev runtime pod
 *   2. Download built dist/ files from pod
 *   3. Upload to S3 bucket (persistent storage)
 *   4. Create nginx Knative Service that syncs from S3 via init container
 *   5. Create DomainMapping: {subdomain}.shogo.one -> published-{projectId}
 *   6. Traffic: *.shogo.one DNS -> Kourier ALB -> Knative Service -> nginx
 */

import { Hono } from "hono"
import { S3Client, PutObjectCommand, CopyObjectCommand, DeleteObjectsCommand, ListObjectsV2Command, HeadObjectCommand } from "@aws-sdk/client-s3"
import { prisma } from "../lib/prisma"
import { deriveProjectRuntimeToken } from "../lib/project-runtime-token"
import { recordCheckpointForCommit } from "../services/checkpoint.service"
import {
  getCustomHostnamesConfig,
  createCustomHostname,
  deleteCustomHostname,
  retriggerCustomHostname,
  putHostnameMapping,
  deleteHostnameMapping,
  type CustomHostnameState,
} from "../lib/cloudflare-custom-hostnames"
import {
  setSitePassword,
  clearSitePassword,
  hashSitePassword,
} from "../lib/cloudflare-site-auth-kv"
import { getShogoCloudUrl } from "../lib/cloud-urls"
import { getUpstreamCredential } from "../lib/federated-upstream"
import { isProjectCloudLinked } from "../lib/runtime/cloud-content-sync"
import { shouldSkipForwardedHeader, shouldSkipResponseHeader } from "../lib/proxy-headers"
import {
  cfStateToStatus,
  domainCompanion,
  canonicalForRow,
  refreshCustomDomain,
  deriveStage,
  evaluateRetrigger,
  parseDiagnostics,
  prettyCertAuthority,
  STALE_READ_MS,
  type CustomDomainRowLike,
} from "../services/custom-domain.service"

// S3 configuration. `PUBLISH_BUCKET` must be set explicitly in every K8s
// overlay (k8s/overlays/{staging,production-*}/api-service.yaml) — the
// fallback below is a deliberately wrong-looking local-dev value so a
// missing overlay value can't silently route prod uploads to the staging
// bucket. That happened on 2026-05-26: prod api ksvc had no
// PUBLISH_BUCKET, the old default `shogo-published-apps-staging` won,
// and every prod publish wrote to the staging bucket while the
// Cloudflare Worker for *.shogo.one was reading from
// `shogo-published-apps-production` — every published app served
// `ObjectNotFound`. uploadToS3() now also asserts at call time.
const PUBLISH_BUCKET = process.env.PUBLISH_BUCKET || "shogo-published-apps-LOCAL-DEV"
// Writable-state bucket for SERVER-BACKED published apps (the SQLite DB +
// upload dirs the running server.tsx persists). Separate from PUBLISH_BUCKET
// (static dist). Unset → server-backed publishing degrades to "no durable
// writes" but still serves dynamic /api/* from the source-seed DB.
const PUBLISH_DATA_BUCKET = process.env.PUBLISH_DATA_BUCKET || process.env.S3_PUBLISHED_DATA_BUCKET || ""
const PUBLISH_DOMAIN = process.env.PUBLISH_DOMAIN || "shogo.one"
const AWS_REGION = process.env.S3_REGION || process.env.AWS_REGION || "us-east-1"

// Per-step timeouts for outbound calls into the runtime pod. Without these,
// a frozen pod (e.g. node memory-pressure stalls or scale-to-zero races)
// hangs the publish HTTP request indefinitely — which is exactly what
// happened to project b11c65dd on 2026-05-20: the runtime went silent for
// 4 minutes, Knative reaped the ksvc mid-flight, and the publish API never
// returned a structured error to Studio. 60s covers a healthy bun-rebuild
// of a typical app; anything longer is almost certainly a stuck pod.
const PUBLISH_BUILD_TIMEOUT_MS = Number(process.env.PUBLISH_BUILD_TIMEOUT_MS) || 60_000
const PUBLISH_DOWNLOAD_TIMEOUT_MS = Number(process.env.PUBLISH_DOWNLOAD_TIMEOUT_MS) || 60_000

// In-flight lock TTL on the project's Knative Service annotation. The
// warm-pool GC honors this annotation and skips deletion while a publish
// is mid-flight; the TTL means a forgotten/crashed lock self-heals.
const PUBLISH_IN_FLIGHT_TTL_MS = 10 * 60 * 1000

// Initialize AWS clients
const s3Client = new S3Client({
  region: AWS_REGION,
  ...(process.env.S3_ENDPOINT && {
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: true,
  }),
})

// Check if we're in Kubernetes (S3 publishing mode) or local dev
function isKubernetes(): boolean {
  return !!(process.env.KUBERNETES_SERVICE_HOST || process.env.PROJECT_NAMESPACE)
}

/**
 * Forward a publish request from the local/desktop API to Shogo Cloud using the
 * connected `SHOGO_API_KEY`. Mirrors the marketplace proxy (apps/api/src/routes/
 * marketplace.ts): without this, local mode skips the entire build/upload/host
 * pipeline (`isKubernetes()` is false) yet returns a fake 200 + live URL — so a
 * desktop "publish" looked successful but nothing deployed. The router is
 * invoked with a path stripped of the `/api` prefix (see server.ts), so we
 * re-add it when building the upstream URL.
 */
async function proxyPublishToCloud(c: any, cloudKey: string): Promise<Response> {
  const method = c.req.method
  const search = new URL(c.req.url).search
  const fullUrl = `${getShogoCloudUrl()}/api${c.req.path}${search}`

  const headers = new Headers()
  c.req.raw.headers.forEach((value: string, key: string) => {
    const lower = key.toLowerCase()
    if (shouldSkipForwardedHeader(lower)) return
    // Replace the local session auth with the cloud API key below.
    if (lower === "authorization") return
    headers.set(key, value)
  })
  headers.set("Authorization", `Bearer ${cloudKey}`)

  let upstream: Response
  try {
    upstream = await fetch(fullUrl, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : c.req.raw.body,
      // @ts-expect-error duplex is required for streaming request bodies in Bun/Node fetch
      duplex: "half",
    })
  } catch (err: any) {
    console.error("[Publish] cloud proxy failed:", err?.message ?? err)
    return c.json(
      { error: { code: "cloud_unreachable", message: "Could not reach Shogo Cloud" } },
      502,
    )
  }

  // The cloud rejected the API key — surface a sign-in prompt rather than the
  // raw 401 (which the UI would read as "not authorized for this project").
  if (upstream.status === 401) {
    return c.json(
      { error: { code: "cloud_signin_required", message: "Sign in to Shogo Cloud to publish." } },
      503,
    )
  }

  const responseHeaders = new Headers()
  upstream.headers.forEach((value, key) => {
    if (shouldSkipResponseHeader(key)) return
    responseHeaders.set(key, value)
  })
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  })
}

// Reserved subdomains that cannot be used
const RESERVED_SUBDOMAINS = new Set([
  "api", "www", "studio", "app", "admin", "mail", "email", "ftp", "ssh",
  "test", "dev", "staging", "prod", "production", "cdn", "static", "assets",
  "media", "images", "files", "download", "downloads", "upload", "uploads",
  "status", "health", "docs", "blog", "support", "help", "auth", "login",
  "logout", "signup", "signin", "register", "account", "dashboard", "console",
  "panel", "portal",
])

// Subdomain validation rules
const SUBDOMAIN_MIN_LENGTH = 3
const SUBDOMAIN_MAX_LENGTH = 63
const SUBDOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

// Visitor access levels. `password` gates the site behind a shared password
// enforced at the *.shogo.one edge Worker (see cloudflare-site-auth-kv.ts);
// `authenticated`/`private` are stored but not yet enforced at the edge.
export type AccessLevel = "anyone" | "authenticated" | "private" | "password"
const ACCESS_LEVELS = new Set<AccessLevel>(["anyone", "authenticated", "private", "password"])
// Minimum length for a shared site password (a low bar — this is a soft gate,
// not per-user credentials, but block trivially empty/short values).
const SITE_PASSWORD_MIN_LENGTH = 4

/**
 * Validate subdomain format and availability
 */
function validateSubdomain(subdomain: string): { valid: boolean; reason?: string } {
  if (subdomain.length < SUBDOMAIN_MIN_LENGTH) {
    return { valid: false, reason: `Subdomain must be at least ${SUBDOMAIN_MIN_LENGTH} characters` }
  }
  if (subdomain.length > SUBDOMAIN_MAX_LENGTH) {
    return { valid: false, reason: `Subdomain cannot exceed ${SUBDOMAIN_MAX_LENGTH} characters` }
  }
  if (!SUBDOMAIN_PATTERN.test(subdomain)) {
    return {
      valid: false,
      reason: "Subdomain must start and end with alphanumeric, contain only lowercase letters, numbers, and hyphens",
    }
  }
  if (subdomain.includes("--")) {
    return { valid: false, reason: "Subdomain cannot contain consecutive hyphens" }
  }
  if (RESERVED_SUBDOMAINS.has(subdomain)) {
    return { valid: false, reason: "This subdomain is reserved" }
  }
  return { valid: true }
}

// A custom domain may not live under a Shogo-operated zone — those are
// served by our own wildcards/Workers and pointing one here would either
// be a no-op or hijack platform routing. Compared case-insensitively as a
// suffix so `foo.shogo.ai` and `shogo.one` are both rejected.
const RESERVED_DOMAIN_SUFFIXES = ["shogo.ai", "shogo.one", "shogo.app", "shogo.dev"]

// RFC 1123 hostname: 1-63 char labels, alphanumeric + hyphen (not at the
// ends), at least two labels (must be a FQDN, not a bare label).
const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

/**
 * Validate a user-supplied custom hostname (e.g. "app.acme.com"). Returns a
 * normalised (lowercased, trimmed, no trailing dot) hostname on success.
 */
function validateCustomHostname(
  raw: string,
): { valid: true; hostname: string } | { valid: false; reason: string } {
  const hostname = raw.trim().toLowerCase().replace(/\.$/, "")
  if (!hostname) {
    return { valid: false, reason: "Domain is required" }
  }
  if (hostname.length > 253) {
    return { valid: false, reason: "Domain is too long" }
  }
  if (hostname.startsWith("*.")) {
    return { valid: false, reason: "Wildcard domains are not supported" }
  }
  if (!HOSTNAME_PATTERN.test(hostname)) {
    return { valid: false, reason: "Enter a valid domain like app.example.com" }
  }
  if (
    RESERVED_DOMAIN_SUFFIXES.some(
      (s) => hostname === s || hostname.endsWith(`.${s}`),
    )
  ) {
    return { valid: false, reason: "This domain is managed by Shogo" }
  }
  return { valid: true, hostname }
}

/**
 * Serialise a CustomDomain row (+ optional live CF state) for the API,
 * enriched with the derived lifecycle `stage`/`message`, per-record DNS +
 * SSL detail (live state when present, else the persisted `diagnostics`
 * snapshot so list reads are DB-only but still informative), and a
 * server-computed `canRetrigger` gate the panel mirrors for its button.
 */
function serializeDomain(
  row: CustomDomainRowLike,
  state?: CustomHostnameState | null,
  canonicalHostname?: string,
  now: number = Date.now(),
) {
  const enabled = !!getCustomHostnamesConfig()
  const diag = parseDiagnostics(row.diagnostics)
  const { stage, message } = deriveStage(row, now)
  const gate = evaluateRetrigger(row, enabled, now)
  const certAuthority = row.certAuthority ?? state?.certAuthority ?? diag?.certAuthority ?? undefined
  return {
    id: row.id,
    hostname: row.hostname,
    status: row.status,
    sslStatus: row.sslStatus ?? undefined,
    error: row.lastError ?? undefined,
    verifiedAt: row.verifiedAt ? row.verifiedAt.getTime() : undefined,
    instructions: state?.instructions ?? diag?.instructions ?? undefined,
    groupId: row.groupId ?? undefined,
    primary: row.primary ?? true,
    canonicalHostname: canonicalHostname ?? row.hostname,
    // Enriched status surface.
    stage,
    message,
    validation: state?.validation ?? diag?.validation ?? undefined,
    dns: diag?.dns ?? undefined,
    certAuthority,
    certAuthorityLabel: prettyCertAuthority(certAuthority) ?? undefined,
    createdAt: row.createdAt ? new Date(row.createdAt).getTime() : undefined,
    lastCheckedAt: row.lastCheckedAt ? new Date(row.lastCheckedAt).getTime() : undefined,
    lastRetriggerAt: row.lastRetriggerAt ? new Date(row.lastRetriggerAt).getTime() : undefined,
    retriggerCount: row.retriggerCount ?? 0,
    canRetrigger: gate.allowed,
    // Surface whichever wait dominates so the UI can show "retry in N".
    retriggerCooldownMs: gate.cooldownRemainingMs ?? gate.waitMs ?? undefined,
  }
}

/**
 * Serialise every row in a (possibly multi-row) set, resolving each row's
 * canonical hostname from the primary flag within its group. Pass the live
 * CF state per row id when available (e.g. right after add/verify) so the
 * DNS `instructions` are surfaced.
 */
function serializeDomains(
  rows: CustomDomainRowLike[],
  states?: Map<string, CustomHostnameState | null>,
) {
  const now = Date.now()
  return rows.map((r) =>
    serializeDomain(r, states?.get(r.id) ?? undefined, canonicalForRow(r, rows), now),
  )
}

/**
 * (Re)write the Worker KV `hostname -> subdomain` map for every ACTIVE
 * custom domain of a project. Called after publish/republish so a subdomain
 * change is reflected for custom domains too. Best-effort — never throws.
 */
async function syncCustomDomainKv(projectId: string, subdomain: string): Promise<void> {
  if (!getCustomHostnamesConfig()) return
  try {
    // Resolve canonicals from the full set (incl. non-active rows) so a
    // pending companion still defines the right redirect target for its
    // already-active sibling.
    const all = await prisma.customDomain.findMany({
      where: { projectId },
      select: { hostname: true, groupId: true, primary: true, status: true },
    })
    for (const d of all) {
      if (d.status !== "active") continue
      await putHostnameMapping(d.hostname, subdomain, canonicalForRow(d, all))
    }
  } catch (err: any) {
    console.warn(`[Publish] syncCustomDomainKv(${projectId}) failed:`, err?.message ?? err)
  }
}

type SitePasswordResolution =
  | { ok: true; hash: string | null }
  | { ok: false; code: string; message: string }

/**
 * Resolve the password hash to persist for a (re)publish or settings update.
 *   - fresh hash when accessLevel == 'password' and a new password is given
 *   - the existing hash when accessLevel == 'password', no new password, AND
 *     the subdomain is unchanged (the stored hash is salted by subdomain, so a
 *     subdomain change invalidates it and a new password must be supplied)
 *   - null otherwise (any non-password level clears the gate)
 * Returns a tagged result so callers can map bad input to a 400 without
 * tripping the outer publish_failed/500 catch.
 */
function resolveSitePasswordHash(opts: {
  accessLevel: AccessLevel
  password?: string
  subdomain: string
  existingHash: string | null
  existingSubdomain: string | null
}): SitePasswordResolution {
  const { accessLevel, password, subdomain, existingHash, existingSubdomain } = opts
  if (accessLevel !== "password") return { ok: true, hash: null }
  if (typeof password === "string" && password.length > 0) {
    if (password.length < SITE_PASSWORD_MIN_LENGTH) {
      return {
        ok: false,
        code: "password_too_short",
        message: `Password must be at least ${SITE_PASSWORD_MIN_LENGTH} characters`,
      }
    }
    return { ok: true, hash: hashSitePassword(subdomain, password) }
  }
  if (existingHash && existingSubdomain === subdomain) return { ok: true, hash: existingHash }
  return {
    ok: false,
    code: "password_required",
    message: "A password is required for password-protected sites",
  }
}

/**
 * Reflect the resolved access level + hash to the SITE_AUTH edge KV so the
 * Worker gates (or stops gating) the subdomain. Best-effort — the KV helpers
 * already swallow their own errors and no-op when unconfigured.
 */
async function syncSitePasswordKv(
  subdomain: string,
  accessLevel: AccessLevel,
  hash: string | null,
): Promise<void> {
  if (accessLevel === "password" && hash) {
    await setSitePassword(subdomain, hash)
  } else {
    await clearSitePassword(subdomain)
  }
}

/**
 * Remove the Worker KV mappings for all of a project's custom domains so
 * they stop serving once the project is unpublished. CF custom hostnames +
 * DB rows are kept so a later republish restores routing. Best-effort.
 */
async function clearCustomDomainKv(projectId: string): Promise<void> {
  if (!getCustomHostnamesConfig()) return
  try {
    const domains = await prisma.customDomain.findMany({
      where: { projectId },
      select: { hostname: true },
    })
    for (const d of domains) {
      await deleteHostnameMapping(d.hostname)
    }
  } catch (err: any) {
    console.warn(`[Publish] clearCustomDomainKv(${projectId}) failed:`, err?.message ?? err)
  }
}

/**
 * Get the MIME type for a file based on extension
 */
function getMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase()
  const mimeTypes: Record<string, string> = {
    'html': 'text/html',
    'css': 'text/css',
    'js': 'application/javascript',
    'mjs': 'application/javascript',
    'json': 'application/json',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'svg': 'image/svg+xml',
    'ico': 'image/x-icon',
    'webp': 'image/webp',
    'woff': 'font/woff',
    'woff2': 'font/woff2',
    'ttf': 'font/ttf',
    'eot': 'application/vnd.ms-fontobject',
    'txt': 'text/plain',
    'xml': 'application/xml',
    'map': 'application/json',
  }
  return mimeTypes[ext || ''] || 'application/octet-stream'
}

/**
 * Update the project's publish status. Best-effort: never throws — a DB
 * blip should not abort the publish itself, since the source of truth
 * for "is the published service alive" lives in Knative, not Postgres.
 */
async function setPublishStatus(
  projectId: string,
  status: 'idle' | 'building' | 'uploading' | 'configuring' | 'live' | 'failed',
  errorCode: string | null = null,
): Promise<void> {
  try {
    await prisma.project.update({
      where: { id: projectId },
      data: {
        publishStatus: status as any,
        publishError: errorCode,
        publishStatusAt: new Date(),
      },
    })
  } catch (err: any) {
    console.warn(`[Publish] setPublishStatus(${projectId}, ${status}) failed:`, err.message)
  }
}

/**
 * Acquire / release a publish-in-flight lock on the project's Knative
 * Service via a `shogo.io/publish-in-flight` annotation that carries an
 * absolute unix-ms expiry. The warm-pool GC reads this annotation and
 * defers deletion while a publish is mid-flight, mirroring the existing
 * `shogo.io/active=true` deferral. The TTL ensures a forgotten lock
 * self-heals on the next GC pass.
 */
async function acquirePublishLock(projectId: string): Promise<void> {
  if (!isKubernetes()) return
  try {
    const { mergePatchKnativeService } = await import("../lib/knative-project-manager")
    const namespace = process.env.PROJECT_NAMESPACE || 'shogo-staging-workspaces'
    const serviceName = `project-${projectId}`
    const expiry = String(Date.now() + PUBLISH_IN_FLIGHT_TTL_MS)
    await mergePatchKnativeService(namespace, serviceName, {
      metadata: { annotations: { 'shogo.io/publish-in-flight': expiry } },
    })
  } catch (err: any) {
    // Lock failures are non-fatal: a missing ksvc still means publish
    // proceeds (downstream calls will fail cleanly with their own
    // structured errors), and we'd rather not block publish on a
    // transient k8s API hiccup.
    console.warn(`[Publish] acquirePublishLock(${projectId}) failed:`, err.message)
  }
}

async function releasePublishLock(projectId: string): Promise<void> {
  if (!isKubernetes()) return
  try {
    const { mergePatchKnativeService } = await import("../lib/knative-project-manager")
    const namespace = process.env.PROJECT_NAMESPACE || 'shogo-staging-workspaces'
    const serviceName = `project-${projectId}`
    // null on a merge-patch annotation deletes the key.
    await mergePatchKnativeService(namespace, serviceName, {
      metadata: { annotations: { 'shogo.io/publish-in-flight': null } },
    })
  } catch (err: any) {
    console.warn(`[Publish] releasePublishLock(${projectId}) failed:`, err.message)
  }
}

/**
 * Trigger a build in the runtime pod
 */
async function triggerBuild(projectId: string): Promise<{ success: boolean; error?: string; code?: string }> {
  try {
    const { getProjectPodUrl } = await import("../lib/knative-project-manager")
    const podUrl = await getProjectPodUrl(projectId)
    console.log(`[Publish] Triggering build for project ${projectId} at ${podUrl}`)

    const response = await fetch(`${podUrl}/preview/restart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(PUBLISH_BUILD_TIMEOUT_MS),
    })

    if (!response.ok) {
      const errorText = await response.text()
      return { success: false, code: 'build_failed', error: `Build failed: ${response.status} - ${errorText}` }
    }

    const result = await response.json()
    console.log(`[Publish] Build complete:`, result)
    return { success: true }
  } catch (err: any) {
    const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError'
    if (isTimeout) {
      console.error(`[Publish] Build timed out after ${PUBLISH_BUILD_TIMEOUT_MS}ms for ${projectId}`)
      return {
        success: false,
        code: 'build_timeout',
        error: `Build timed out after ${PUBLISH_BUILD_TIMEOUT_MS / 1000}s — the runtime pod is unresponsive`,
      }
    }
    console.error(`[Publish] Build error:`, err)
    return { success: false, code: 'build_failed', error: err.message || 'Build failed' }
  }
}

/**
 * Download dist/ files from the runtime pod
 */
async function downloadDistFiles(projectId: string): Promise<Map<string, Buffer>> {
  const { getProjectPodUrl } = await import("../lib/knative-project-manager")
  const podUrl = await getProjectPodUrl(projectId)
  const files = new Map<string, Buffer>()

  console.log(`[Publish] Downloading dist files from ${podUrl}`)

  // Endpoint lives under the runtime-owned `/agent/*` namespace (auth-gated
  // via `x-runtime-token`). The previous `/api/dist-files` placement was
  // shadowed by the runtime's `app.all('/api/*')` user-app proxy, so every
  // publish before this fix either got a bare 404 (proxy's no-port branch)
  // or the user app's SPA fallback HTML (which then failed JSON parsing).
  const response = await fetch(`${podUrl}/agent/dist-files`, {
    headers: { 'x-runtime-token': await deriveProjectRuntimeToken(projectId) },
    signal: AbortSignal.timeout(PUBLISH_DOWNLOAD_TIMEOUT_MS),
  })

  if (!response.ok) {
    throw new Error(`Failed to get dist files: ${response.status}`)
  }

  const distFiles = await response.json() as Array<{ path: string; content: string }>

  for (const file of distFiles) {
    const buffer = Buffer.from(file.content, 'base64')
    files.set(file.path, buffer)
  }

  console.log(`[Publish] Downloaded ${files.size} files`)
  return files
}

/**
 * Ask the runtime pod whether this project needs a SERVER-BACKED publish (its
 * server.tsx does real work a static export can't reproduce — DB models or
 * custom routes). Defaults to false (static) on any error so a flaky probe can
 * never silently switch a working static app onto the heavier server path.
 */
async function detectServerBacked(projectId: string): Promise<boolean> {
  try {
    const { getProjectPodUrl } = await import("../lib/knative-project-manager")
    const podUrl = await getProjectPodUrl(projectId)
    const response = await fetch(`${podUrl}/agent/server-info`, {
      headers: { 'x-runtime-token': await deriveProjectRuntimeToken(projectId) },
      signal: AbortSignal.timeout(PUBLISH_DOWNLOAD_TIMEOUT_MS),
    })
    if (!response.ok) {
      console.warn(`[Publish] server-info returned ${response.status} for ${projectId} — treating as static`)
      return false
    }
    const info = (await response.json()) as { serverBacked?: boolean }
    console.log(`[Publish] server-info for ${projectId}:`, info)
    return info.serverBacked === true
  } catch (err: any) {
    console.warn(`[Publish] server-info detection failed for ${projectId} (treating as static):`, err?.message ?? err)
    return false
  }
}

/**
 * Seed the published-data bucket with the project's CURRENT writable state
 * (prisma/dev.db + upload dirs) so a server-backed app boots with the builder's
 * data (e.g. a guest list) instead of an empty DB. Only seeds when no archive
 * exists yet for this subdomain — republishes must NOT clobber writes that
 * end users have accumulated since the first publish. Best-effort.
 */
async function seedPublishedData(subdomain: string, projectId: string): Promise<void> {
  if (!PUBLISH_DATA_BUCKET) {
    console.warn('[Publish] PUBLISH_DATA_BUCKET unset — skipping published-data seed')
    return
  }
  const key = `${subdomain}/data.tar.gz`
  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: PUBLISH_DATA_BUCKET, Key: key }))
    console.log(`[Publish] published-data archive ${key} already exists — preserving end-user writes`)
    return
  } catch {
    // Not found → seed below.
  }
  try {
    const buf = await fetchDevWritableArchive(projectId)
    if (!buf) {
      console.log(`[Publish] No writable state to seed for ${projectId} (fresh DB on first boot)`)
      return
    }
    await putPublishedArchive(subdomain, buf)
    console.log(`[Publish] Seeded published-data ${key} (${buf.length} bytes)`)
  } catch (err: any) {
    console.warn(`[Publish] seedPublishedData failed for ${projectId} (non-fatal):`, err?.message ?? err)
  }
}

/**
 * Snapshot the dev pod's CURRENT writable state (prisma/dev.db + WAL/SHM +
 * upload dirs) as a gzipped tar. Returns null when the pod reports no writable
 * state yet (fresh/empty DB). Shared by the first-publish seed and the
 * manual dev->live data push.
 */
async function fetchDevWritableArchive(projectId: string): Promise<Buffer | null> {
  const { getProjectPodUrl } = await import("../lib/knative-project-manager")
  const podUrl = await getProjectPodUrl(projectId)
  const response = await fetch(`${podUrl}/agent/published-data-archive`, {
    headers: { 'x-runtime-token': await deriveProjectRuntimeToken(projectId) },
    signal: AbortSignal.timeout(PUBLISH_DOWNLOAD_TIMEOUT_MS),
  })
  if (response.status === 404) return null
  if (!response.ok) {
    throw new Error(`published-data-archive returned ${response.status}`)
  }
  const { archive } = (await response.json()) as { archive?: string }
  if (!archive) return null
  return Buffer.from(archive, 'base64')
}

/** Upload a writable-state archive to the published-data bucket for `subdomain`. */
async function putPublishedArchive(subdomain: string, buf: Buffer): Promise<void> {
  await s3Client.send(new PutObjectCommand({
    Bucket: PUBLISH_DATA_BUCKET,
    Key: `${subdomain}/data.tar.gz`,
    Body: buf,
    ContentType: 'application/gzip',
    CacheControl: 'no-store',
  }))
}

/**
 * Copy the current live archive to a timestamped backup key so a dev->live
 * push is reversible. Returns the backup key, or null when there's no live
 * archive to back up yet.
 */
async function backupPublishedArchive(subdomain: string): Promise<string | null> {
  const srcKey = `${subdomain}/data.tar.gz`
  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: PUBLISH_DATA_BUCKET, Key: srcKey }))
  } catch {
    return null
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const destKey = `${subdomain}/backups/data-${ts}.tar.gz`
  await s3Client.send(new CopyObjectCommand({
    Bucket: PUBLISH_DATA_BUCKET,
    CopySource: encodeURI(`${PUBLISH_DATA_BUCKET}/${srcKey}`),
    Key: destKey,
  }))
  return destKey
}

/** Best-effort read of a pod's normalized `prisma/schema.prisma` fingerprint. */
async function fetchSchemaFingerprint(podUrl: string, projectId: string): Promise<string | null> {
  try {
    const res = await fetch(`${podUrl}/agent/schema-fingerprint`, {
      headers: { 'x-runtime-token': await deriveProjectRuntimeToken(projectId) },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    const { hash } = (await res.json()) as { hash?: string | null }
    return hash ?? null
  } catch {
    return null
  }
}

interface PushDataResult {
  ok: boolean
  status?: number
  code?: string
  message?: string
  bytes?: number
  backupKey?: string | null
  schemaMismatch?: boolean
}

/**
 * Push the builder's current dev database (+ upload dirs) up to the live,
 * server-backed published app — the manual "sync dev data to the published
 * version" workflow. Full snapshot REPLACE (not a merge): the live writable
 * state is backed up, then overwritten with the dev snapshot.
 *
 * Safety:
 *   - Backs up the current live archive to `{subdomain}/backups/data-{ts}.tar.gz`
 *     so the replace is reversible.
 *   - Disarms a running published writer first (suspend) so its interval /
 *     shutdown flush can't clobber the fresh push. Only when warm — a
 *     scaled-to-zero app has no writer, and we must not wake it through the
 *     activator just to suspend it.
 *   - Guards against schema drift: if the published pod is warm and its schema
 *     fingerprint differs from dev's, refuse unless `force` (the caller surfaces
 *     a "republish first, or push anyway" choice).
 *
 * Rolls a new published revision at the end so the pod re-hydrates from the
 * pushed archive.
 */
async function pushPublishedData(
  projectId: string,
  subdomain: string,
  opts: { force?: boolean } = {},
): Promise<PushDataResult> {
  if (!PUBLISH_DATA_BUCKET) {
    return { ok: false, status: 503, code: "data_bucket_unset", message: "Published-data storage is not configured." }
  }

  // 1. Snapshot the dev database. Bail early if there's nothing to push.
  let devArchive: Buffer | null
  try {
    devArchive = await fetchDevWritableArchive(projectId)
  } catch (err: any) {
    return { ok: false, status: 502, code: "dev_snapshot_failed", message: `Could not read the dev database: ${err?.message ?? err}` }
  }
  if (!devArchive) {
    return { ok: false, status: 400, code: "no_dev_data", message: "The dev project has no database to push yet." }
  }

  const { getKnativeProjectManager, getProjectPodUrl } = await import("../lib/knative-project-manager")
  const manager = getKnativeProjectManager()

  // Only touch the published pod (schema check / suspend) when it's actually
  // running — reaching it while scaled to zero would cold-start it through the
  // activator for no reason and spawn an un-suspended writer.
  let publishedWarm = false
  try {
    const status = await manager.getServiceStatus(`published-${projectId}`, projectId)
    publishedWarm = status.exists && status.ready && status.replicas > 0
  } catch (err: any) {
    console.warn(`[Publish] Could not read published service status for ${projectId}:`, err?.message ?? err)
  }

  // 2. Schema-drift guard (best-effort, warm pod only).
  let schemaMismatch = false
  if (publishedWarm) {
    try {
      const [devHash, pubHash] = await Promise.all([
        fetchSchemaFingerprint(await getProjectPodUrl(projectId), projectId),
        fetchSchemaFingerprint(manager.publishedServiceUrl(projectId), projectId),
      ])
      schemaMismatch = !!(devHash && pubHash && devHash !== pubHash)
    } catch (err: any) {
      console.warn(`[Publish] Schema fingerprint check failed for ${projectId} (continuing):`, err?.message ?? err)
    }
    if (schemaMismatch && !opts.force) {
      return {
        ok: false,
        status: 409,
        code: "schema_mismatch",
        message: "Your dev database schema differs from the published app. Publish your latest changes first, or push anyway.",
        schemaMismatch: true,
      }
    }
  }

  // 3. Disarm the running writer so it can't overwrite the fresh push.
  if (publishedWarm) {
    try {
      const res = await fetch(`${manager.publishedServiceUrl(projectId)}/agent/published-data/suspend`, {
        method: "POST",
        headers: { 'x-runtime-token': await deriveProjectRuntimeToken(projectId) },
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) console.warn(`[Publish] suspend published writer returned ${res.status} for ${projectId}`)
    } catch (err: any) {
      console.warn(`[Publish] Failed to suspend published writer for ${projectId} (continuing):`, err?.message ?? err)
    }
  }

  // 4. Back up the current live archive (reversible replace).
  let backupKey: string | null = null
  try {
    backupKey = await backupPublishedArchive(subdomain)
  } catch (err: any) {
    console.warn(`[Publish] Failed to back up live archive for ${subdomain} (continuing):`, err?.message ?? err)
  }

  // 5. Overwrite the live archive with the dev snapshot.
  await putPublishedArchive(subdomain, devArchive)
  console.log(`[Publish] Pushed dev data to ${subdomain}/data.tar.gz (${devArchive.length} bytes, backup=${backupKey ?? "none"})`)

  // 6. Roll a new revision so the pod re-hydrates from the pushed archive.
  try {
    await manager.forcePublishedRevision(projectId)
  } catch (err: any) {
    console.warn(`[Publish] Failed to force published revision for ${projectId} (data pushed, reload pending):`, err?.message ?? err)
  }

  return { ok: true, bytes: devArchive.length, backupKey, schemaMismatch }
}

/**
 * Provision the right published service for a project: a server-backed
 * Knative pod (running server.tsx) when the app needs a backend, else the
 * static nginx service. Either way the `{subdomain}.shogo.one` DomainMapping
 * is (re)created and the SERVER_BACKED Worker KV flag is set/cleared so the
 * edge routes `/api/*` correctly. Shared by publish + republish.
 */
async function configurePublishedService(
  projectId: string,
  subdomain: string,
  opts?: { alwaysOn?: boolean },
): Promise<{ serverBacked: boolean }> {
  const { getKnativeProjectManager } = await import("../lib/knative-project-manager")
  const { setServerBackedFlag, clearServerBackedFlag } = await import("../lib/cloudflare-server-backed-kv")
  const manager = getKnativeProjectManager()

  const serverBacked = await detectServerBacked(projectId)
  // Always-on keeps a warm replica for BOTH service types so the first visit
  // after idle never pays a cold start. A static app keeps a (much cheaper)
  // nginx pod warm; a server-backed app keeps the heavier runtime pod warm.
  const minScale = opts?.alwaysOn ? 1 : 0
  if (serverBacked) {
    const serviceUrl = await manager.createPublishedServerService(projectId, subdomain, { minScale })
    console.log(`[Publish] Server-backed published service ready: ${serviceUrl} (min-scale=${minScale})`)
    await manager.createPublishedDomainMapping(subdomain, projectId)
    await seedPublishedData(subdomain, projectId)
    await setServerBackedFlag(subdomain)
  } else {
    const serviceUrl = await manager.createPublishedService(projectId, subdomain, { minScale })
    console.log(`[Publish] Static published service ready: ${serviceUrl}`)
    await manager.createPublishedDomainMapping(subdomain, projectId)
    await clearServerBackedFlag(subdomain)
  }
  return { serverBacked }
}

/**
 * Force the runtime pod to flush its git sync so the published source is
 * committed + pushed into the durable repo before we tag HEAD. Best-effort
 * — a pod in legacy `s3` mode (or with git sync inactive) returns
 * `flushed:false` and we fall back to whatever HEAD the durable repo
 * already holds. Never throws; the publish must still proceed.
 */
async function flushGitSync(
  projectId: string,
  opts: {
    tags?: Array<{ name: string; message?: string; force?: boolean }>
    deleteTags?: string[]
  } = {},
): Promise<{ sha: string | null } | null> {
  try {
    const { getProjectPodUrl } = await import("../lib/knative-project-manager")
    const podUrl = await getProjectPodUrl(projectId)
    const response = await fetch(`${podUrl}/agent/git-flush`, {
      method: 'POST',
      headers: {
        'x-runtime-token': await deriveProjectRuntimeToken(projectId),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ tags: opts.tags, deleteTags: opts.deleteTags }),
      signal: AbortSignal.timeout(PUBLISH_BUILD_TIMEOUT_MS),
    })
    if (!response.ok) {
      console.warn(`[Publish] git-flush returned ${response.status} for ${projectId} (continuing)`)
      return null
    }
    const result = await response.json().catch(() => ({})) as { sha?: string }
    console.log(`[Publish] git-flush for ${projectId}:`, result)
    return { sha: result.sha ?? null }
  } catch (err: any) {
    console.warn(`[Publish] git-flush failed for ${projectId} (continuing):`, err?.message ?? err)
    return null
  }
}

/**
 * Mark the published commit with git tags so a publish is a traceable point in
 * the project's history (visible in the commit graph as `tag:` decorations) and
 * the graph/UI can resolve "what's live" git-natively.
 *
 * Two tags are written at HEAD:
 *   - `publish/<subdomain>/<unix-ts>`  immutable, per-deploy history entry
 *   - `published/<subdomain>`          stable moving pointer at the LIVE commit
 *     (force-updated each publish; the graph resolves the live node from this)
 *
 * `deletePointerSubdomains` removes stale `published/<old>` pointers in the same
 * round trip (used when a project changes its subdomain).
 *
 * Pod-owned model: the pod owns the durable repo, so tags are created AND
 * persisted by the pod inside `/agent/git-flush` (we pass the tag names and
 * read back the resulting HEAD sha). The API just records the result; the tags
 * show up in the graph on the API's next read-hydrate. Best-effort — a failure
 * here must not fail an otherwise-successful publish.
 */
async function tagPublishedCommit(
  projectId: string,
  subdomain: string,
  opts: { deletePointerSubdomains?: string[] } = {},
): Promise<{ sha: string; tag: string; pointerTag: string } | null> {
  const tag = `publish/${subdomain}/${Math.floor(Date.now() / 1000)}`
  const pointerTag = `published/${subdomain}`
  const deleteTags = (opts.deletePointerSubdomains ?? [])
    .filter((s) => s && s !== subdomain)
    .map((s) => `published/${s}`)
  const result = await flushGitSync(projectId, {
    tags: [
      { name: tag, message: `Published ${subdomain}.${PUBLISH_DOMAIN}` },
      { name: pointerTag, message: `Live: ${subdomain}.${PUBLISH_DOMAIN}`, force: true },
    ],
    ...(deleteTags.length ? { deleteTags } : {}),
  })
  if (!result?.sha) {
    console.warn(`[Publish] No HEAD to tag for ${projectId} (pod git sync inactive or repo empty?)`)
    return null
  }
  console.log(`[Publish] Tagged ${projectId} HEAD ${result.sha.slice(0, 8)} as ${tag} + ${pointerTag}`)
  return { sha: result.sha, tag, pointerTag }
}

/**
 * Best-effort removal of the stable `published/<subdomain>` pointer tag (the
 * immutable `publish/<subdomain>/<ts>` history tags are intentionally kept).
 * Used on unpublish so the graph stops marking any commit as live.
 */
async function deletePublishPointer(projectId: string, subdomain: string): Promise<void> {
  await flushGitSync(projectId, { deleteTags: [`published/${subdomain}`] })
}

/**
 * Upload files to S3 bucket under the subdomain prefix
 */
async function uploadToS3(subdomain: string, files: Map<string, Buffer>): Promise<void> {
  // Hard-fail in K8s mode if the overlay forgot to set PUBLISH_BUCKET
  // — silently uploading to the LOCAL-DEV fallback would land prod
  // content in a non-existent bucket (or worse, the wrong env's bucket
  // if the name happened to collide). See the long comment on
  // PUBLISH_BUCKET above for the 2026-05-26 incident.
  if (isKubernetes() && !process.env.PUBLISH_BUCKET) {
    throw new Error(
      "PUBLISH_BUCKET env var is not set. The api ksvc overlay must set " +
      "this explicitly to the OCI Object Storage bucket the *.shogo.one " +
      "Cloudflare Worker reads from " +
      "(`shogo-published-apps-${environment}` per " +
      "terraform/modules/publish-hosting-oci). Refusing to upload " +
      "without it.",
    )
  }
  console.log(`[Publish] Uploading ${files.size} files to S3 bucket ${PUBLISH_BUCKET}/${subdomain}/`)
  
  for (const [filePath, content] of files) {
    const key = `${subdomain}/${filePath}`
    const contentType = getMimeType(filePath)
    
    await s3Client.send(new PutObjectCommand({
      Bucket: PUBLISH_BUCKET,
      Key: key,
      Body: content,
      ContentType: contentType,
      CacheControl: filePath === 'index.html' ? 'max-age=0, must-revalidate' : 'max-age=31536000, immutable',
    }))
  }
  
  console.log(`[Publish] Upload complete`)
}

/**
 * Delete all files for a subdomain from S3
 */
async function deleteFromS3(subdomain: string): Promise<void> {
  console.log(`[Publish] Deleting files for subdomain ${subdomain} from S3`)
  
  // List all objects with the subdomain prefix
  const listResponse = await s3Client.send(new ListObjectsV2Command({
    Bucket: PUBLISH_BUCKET,
    Prefix: `${subdomain}/`,
  }))
  
  if (!listResponse.Contents || listResponse.Contents.length === 0) {
    console.log(`[Publish] No files found for subdomain ${subdomain}`)
    return
  }
  
  // Delete all objects
  const objects = listResponse.Contents.map(obj => ({ Key: obj.Key! }))
  await s3Client.send(new DeleteObjectsCommand({
    Bucket: PUBLISH_BUCKET,
    Delete: { Objects: objects },
  }))
  
  console.log(`[Publish] Deleted ${objects.length} files`)
}

/**
 * Options for {@link publishProject}. `subdomain` is required (the caller must
 * have decided/confirmed it). Everything else mirrors the publish request body.
 */
export interface PublishProjectOptions {
  subdomain: string
  accessLevel?: AccessLevel
  password?: string
  siteTitle?: string
  siteDescription?: string
}

/**
 * Result of {@link publishProject}. `ok` distinguishes success from a mapped
 * error so HTTP callers can `c.json({ error }, status)` and non-HTTP callers
 * (the agent's internal publish route) can branch without parsing a Response.
 */
export interface PublishProjectResult {
  ok: boolean
  status: number
  url?: string
  subdomain?: string
  publishedAt?: number
  accessLevel?: AccessLevel
  hasPassword?: boolean
  code?: string
  message?: string
}

/**
 * Core publish pipeline shared by the session-authenticated route
 * (POST /api/projects/:id/publish) and the internal/runtime route
 * (POST /api/internal/projects/:id/publish, used by the agent's publish tool).
 *
 * Validates the subdomain + access level, builds/downloads/uploads the dist,
 * provisions the published Knative service + DomainMapping, tags the commit,
 * records a checkpoint, and persists publish state — preserving the exact error
 * codes/statuses the route previously returned.
 */
export async function publishProject(
  projectId: string,
  opts: PublishProjectOptions,
): Promise<PublishProjectResult> {
  try {
    const { subdomain: rawSubdomain, accessLevel = "anyone", password, siteTitle, siteDescription } = opts
    const subdomain = rawSubdomain.toLowerCase()

    const validation = validateSubdomain(subdomain)
    if (!validation.valid) {
      return { ok: false, status: 400, code: "invalid_subdomain", message: validation.reason }
    }

    if (!ACCESS_LEVELS.has(accessLevel)) {
      return { ok: false, status: 400, code: "invalid_access_level", message: `Unknown access level: ${accessLevel}` }
    }

    // Get the project
    const project = await prisma.project.findUnique({
      where: { id: projectId },
    })
    if (!project) {
      return { ok: false, status: 404, code: "project_not_found", message: "Project not found" }
    }

    // Subdomain publishing is gated to Pro+. Only gate a first publish or a
    // subdomain change — republishing the same subdomain stays allowed so a
    // workspace that downgraded keeps a live site updatable.
    if (project.publishedSubdomain !== subdomain) {
      const { canPublishSubdomain } = await import("../services/billing.service")
      if (!(await canPublishSubdomain(project.workspaceId))) {
        return {
          ok: false,
          status: 402,
          code: "plan_not_allowed",
          message: "Publishing to a subdomain is available on Pro and higher plans. Upgrade to publish.",
        }
      }
    }

    // Check if subdomain is available (unless it's the same project's subdomain)
    if (project.publishedSubdomain !== subdomain) {
      const existingProject = await prisma.project.findUnique({
        where: { publishedSubdomain: subdomain },
        select: { id: true },
      })

      if (existingProject) {
        return { ok: false, status: 409, code: "subdomain_taken", message: "Subdomain is already in use" }
      }
    }

    // If project already has a different subdomain, clean up old S3 files
    if (project.publishedSubdomain && project.publishedSubdomain !== subdomain) {
      try {
        await deleteFromS3(project.publishedSubdomain)
      } catch (err) {
        console.warn("[Publish] Failed to delete old S3 files:", err)
      }
    }

    // Resolve the password-gate hash before doing any expensive build work so
    // bad input (missing/short password) fails fast with a 400.
    const sitePassword = resolveSitePasswordHash({
      accessLevel,
      password,
      subdomain,
      existingHash: (project as any).sitePasswordHash ?? null,
      existingSubdomain: project.publishedSubdomain ?? null,
    })
    if (!sitePassword.ok) {
      return { ok: false, status: 400, code: sitePassword.code, message: sitePassword.message }
    }

    // Resolve the always-on intent for this (re)publish: honor the saved
    // flag, but re-validate entitlement so a downgrade / seat removal since
    // the last toggle clamps the app back to scale-to-zero. Applies to both
    // static and server-backed apps.
    let alwaysOn = (project as any).publishedAlwaysOn === true
    if (alwaysOn) {
      const { canEnableAlwaysOn } = await import("../services/billing.service")
      const gate = await canEnableAlwaysOn(project.workspaceId, projectId)
      if (!gate.allowed) {
        console.warn(
          `[Publish] always-on no longer entitled for ${projectId} (${gate.used}/${gate.allowance}) — clamping off`,
        )
        alwaysOn = false
      }
    }

    // In Kubernetes: Build, download, and upload to S3
    if (isKubernetes()) {
      // Hold the publish-in-flight lock for the entire pipeline so the
      // warm-pool GC can't yank the runtime ksvc out from under us.
      await acquirePublishLock(projectId)
      try {
        // Step 1: Trigger build
        await setPublishStatus(projectId, 'building')
        const buildResult = await triggerBuild(projectId)
        if (!buildResult.success) {
          await setPublishStatus(projectId, 'failed', buildResult.code || 'build_failed')
          return { ok: false, status: 500, code: buildResult.code || "build_failed", message: buildResult.error || "Build failed" }
        }

        // Step 2: Download dist files
        let files: Map<string, Buffer>
        try {
          files = await downloadDistFiles(projectId)
        } catch (err: any) {
          console.error("[Publish] Failed to download dist files:", err)
          const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError'
          const code = isTimeout ? 'download_timeout' : 'download_failed'
          await setPublishStatus(projectId, 'failed', code)
          return { ok: false, status: 500, code, message: err.message || "Failed to download build files" }
        }

        if (files.size === 0) {
          await setPublishStatus(projectId, 'failed', 'no_files')
          return { ok: false, status: 400, code: "no_files", message: "No files to publish - build may have failed" }
        }

        // Step 3: Upload to S3
        await setPublishStatus(projectId, 'uploading')
        try {
          await uploadToS3(subdomain, files)
        } catch (err: any) {
          console.error("[Publish] Failed to upload to S3:", err)
          await setPublishStatus(projectId, 'failed', 'upload_failed')
          return { ok: false, status: 500, code: "upload_failed", message: err.message || "Failed to upload to S3" }
        }

        // Step 4+5: Provision the published service (server-backed pod OR
        // static nginx), its DomainMapping, and the SERVER_BACKED edge flag.
        await setPublishStatus(projectId, 'configuring')
        try {
          await configurePublishedService(projectId, subdomain, { alwaysOn })
        } catch (err: any) {
          console.warn("[Publish] Published service/DomainMapping creation failed:", err.message)
          await setPublishStatus(projectId, 'failed', 'configure_failed')
          return { ok: false, status: 500, code: "configure_failed", message: err.message || "Failed to configure published service" }
        }
      } finally {
        // Always release the lock, even on a thrown error path. The
        // 10-min TTL is a backstop, not the primary release mechanism.
        await releasePublishLock(projectId)
      }
    } else {
      // Local development: Just log and update database
      console.log(`[Publish] Local mode - would publish to ${subdomain}.${PUBLISH_DOMAIN}`)
    }

    // Tag the published commit in the durable git repo: a timestamped
    // history tag plus the stable `published/<subdomain>` pointer the graph
    // resolves "what's live" from. On a subdomain change we also drop the old
    // `published/<oldSubdomain>` pointer in the same round trip. Tagging
    // flushes the pod's git sync and hydrates the durable repo here.
    const previousSubdomain =
      project.publishedSubdomain && project.publishedSubdomain !== subdomain
        ? project.publishedSubdomain
        : undefined
    const tagged = await tagPublishedCommit(projectId, subdomain, {
      deletePointerSubdomains: previousSubdomain ? [previousSubdomain] : [],
    })

    // Update project with publish info
    const publishedAt = new Date()
    await prisma.project.update({
      where: { id: projectId },
      data: {
        publishedSubdomain: subdomain,
        publishedAt,
        publishStatus: 'live' as any,
        publishError: null,
        publishStatusAt: publishedAt,
        accessLevel: accessLevel as any,
        sitePasswordHash: sitePassword.hash,
        siteTitle,
        siteDescription,
        publishedAlwaysOn: alwaysOn,
        ...(tagged && { publishedCommitSha: tagged.sha, publishedTag: tagged.tag }),
      } as any,
    })

    // Reflect the password gate to the edge. On a subdomain change also clear
    // the old subdomain's gate (its hash was salted with the old subdomain).
    if (previousSubdomain) await clearSitePassword(previousSubdomain)
    await syncSitePasswordKv(subdomain, accessLevel, sitePassword.hash)

    // Record the live commit as a checkpoint so "what's live" is a real,
    // rollback-able point in history (idempotent on commitSha). Best-effort.
    if (tagged?.sha) {
      try {
        await recordCheckpointForCommit(projectId, tagged.sha, {
          name: `Published to ${subdomain}`,
          commitMessage: `Published ${subdomain}.${PUBLISH_DOMAIN}`,
          isAutomatic: true,
        })
      } catch (err: any) {
        console.warn(`[Publish] Failed to record publish checkpoint for ${projectId}:`, err?.message ?? err)
      }
    }

    // Point any already-active custom domains at the (possibly new)
    // subdomain prefix in the Worker's routing map.
    await syncCustomDomainKv(projectId, subdomain)

    // Auto-capture thumbnail after publish (fire-and-forget, delayed to let CDN propagate)
    setTimeout(() => {
      captureThumbnail(projectId, `https://${subdomain}.${PUBLISH_DOMAIN}`).catch((err) => {
        console.warn('[Publish] Auto-thumbnail failed (non-blocking):', err.message)
      })
    }, 5000)

    return {
      ok: true,
      status: 200,
      url: `https://${subdomain}.${PUBLISH_DOMAIN}`,
      subdomain,
      publishedAt: publishedAt.getTime(),
      accessLevel,
      hasPassword: !!sitePassword.hash,
    }
  } catch (error: any) {
    console.error("[Publish] Publish error:", error)
    try {
      await setPublishStatus(projectId, 'failed', 'publish_failed')
    } catch {}
    return { ok: false, status: 500, code: "publish_failed", message: error.message }
  }
}

/**
 * Create publish routes
 */
export function publishRoutes() {
  const router = new Hono()

  // Local/desktop mode: publishing has no local hosting pipeline, so forward to
  // Shogo Cloud when the project is cloud-linked and a cloud key is connected.
  // Reads (GET) for local-only projects fall through to the local DB so the
  // publish panel still renders; writes are blocked with an actionable error
  // instead of the old fake-success stub. No-op in the cloud API (where
  // SHOGO_LOCAL_MODE is unset), so the real pipeline below runs there.
  router.use("*", async (c, next) => {
    if (process.env.SHOGO_LOCAL_MODE !== "true") return next()

    const method = c.req.method
    const isWrite = method !== "GET" && method !== "HEAD"
    // The router runs with the `/api` prefix stripped: /projects/:id/... .
    const projectId = c.req.path.match(/^\/projects\/([^/]+)/)?.[1]

    if (projectId) {
      const linked = await isProjectCloudLinked(projectId)
      if (!linked) {
        if (isWrite) {
          return c.json(
            {
              error: {
                code: "project_not_synced",
                message: "Sync this project to Shogo Cloud before publishing.",
              },
            },
            409,
          )
        }
        return next()
      }
    }

    const cloudKey = await getUpstreamCredential()
    if (!cloudKey) {
      if (isWrite) {
        return c.json(
          {
            error: {
              code: "cloud_signin_required",
              message: "Sign in to Shogo Cloud to publish.",
            },
          },
          503,
        )
      }
      return next()
    }

    return proxyPublishToCloud(c, cloudKey)
  })

  /**
   * GET /subdomains/:subdomain/check - Check subdomain availability
   */
  router.get("/subdomains/:subdomain/check", async (c) => {
    try {
      const subdomain = c.req.param("subdomain").toLowerCase()

      const validation = validateSubdomain(subdomain)
      if (!validation.valid) {
        return c.json({ available: false, reason: validation.reason }, 200)
      }

      // Check if already taken by another project
      const existingProject = await prisma.project.findUnique({
        where: { publishedSubdomain: subdomain },
        select: { id: true },
      })

      if (existingProject) {
        return c.json({ available: false, reason: "Subdomain is already in use" }, 200)
      }

      return c.json({ available: true }, 200)
    } catch (error: any) {
      console.error("[Publish] Check subdomain error:", error)
      return c.json({ error: { code: "check_failed", message: error.message } }, 500)
    }
  })

  /**
   * GET /projects/:projectId/publish - Current publish state for the panel.
   * Returns null-ish fields when the project has never been published.
   */
  router.get("/projects/:projectId/publish", async (c) => {
    try {
      const projectId = c.req.param("projectId")
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: {
          workspaceId: true,
          publishedSubdomain: true,
          publishedAt: true,
          accessLevel: true,
          sitePasswordHash: true,
          siteTitle: true,
          siteDescription: true,
          publishStatus: true,
          publishedCommitSha: true,
          publishedTag: true,
          publishedAlwaysOn: true,
        } as any,
      }) as (Record<string, any>) | null
      if (!project) {
        return c.json({ error: { code: "project_not_found", message: "Project not found" } }, 404)
      }

      // Always-on surface: the slot meter (pooled per workspace) and whether
      // this app can use it at all (server-backed). `serverBacked` is read from
      // the edge KV flag (fast, no pod cold start); in local/unconfigured mode
      // we default it on so the toggle is testable.
      const { getAlwaysOnAllowanceForWorkspace, countAlwaysOnUsed, canPublishSubdomain } = await import("../services/billing.service")
      const { getServerBackedFlag } = await import("../lib/cloudflare-server-backed-kv")
      const [alwaysOnAllowance, alwaysOnUsed, serverBackedFlag, canPublish] = await Promise.all([
        getAlwaysOnAllowanceForWorkspace(project.workspaceId),
        countAlwaysOnUsed(project.workspaceId),
        project.publishedSubdomain
          ? getServerBackedFlag(project.publishedSubdomain)
          : Promise.resolve(null),
        canPublishSubdomain(project.workspaceId),
      ])

      return c.json({
        subdomain: project.publishedSubdomain ?? undefined,
        publishedAt: project.publishedAt ? new Date(project.publishedAt).getTime() : undefined,
        accessLevel: project.accessLevel ?? undefined,
        // Never expose the hash/password; just whether a gate is configured.
        hasPassword: !!project.sitePasswordHash,
        siteTitle: project.siteTitle ?? undefined,
        siteDescription: project.siteDescription ?? undefined,
        publishStatus: project.publishStatus ?? undefined,
        publishedCommitSha: project.publishedCommitSha ?? undefined,
        publishedTag: project.publishedTag ?? undefined,
        alwaysOn: project.publishedAlwaysOn === true,
        // `Infinity` (enterprise/local) is not valid JSON — send null = unlimited.
        alwaysOnAllowance: Number.isFinite(alwaysOnAllowance) ? alwaysOnAllowance : null,
        alwaysOnUsed,
        serverBacked: serverBackedFlag ?? true,
        // Whether the workspace plan (Pro+) may publish to a new subdomain.
        canPublish,
      }, 200)
    } catch (error: any) {
      console.error("[Publish] Get publish state error:", error)
      return c.json({ error: { code: "get_state_failed", message: error.message } }, 500)
    }
  })

  /**
   * POST /projects/:projectId/publish - Publish a project
   */
  router.post("/projects/:projectId/publish", async (c) => {
    const projectId = c.req.param("projectId")
    let body: PublishProjectOptions
    try {
      body = await c.req.json<PublishProjectOptions>()
    } catch {
      return c.json({ error: { code: "invalid_body", message: "Invalid JSON body" } }, 400)
    }

    const result = await publishProject(projectId, body)
    if (!result.ok) {
      return c.json({ error: { code: result.code, message: result.message } }, result.status as any)
    }
    return c.json(
      {
        url: result.url,
        subdomain: result.subdomain,
        publishedAt: result.publishedAt,
        accessLevel: result.accessLevel,
        hasPassword: result.hasPassword,
      },
      200,
    )
  })

  /**
   * POST /projects/:projectId/unpublish - Unpublish a project
   */
  router.post("/projects/:projectId/unpublish", async (c) => {
    try {
      const projectId = c.req.param("projectId")

      const project = await prisma.project.findUnique({
        where: { id: projectId },
      })
      if (!project) {
        return c.json({ error: { code: "project_not_found", message: "Project not found" } }, 404)
      }

      if (!project.publishedSubdomain) {
        return c.json({ error: { code: "not_published", message: "Project is not published" } }, 400)
      }

      // Delete DomainMapping, Knative service, and S3 files
      if (isKubernetes()) {
        try {
          const { getKnativeProjectManager } = await import("../lib/knative-project-manager")
          const manager = getKnativeProjectManager()
          await manager.deletePublishedDomainMapping(project.publishedSubdomain)
          await manager.deletePublishedService(projectId)
          console.log(`[Publish] Published service + DomainMapping deleted for ${projectId}`)
        } catch (err: any) {
          console.warn("[Publish] Failed to delete published service:", err.message)
        }

        // Clear the server-backed edge flag so the Worker stops trying to
        // proxy /api/* for this subdomain. The published-data archive is
        // intentionally kept so a later republish restores end-user writes.
        try {
          const { clearServerBackedFlag } = await import("../lib/cloudflare-server-backed-kv")
          await clearServerBackedFlag(project.publishedSubdomain)
        } catch (err: any) {
          console.warn("[Publish] Failed to clear server-backed flag:", err.message)
        }

        try {
          await deleteFromS3(project.publishedSubdomain)
        } catch (err) {
          console.warn("[Publish] Failed to delete from S3:", err)
        }
      }

      // Drop the password gate so a later (unprotected) republish isn't stuck
      // behind a stale prompt. The hash is also cleared from the DB below.
      await clearSitePassword(project.publishedSubdomain)

      // Stop serving any custom domains (their content is gone). The CF
      // custom hostnames + DB rows are kept so a later republish restores
      // routing via syncCustomDomainKv.
      await clearCustomDomainKv(projectId)

      // Remove the stable `published/<subdomain>` pointer so the graph stops
      // marking any commit as live. The immutable per-deploy history tags are
      // intentionally kept. Best-effort.
      await deletePublishPointer(projectId, project.publishedSubdomain)

      // Clear publish info from project
      await prisma.project.update({
        where: { id: projectId },
        data: {
          publishedSubdomain: null,
          publishedAt: null,
          publishStatus: 'idle' as any,
          publishError: null,
          publishStatusAt: new Date(),
          accessLevel: "anyone",
          sitePasswordHash: null,
          siteTitle: null,
          siteDescription: null,
          publishedCommitSha: null,
          publishedTag: null,
        } as any,
      })

      return c.json({ success: true }, 200)
    } catch (error: any) {
      console.error("[Publish] Unpublish error:", error)
      return c.json({ error: { code: "unpublish_failed", message: error.message } }, 500)
    }
  })

  /**
   * POST /projects/:projectId/republish - Republish with latest changes
   */
  router.post("/projects/:projectId/republish", async (c) => {
    try {
      const projectId = c.req.param("projectId")

      const project = await prisma.project.findUnique({
        where: { id: projectId },
      })
      if (!project) {
        return c.json({ error: { code: "project_not_found", message: "Project not found" } }, 404)
      }

      if (!project.publishedSubdomain) {
        return c.json({ error: { code: "not_published", message: "Project is not published" } }, 400)
      }

      const subdomain = project.publishedSubdomain

      // Re-validate always-on entitlement on each republish (clamp off on a
      // downgrade). Applies to both static and server-backed apps.
      let alwaysOn = (project as any).publishedAlwaysOn === true
      if (alwaysOn) {
        const { canEnableAlwaysOn } = await import("../services/billing.service")
        const gate = await canEnableAlwaysOn(project.workspaceId, projectId)
        if (!gate.allowed) {
          console.warn(
            `[Publish] always-on no longer entitled for ${projectId} (${gate.used}/${gate.allowance}) — clamping off`,
          )
          alwaysOn = false
        }
      }

      if (isKubernetes()) {
        await acquirePublishLock(projectId)
        try {
          await setPublishStatus(projectId, 'building')
          const buildResult = await triggerBuild(projectId)
          if (!buildResult.success) {
            await setPublishStatus(projectId, 'failed', buildResult.code || 'build_failed')
            return c.json({
              error: { code: buildResult.code || "build_failed", message: buildResult.error || "Build failed" }
            }, 500)
          }

          let files: Map<string, Buffer>
          try {
            files = await downloadDistFiles(projectId)
          } catch (err: any) {
            const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError'
            const code = isTimeout ? 'download_timeout' : 'download_failed'
            await setPublishStatus(projectId, 'failed', code)
            return c.json({ error: { code, message: err.message || 'Failed to download build files' } }, 500)
          }

          if (files.size === 0) {
            await setPublishStatus(projectId, 'failed', 'no_files')
            return c.json({
              error: { code: "no_files", message: "No files to publish" }
            }, 400)
          }

          await setPublishStatus(projectId, 'uploading')
          await uploadToS3(subdomain, files)

          // Re-provision the published service. configurePublishedService
          // re-creates the right service type (which bumps the Knative
          // revision / re-syncs content) and handles static<->server-backed
          // transitions, the DomainMapping, and the SERVER_BACKED edge flag.
          // seedPublishedData is a no-op when an archive already exists, so a
          // republish never clobbers accumulated end-user writes.
          await setPublishStatus(projectId, 'configuring')
          try {
            await configurePublishedService(projectId, subdomain, { alwaysOn })
          } catch (err: any) {
            console.warn("[Publish] Failed to reconfigure published service:", err.message)
          }
        } finally {
          await releasePublishLock(projectId)
        }
      }

      // Tag the republished commit in the durable git repo (replaces the
      // old WORKSPACES_DIR-based auto-checkpoint — see the publish handler).
      const tagged = await tagPublishedCommit(projectId, subdomain)

      // Update publishedAt timestamp
      const publishedAt = new Date()
      await prisma.project.update({
        where: { id: projectId },
        data: {
          publishedAt,
          publishStatus: 'live' as any,
          publishError: null,
          publishStatusAt: publishedAt,
          publishedAlwaysOn: alwaysOn,
          ...(tagged && { publishedCommitSha: tagged.sha, publishedTag: tagged.tag }),
        } as any,
      })

      // Record the (new) live commit as a checkpoint, idempotent on commitSha.
      if (tagged?.sha) {
        try {
          await recordCheckpointForCommit(projectId, tagged.sha, {
            name: `Published to ${subdomain}`,
            commitMessage: `Published ${subdomain}.${PUBLISH_DOMAIN}`,
            isAutomatic: true,
          })
        } catch (err: any) {
          console.warn(`[Publish] Failed to record republish checkpoint for ${projectId}:`, err?.message ?? err)
        }
      }

      // Keep custom-domain routing in sync with the republished content.
      await syncCustomDomainKv(projectId, subdomain)

      return c.json({
        url: `https://${subdomain}.${PUBLISH_DOMAIN}`,
        subdomain,
        publishedAt: publishedAt.getTime(),
      }, 200)
    } catch (error: any) {
      console.error("[Publish] Republish error:", error)
      try {
        await setPublishStatus(c.req.param("projectId"), 'failed', 'republish_failed')
      } catch {}
      return c.json({ error: { code: "republish_failed", message: error.message } }, 500)
    }
  })

  /**
   * POST /projects/:projectId/publish/push-data - Push the current dev database
   * up to the live, server-backed published app (full snapshot replace). The
   * builder authors data in dev and clicks this to make it appear on
   * {subdomain}.shogo.one. Pass `{ force: true }` to override the schema-drift
   * guard. Returns the backup key so the replace is reversible.
   */
  router.post("/projects/:projectId/publish/push-data", async (c) => {
    try {
      const projectId = c.req.param("projectId")
      let body: { force?: boolean } = {}
      try {
        body = await c.req.json<{ force?: boolean }>()
      } catch {
        // Empty/invalid body is fine — defaults to a non-forced push.
      }

      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { publishedSubdomain: true },
      })
      if (!project) {
        return c.json({ error: { code: "project_not_found", message: "Project not found" } }, 404)
      }
      if (!project.publishedSubdomain) {
        return c.json({ error: { code: "not_published", message: "Project is not published" } }, 400)
      }
      if (!isKubernetes()) {
        return c.json({ error: { code: "unsupported", message: "Pushing dev data is only available for cloud-published apps." } }, 400)
      }

      const subdomain = project.publishedSubdomain

      // Static apps serve from the edge with no runtime DB — nothing to sync.
      const serverBacked = await detectServerBacked(projectId)
      if (!serverBacked) {
        return c.json({ error: { code: "not_server_backed", message: "This published app is static and has no database to sync." } }, 400)
      }

      const result = await pushPublishedData(projectId, subdomain, { force: body.force === true })
      if (!result.ok) {
        return c.json(
          { error: { code: result.code, message: result.message }, schemaMismatch: result.schemaMismatch },
          (result.status ?? 500) as any,
        )
      }
      return c.json({ success: true, bytes: result.bytes, backupKey: result.backupKey, schemaMismatch: result.schemaMismatch }, 200)
    } catch (error: any) {
      console.error("[Publish] Push data error:", error)
      return c.json({ error: { code: "push_data_failed", message: error.message } }, 500)
    }
  })

  /**
   * PATCH /projects/:projectId/publish - Update publish settings
   */
  router.patch("/projects/:projectId/publish", async (c) => {
    try {
      const projectId = c.req.param("projectId")
      const body = await c.req.json<{
        accessLevel?: AccessLevel
        password?: string
        siteTitle?: string
        siteDescription?: string
        alwaysOn?: boolean
      }>()

      if (body.accessLevel !== undefined && !ACCESS_LEVELS.has(body.accessLevel)) {
        return c.json({ error: { code: "invalid_access_level", message: `Unknown access level: ${body.accessLevel}` } }, 400)
      }

      const project = await prisma.project.findUnique({
        where: { id: projectId },
      })
      if (!project) {
        return c.json({ error: { code: "project_not_found", message: "Project not found" } }, 404)
      }

      if (!project.publishedSubdomain) {
        return c.json({ error: { code: "not_published", message: "Project is not published" } }, 400)
      }

      // Build update object
      const updates: Record<string, any> = {}
      if (body.accessLevel !== undefined) updates.accessLevel = body.accessLevel
      if (body.siteTitle !== undefined) updates.siteTitle = body.siteTitle
      if (body.siteDescription !== undefined) updates.siteDescription = body.siteDescription

      // Resolve the password gate when the access level and/or password change.
      // Subdomain can't change via PATCH, so an existing hash stays valid for a
      // password->password update with no new password (e.g. just toggling
      // site title). `syncPassword` defers the KV write until after the DB
      // update succeeds.
      let syncPassword: { subdomain: string; accessLevel: AccessLevel; hash: string | null } | null = null
      if (body.accessLevel !== undefined || body.password !== undefined) {
        const effectiveAccessLevel = (body.accessLevel ?? (project.accessLevel as AccessLevel)) as AccessLevel
        const resolved = resolveSitePasswordHash({
          accessLevel: effectiveAccessLevel,
          password: body.password,
          subdomain: project.publishedSubdomain,
          existingHash: (project as any).sitePasswordHash ?? null,
          existingSubdomain: project.publishedSubdomain,
        })
        if (!resolved.ok) {
          return c.json({ error: { code: resolved.code, message: resolved.message } }, 400)
        }
        updates.sitePasswordHash = resolved.hash
        syncPassword = { subdomain: project.publishedSubdomain, accessLevel: effectiveAccessLevel, hash: resolved.hash }
      }

      // Always-on toggle: entitlement-gated for both static and server-backed
      // apps. Enforce the workspace slot cap on enable, then flip the live
      // Knative service's min-scale in place (no rebuild).
      if (body.alwaysOn !== undefined) {
        const wantOn = body.alwaysOn === true
        if (wantOn) {
          const { canEnableAlwaysOn } = await import("../services/billing.service")
          const gate = await canEnableAlwaysOn(project.workspaceId, projectId)
          if (!gate.allowed) {
            const code = gate.planAllows ? "slot_exhausted" : "plan_not_allowed"
            const message = gate.planAllows
              ? `You're using all ${gate.allowance} always-on apps on your plan. Upgrade or add a seat to add more.`
              : "Always on is available on Pro and Business plans. Upgrade to enable it."
            return c.json(
              { error: { code, message, allowance: gate.allowance, used: gate.used } },
              402,
            )
          }
        }

        updates.publishedAlwaysOn = wantOn

        // Apply to the live service. Best-effort: the DB flag is the source of
        // truth and the next (re)publish reconciles min-scale regardless.
        if (isKubernetes()) {
          try {
            const { getKnativeProjectManager } = await import("../lib/knative-project-manager")
            await getKnativeProjectManager().setPublishedMinScale(projectId, wantOn ? 1 : 0)
          } catch (err: any) {
            console.warn(
              `[Publish] setPublishedMinScale failed for ${projectId} (flag persisted, will reconcile on republish):`,
              err?.message ?? err,
            )
          }
        }
      }

      let updatedProject = project
      if (Object.keys(updates).length > 0) {
        updatedProject = await prisma.project.update({
          where: { id: projectId },
          data: updates,
        })
      }

      // Reflect the (possibly changed) password gate to the edge after the DB
      // write succeeds.
      if (syncPassword) {
        await syncSitePasswordKv(syncPassword.subdomain, syncPassword.accessLevel, syncPassword.hash)
      }

      return c.json(
        {
          url: `https://${project.publishedSubdomain}.${PUBLISH_DOMAIN}`,
          subdomain: project.publishedSubdomain,
          publishedAt: project.publishedAt?.getTime(),
          accessLevel: updatedProject.accessLevel,
          hasPassword: !!(updatedProject as any).sitePasswordHash,
          siteTitle: updatedProject.siteTitle,
          siteDescription: updatedProject.siteDescription,
          alwaysOn: (updatedProject as any).publishedAlwaysOn === true,
        },
        200
      )
    } catch (error: any) {
      console.error("[Publish] Update publish settings error:", error)
      return c.json({ error: { code: "update_failed", message: error.message } }, 500)
    }
  })

  // ───────────────────────────────────────────────────────────────────────
  // Custom domains (Cloudflare for SaaS — bring-your-own domain)
  // ───────────────────────────────────────────────────────────────────────

  /**
   * GET /projects/:projectId/domains - List a project's custom domains.
   * `enabled` reflects whether Cloudflare for SaaS is configured on this
   * deployment; `fallbackOrigin` is the CNAME target shown to the user.
   */
  router.get("/projects/:projectId/domains", async (c) => {
    try {
      const projectId = c.req.param("projectId")
      const cfg = getCustomHostnamesConfig()
      const domains = (await prisma.customDomain.findMany({
        where: { projectId },
        orderBy: { createdAt: "asc" },
      })) as CustomDomainRowLike[]

      // Opportunistically refresh any non-active row whose persisted status
      // is stale, so the panel is live (records found / cert issued) without
      // waiting on the 60s reconciler cron. Bounded by domains-per-project
      // (a handful) and rate-limited by STALE_READ_MS. Best-effort: a CF/DNS
      // hiccup just serves the last persisted snapshot.
      let rows = domains
      if (cfg) {
        const now = Date.now()
        const stale = domains.filter(
          (d) =>
            d.status !== "active" &&
            d.cfCustomHostnameId &&
            (!d.lastCheckedAt || now - new Date(d.lastCheckedAt).getTime() > STALE_READ_MS),
        )
        if (stale.length > 0) {
          const project = await prisma.project.findUnique({
            where: { id: projectId },
            select: { publishedSubdomain: true },
          })
          const byId = new Map(domains.map((d) => [d.id, d]))
          for (const s of stale) {
            try {
              const { row: updated } = await refreshCustomDomain({
                row: s,
                siblings: domains,
                publishedSubdomain: project?.publishedSubdomain ?? null,
              })
              byId.set(updated.id, updated)
            } catch (err: any) {
              console.warn(
                `[Publish] stale refresh ${s.hostname} failed (non-fatal):`,
                err?.message ?? err,
              )
            }
          }
          rows = domains.map((d) => byId.get(d.id) ?? d)
        }
      }

      return c.json({
        enabled: !!cfg,
        fallbackOrigin: cfg?.fallbackOrigin,
        domains: serializeDomains(rows),
      }, 200)
    } catch (error: any) {
      console.error("[Publish] List custom domains error:", error)
      return c.json({ error: { code: "list_domains_failed", message: error.message } }, 500)
    }
  })

  /**
   * POST /projects/:projectId/domains - Attach a custom domain. Registers a
   * Cloudflare custom hostname and returns the DNS records the user must add.
   *
   * For a bare apex (`acme.com`) or its `www` (`www.acme.com`) we also
   * register the companion so the user gets both halves of the pair in one
   * step, linked by a shared `groupId`, with the `www` variant marked
   * primary (canonical). The other variant 308-redirects to it at the edge.
   * Deeper subdomains (`app.acme.com`) are added standalone. Returns the
   * full group: `{ domains: CustomDomain[] }`.
   */
  router.post("/projects/:projectId/domains", async (c) => {
    try {
      const projectId = c.req.param("projectId")

      if (!getCustomHostnamesConfig()) {
        return c.json({ error: { code: "not_enabled", message: "Custom domains are not enabled on this deployment" } }, 501)
      }

      const body = await c.req.json<{ hostname?: string }>()
      const validation = validateCustomHostname(body.hostname ?? "")
      if (!validation.valid) {
        return c.json({ error: { code: "invalid_hostname", message: validation.reason } }, 400)
      }
      const { hostname } = validation

      const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } })
      if (!project) {
        return c.json({ error: { code: "project_not_found", message: "Project not found" } }, 404)
      }

      // Hostnames are globally unique (one app per domain).
      const existing = await prisma.customDomain.findUnique({ where: { hostname }, select: { projectId: true } })
      if (existing) {
        const mine = existing.projectId === projectId
        return c.json({
          error: {
            code: mine ? "already_added" : "hostname_taken",
            message: mine ? "This domain is already attached to this project" : "This domain is already in use",
          },
        }, 409)
      }

      // Work out the apex<->www pairing (null for non-pairable subdomains).
      const pairing = domainCompanion(hostname)
      const groupId = pairing ? crypto.randomUUID() : null

      // Register the hostname the user actually typed first — this one must
      // succeed (its failure is the user's signal).
      let state: CustomHostnameState
      try {
        state = await createCustomHostname(hostname)
      } catch (err: any) {
        console.error("[Publish] createCustomHostname failed:", err?.message ?? err)
        return c.json({ error: { code: "cloudflare_error", message: err?.message || "Failed to register custom hostname" } }, 502)
      }

      const primaryHostname = pairing?.primaryHostname ?? hostname
      const row = await prisma.customDomain.create({
        data: {
          projectId,
          hostname,
          status: cfStateToStatus(state),
          cfCustomHostnameId: state.id,
          sslStatus: state.sslStatus,
          lastError: state.errors[0] ?? null,
          groupId,
          primary: hostname === primaryHostname,
        },
      })

      const states = new Map<string, CustomHostnameState | null>([[row.id, state]])
      const rows = [row]

      // Best-effort companion registration. If it fails (CF hiccup) or the
      // companion is already taken by another project, we degrade to a
      // single-row group rather than blocking the user's primary add.
      if (pairing) {
        const companionTaken = await prisma.customDomain.findUnique({
          where: { hostname: pairing.companion },
          select: { id: true, projectId: true },
        })
        if (!companionTaken) {
          try {
            const companionState = await createCustomHostname(pairing.companion)
            const companionRow = await prisma.customDomain.create({
              data: {
                projectId,
                hostname: pairing.companion,
                status: cfStateToStatus(companionState),
                cfCustomHostnameId: companionState.id,
                sslStatus: companionState.sslStatus,
                lastError: companionState.errors[0] ?? null,
                groupId,
                primary: pairing.companion === primaryHostname,
              },
            })
            states.set(companionRow.id, companionState)
            rows.push(companionRow)
          } catch (err: any) {
            console.warn(
              `[Publish] companion ${pairing.companion} registration failed (non-fatal):`,
              err?.message ?? err,
            )
          }
        }
      }

      return c.json({ domains: serializeDomains(rows, states) }, 201)
    } catch (error: any) {
      console.error("[Publish] Add custom domain error:", error)
      return c.json({ error: { code: "add_domain_failed", message: error.message } }, 500)
    }
  })

  /**
   * POST /projects/:projectId/domains/:domainId/verify - Re-poll Cloudflare
   * for the whole apex/www group's validation/SSL status, persist it, and
   * (once active) write the Worker KV `hostname -> {subdomain, canonical}`
   * map so the domain serves + redirects. Returns `{ domains: [...] }` for
   * every row in the group so the UI updates both halves at once.
   */
  router.post("/projects/:projectId/domains/:domainId/verify", async (c) => {
    try {
      const projectId = c.req.param("projectId")
      const domainId = c.req.param("domainId")

      const row = await prisma.customDomain.findUnique({ where: { id: domainId } })
      if (!row || row.projectId !== projectId) {
        return c.json({ error: { code: "domain_not_found", message: "Custom domain not found" } }, 404)
      }
      if (!getCustomHostnamesConfig()) {
        return c.json({ error: { code: "not_enabled", message: "Custom domains are not enabled on this deployment" } }, 501)
      }
      if (!row.cfCustomHostnameId) {
        return c.json({ error: { code: "not_registered", message: "Custom hostname was never registered with Cloudflare" } }, 409)
      }

      // Resolve the group (just this row when standalone) and the project's
      // published subdomain once, then refresh every member.
      const groupRows = row.groupId
        ? await prisma.customDomain.findMany({
            where: { projectId, groupId: row.groupId },
            orderBy: { createdAt: "asc" },
          })
        : [row]
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { publishedSubdomain: true },
      })

      const updatedRows: typeof groupRows = []
      const states = new Map<string, CustomHostnameState | null>()
      for (const member of groupRows) {
        const { row: updated, state } = await refreshCustomDomain({
          row: member,
          siblings: groupRows,
          publishedSubdomain: project?.publishedSubdomain ?? null,
        })
        updatedRows.push(updated as (typeof groupRows)[number])
        states.set(updated.id, state)
      }

      return c.json({ domains: serializeDomains(updatedRows, states) }, 200)
    } catch (error: any) {
      console.error("[Publish] Verify custom domain error:", error)
      return c.json({ error: { code: "verify_domain_failed", message: error.message } }, 500)
    }
  })

  /**
   * POST /projects/:projectId/domains/:domainId/retrigger - Manually re-kick
   * Cloudflare DV validation / certificate issuance for a domain that's past
   * the stall threshold (default 30m) with correct DNS. This is the "taking
   * longer than usual" escape hatch (e.g. a slow CA like SSL.com wedged in
   * `processing`) — it re-triggers WITHOUT regenerating tokens, so the user
   * never touches DNS again.
   *
   * Gated server-side (mirrors the panel's button state): refreshes the
   * group first for a fresh status + DNS verdict, then requires enabled, not
   * already active, DNS verified `ok`, age >= stall threshold, and outside
   * the manual cooldown. Returns 409 (`already_active`/`dns_not_ready`/
   * `too_early`), 429 (`cooldown`), or 502 (`cloudflare_error`). On success
   * re-triggers every non-active group member, bumps the counters, and
   * returns the updated group.
   */
  router.post("/projects/:projectId/domains/:domainId/retrigger", async (c) => {
    try {
      const projectId = c.req.param("projectId")
      const domainId = c.req.param("domainId")

      if (!getCustomHostnamesConfig()) {
        return c.json({ error: { code: "not_enabled", message: "Custom domains are not enabled on this deployment" } }, 501)
      }

      const row = (await prisma.customDomain.findUnique({ where: { id: domainId } })) as CustomDomainRowLike | null
      if (!row || row.projectId !== projectId) {
        return c.json({ error: { code: "domain_not_found", message: "Custom domain not found" } }, 404)
      }
      if (!row.cfCustomHostnameId) {
        return c.json({ error: { code: "not_registered", message: "Custom hostname was never registered with Cloudflare" } }, 409)
      }

      const groupRows = row.groupId
        ? ((await prisma.customDomain.findMany({
            where: { projectId, groupId: row.groupId },
            orderBy: { createdAt: "asc" },
          })) as CustomDomainRowLike[])
        : [row]
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { publishedSubdomain: true },
      })

      // Refresh first so the gate decides on the freshest status + DNS verdict.
      const refreshed: CustomDomainRowLike[] = []
      for (const member of groupRows) {
        try {
          const { row: updated } = await refreshCustomDomain({
            row: member,
            siblings: groupRows,
            publishedSubdomain: project?.publishedSubdomain ?? null,
          })
          refreshed.push(updated)
        } catch {
          refreshed.push(member)
        }
      }
      const target = refreshed.find((r) => r.id === row.id) ?? row

      const gate = evaluateRetrigger(target, true)
      if (!gate.allowed) {
        const mins = (ms?: number) => Math.max(1, Math.ceil((ms ?? 0) / 60_000))
        switch (gate.reason) {
          case "active":
            return c.json({ error: { code: "already_active", message: "This domain is already live." } }, 409)
          case "dns_not_ready":
            return c.json({ error: { code: "dns_not_ready", message: "Your DNS records aren't all in place yet. Add the records shown, then retry." } }, 409)
          case "too_early":
            return c.json({ error: { code: "too_early", message: `Give it a bit longer — you can retry in about ${mins(gate.waitMs)} minute(s).` } }, 409)
          case "cooldown":
            return c.json({ error: { code: "cooldown", message: `Just retried — please wait about ${mins(gate.cooldownRemainingMs)} minute(s) before retrying again.` } }, 429)
          default:
            return c.json({ error: { code: "retrigger_not_allowed", message: "Re-trigger isn't available for this domain right now." } }, 409)
        }
      }

      // Re-kick every non-active member, bumping the cooldown/backoff counters.
      const now = new Date()
      for (const member of refreshed) {
        if (member.status === "active" || !member.cfCustomHostnameId) continue
        try {
          await retriggerCustomHostname(member.cfCustomHostnameId)
        } catch (err: any) {
          console.error("[Publish] retriggerCustomHostname failed:", err?.message ?? err)
          return c.json({ error: { code: "cloudflare_error", message: err?.message || "Failed to re-trigger certificate issuance" } }, 502)
        }
        await prisma.customDomain.update({
          where: { id: member.id },
          data: { lastRetriggerAt: now, retriggerCount: { increment: 1 } },
        })
      }

      // Reload so the response carries the bumped counters + last snapshot
      // (issuance won't flip instantly; the cron + UI polling reflect it).
      const finalRows = (await prisma.customDomain.findMany({
        where: { id: { in: refreshed.map((r) => r.id) } },
        orderBy: { createdAt: "asc" },
      })) as CustomDomainRowLike[]

      return c.json({ domains: serializeDomains(finalRows) }, 200)
    } catch (error: any) {
      console.error("[Publish] Retrigger custom domain error:", error)
      return c.json({ error: { code: "retrigger_domain_failed", message: error.message } }, 500)
    }
  })

  /**
   * PATCH /projects/:projectId/domains/:domainId/primary - Make this row the
   * canonical (primary) hostname for its apex/www group; the other variant
   * 308-redirects to it. Re-syncs the group's KV entries so the redirect
   * direction flips immediately. Returns the updated group.
   */
  router.patch("/projects/:projectId/domains/:domainId/primary", async (c) => {
    try {
      const projectId = c.req.param("projectId")
      const domainId = c.req.param("domainId")

      const row = await prisma.customDomain.findUnique({ where: { id: domainId } })
      if (!row || row.projectId !== projectId) {
        return c.json({ error: { code: "domain_not_found", message: "Custom domain not found" } }, 404)
      }
      if (!row.groupId) {
        return c.json({ error: { code: "not_grouped", message: "This domain has no companion to switch with" } }, 409)
      }

      // Flip primary within the group atomically.
      await prisma.$transaction([
        prisma.customDomain.updateMany({
          where: { projectId, groupId: row.groupId },
          data: { primary: false },
        }),
        prisma.customDomain.update({ where: { id: row.id }, data: { primary: true } }),
      ])

      const groupRows = await prisma.customDomain.findMany({
        where: { projectId, groupId: row.groupId },
        orderBy: { createdAt: "asc" },
      })

      // Rewrite KV for every active member so the new canonical takes effect.
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { publishedSubdomain: true },
      })
      if (project?.publishedSubdomain) {
        for (const member of groupRows) {
          if (member.status !== "active") continue
          await putHostnameMapping(
            member.hostname,
            project.publishedSubdomain,
            canonicalForRow(member, groupRows),
          )
        }
      }

      return c.json({ domains: serializeDomains(groupRows) }, 200)
    } catch (error: any) {
      console.error("[Publish] Set primary domain error:", error)
      return c.json({ error: { code: "set_primary_failed", message: error.message } }, 500)
    }
  })

  /**
   * DELETE /projects/:projectId/domains/:domainId - Detach a custom domain
   * (and its apex/www companion if grouped): remove the Cloudflare custom
   * hostname(s) (+ managed cert), the KV mapping(s), and the DB row(s).
   * Returns `{ success, removedIds }`.
   */
  router.delete("/projects/:projectId/domains/:domainId", async (c) => {
    try {
      const projectId = c.req.param("projectId")
      const domainId = c.req.param("domainId")

      const row = await prisma.customDomain.findUnique({ where: { id: domainId } })
      if (!row || row.projectId !== projectId) {
        return c.json({ error: { code: "domain_not_found", message: "Custom domain not found" } }, 404)
      }

      const groupRows = row.groupId
        ? await prisma.customDomain.findMany({ where: { projectId, groupId: row.groupId } })
        : [row]

      for (const member of groupRows) {
        if (member.cfCustomHostnameId) {
          await deleteCustomHostname(member.cfCustomHostnameId)
        }
        await deleteHostnameMapping(member.hostname)
      }
      const removedIds = groupRows.map((d) => d.id)
      await prisma.customDomain.deleteMany({ where: { id: { in: removedIds } } })

      return c.json({ success: true, removedIds }, 200)
    } catch (error: any) {
      console.error("[Publish] Delete custom domain error:", error)
      return c.json({ error: { code: "delete_domain_failed", message: error.message } }, 500)
    }
  })

  return router
}

/**
 * Capture a thumbnail by calling the thumbnail capture endpoint internally.
 */
async function captureThumbnail(projectId: string, url: string): Promise<void> {
  try {
    const port = process.env.API_PORT || '8002'
    await fetch(`http://localhost:${port}/api/projects/${projectId}/thumbnail/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    })
  } catch (err: any) {
    console.warn(`[Thumbnail] Capture failed for ${projectId}:`, err.message)
  }
}

export default publishRoutes
