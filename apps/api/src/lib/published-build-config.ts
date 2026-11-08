// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Pure, env-only configuration for per-commit image builds (SHO-308 §2).
 *
 * Kept dependency-free like `publish-substrate-config.ts` so the publish route,
 * the build service and the tests can all read it without pulling in a k8s
 * client. The rule mirrors the Postgres gate: a cluster that has not been
 * provisioned for builds must keep publishing exactly as it does today rather
 * than failing every server app, and the gate must check *the same* variables
 * the build refuses on, or a half-configured region turns every publish into an
 * error.
 *
 *   PUBLISH_BUILD_REGISTRY   e.g. `us-ashburn-1.ocir.io` — where images are pushed
 *   PUBLISH_BUILD_NAMESPACE  e.g. `axxxxxxxxxxx` — the tenancy namespace
 *   PUBLISH_BUILD_NAMESPACE_K8S / PUBLISH_BUILD_K8S_NAMESPACE
 *                            the cluster namespace the Job runs in (`shogo-builds`)
 *
 * `PUBLISH_BUILD_IMAGES=on|off` forces the decision for a single rollout step,
 * same as `PUBLISH_POSTGRES`.
 */

export interface PublishedBuildConfig {
  registry: string
  namespace: string
  k8sNamespace: string
  registrySecret: string
  builderImage: string
}

export interface PublishedBuildSetup {
  ok: boolean
  config: PublishedBuildConfig | null
  missing: string[]
}

const DEFAULT_K8S_NAMESPACE = 'shogo-builds'
const DEFAULT_REGISTRY_SECRET = 'ocir-push'

export function publishedBuildConfig(): PublishedBuildConfig | null {
  const setup = publishedBuildSetup()
  return setup.ok ? setup.config : null
}

/** The configuration, or the list of variables that are missing. */
export function publishedBuildSetup(): PublishedBuildSetup {
  const registry = (process.env.PUBLISH_BUILD_REGISTRY || '').trim()
  const namespace = (process.env.PUBLISH_BUILD_NAMESPACE || '').trim()
  const builderImage = (process.env.PUBLISH_BUILD_IMAGE || '').trim()
  const missing: string[] = []
  if (!registry) missing.push('PUBLISH_BUILD_REGISTRY')
  if (!namespace) missing.push('PUBLISH_BUILD_NAMESPACE')
  if (!builderImage) missing.push('PUBLISH_BUILD_IMAGE')
  if (missing.length > 0) return { ok: false, config: null, missing }
  return {
    ok: true,
    missing,
    config: {
      registry,
      namespace,
      k8sNamespace:
        (process.env.PUBLISH_BUILD_K8S_NAMESPACE || process.env.PUBLISH_BUILD_NAMESPACE_K8S || '').trim() ||
        DEFAULT_K8S_NAMESPACE,
      registrySecret: (process.env.PUBLISH_BUILD_REGISTRY_SECRET || '').trim() || DEFAULT_REGISTRY_SECRET,
      builderImage,
    },
  }
}

/**
 * Whether a server-backed Knative publish should build (and boot) a per-commit
 * image.
 *
 * Knative-only, because a metal site boots from its VM image and has no
 * per-commit container at all. `PUBLISH_BUILD_IMAGES=off` takes a region back to
 * the shared runtime image without unsetting anything.
 */
export function shouldBuildPublishedImage(substrateKind: 'knative' | 'metal'): boolean {
  if (substrateKind !== 'knative') return false
  const override = (process.env.PUBLISH_BUILD_IMAGES || '').trim().toLowerCase()
  if (override === 'off') return false
  if (override === 'on') return true
  return publishedBuildSetup().ok
}

/**
 * How long the API waits for one per-commit image build before failing the
 * publish.
 *
 * Deliberately NOT `PUBLISH_BUILD_TIMEOUT_MS`: that variable is the *app*
 * build's budget (180s, `publish-timeouts.ts`). Sharing it meant an override
 * aimed at one step silently resized the other.
 */
export function publishedImageBuildTimeoutMs(): number {
  const raw = Number(process.env.PUBLISH_IMAGE_BUILD_TIMEOUT_MS)
  if (Number.isFinite(raw) && raw > 0) return raw
  return 900_000
}

/** How often the API re-reads the Job while it runs. */
export function publishedBuildPollIntervalMs(): number {
  const raw = Number(process.env.PUBLISH_BUILD_POLL_MS)
  if (Number.isFinite(raw) && raw > 0) return raw
  return 3_000
}
