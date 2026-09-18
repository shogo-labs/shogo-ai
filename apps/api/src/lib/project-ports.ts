// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Exposed-ports data model (Phase 3 of the Tier 2 docker project class plan).
 *
 * A project's tech stack DECLARES a fixed set of ports (see
 * `TechStackMeta.runtime.ports` / the mirrored `StackRegistryEntry.ports` in
 * `@shogo/shared-runtime`'s tech-stack registry) — e.g. the `docker-compose`
 * stack declares `8000` (http, the app) and `5432` (tcp, postgres). That list
 * is the ONLY allowlist: a project can change how a declared port is exposed,
 * but can never add a port its stack doesn't list. Two independent surfaces
 * consume a declared port:
 *
 *   - the client-side TCP tunnel (`apps/api/src/lib/port-tunnel-bridge.ts`) —
 *     reachable by anyone with full, authenticated access to the project
 *     (same bar as the IDE/terminal), for ANY declared port regardless of
 *     protocol or visibility.
 *   - the public per-port preview (an unauthenticated HTTP surface, same
 *     trust model as the existing root preview) — reachable ONLY for a
 *     declared `protocol: 'http'` port whose current visibility is
 *     `'preview'`.
 *
 * `visibility` therefore only distinguishes "tunnel-only" from "also public
 * preview" — there is no third "fully closed" state for a declared port,
 * because the tunnel path always requires full project auth regardless.
 * Nothing this project doesn't already trust (a project collaborator) gets
 * new access; the only NEW capability toggled by 'preview' is anonymous
 * public HTTP access, which is why toggling it on is the only thing that
 * needs its own explicit user action.
 *
 * Overrides live in `Project.settings.exposedPorts`, keyed by port number
 * (as a string, since JSON object keys are always strings), holding only the
 * `visibility` override — port/label/protocol always come from the stack's
 * declaration and can't be spoofed by a settings write.
 */

import { getDeclaredPorts } from '@shogo/shared-runtime'

export type PortVisibility = 'tunnel' | 'preview'

export interface ExposedPort {
  port: number
  label?: string
  protocol: 'http' | 'tcp'
  visibility: PortVisibility
}

/** The raw shape stored at `Project.settings.exposedPorts`. */
export type ExposedPortsSettings = Record<string, { visibility?: PortVisibility }>

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Pull `settings.exposedPorts` out defensively — never throws on a malformed value. */
export function readExposedPortsSettings(settings: Record<string, unknown> | null | undefined): ExposedPortsSettings {
  const raw = settings?.exposedPorts
  if (!isPlainObject(raw)) return {}
  const out: ExposedPortsSettings = {}
  for (const [key, value] of Object.entries(raw)) {
    if (isPlainObject(value) && (value.visibility === 'tunnel' || value.visibility === 'preview')) {
      out[key] = { visibility: value.visibility }
    }
  }
  return out
}

/**
 * The project's exposed ports: every port its tech stack declares, with
 * visibility resolved from the settings override (falling back to the
 * stack's `defaultVisibility`). Ports the project's settings mention but the
 * CURRENT tech stack no longer declares are dropped — an override can only
 * ever narrow/widen visibility on a port that still exists.
 */
export function resolveExposedPorts(
  techStackId: string | null | undefined,
  settings: Record<string, unknown> | null | undefined,
): ExposedPort[] {
  const declared = getDeclaredPorts(techStackId) ?? []
  const overrides = readExposedPortsSettings(settings)
  return declared.map((p) => ({
    port: p.port,
    label: p.label,
    protocol: p.protocol,
    visibility: overrides[String(p.port)]?.visibility ?? p.defaultVisibility,
  }))
}

/** True if `port` is one this project's CURRENT tech stack actually declares. */
export function isDeclaredPort(techStackId: string | null | undefined, port: number): boolean {
  return (getDeclaredPorts(techStackId) ?? []).some((p) => p.port === port)
}

/** The declared entry for `port` (protocol + label), or null if undeclared. */
export function getDeclaredPort(
  techStackId: string | null | undefined,
  port: number,
): { port: number; label?: string; protocol: 'http' | 'tcp'; defaultVisibility: PortVisibility } | null {
  return (getDeclaredPorts(techStackId) ?? []).find((p) => p.port === port) ?? null
}

/**
 * Build the new `settings.exposedPorts` object after toggling one port's
 * visibility. Merges into (rather than replaces) any existing overrides so
 * toggling port A never clobbers a prior toggle on port B.
 */
export function withPortVisibility(
  settings: Record<string, unknown> | null | undefined,
  port: number,
  visibility: PortVisibility,
): ExposedPortsSettings {
  const overrides = readExposedPortsSettings(settings)
  return { ...overrides, [String(port)]: { visibility } }
}
