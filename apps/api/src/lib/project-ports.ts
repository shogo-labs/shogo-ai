// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Exposed-ports data model (Phase 3 of the Tier 2 docker project class plan,
 * plus project-declared ports).
 *
 * A project's tech stack DECLARES a default set of ports (see
 * `TechStackMeta.runtime.ports` / `getDeclaredPorts`). The `docker-compose`
 * stack defaults to `8000` (http, the app) and `5432` (tcp, postgres). A
 * project can add more ports of its own. Two surfaces consume an exposed port:
 *
 *   - the client-side TCP tunnel (`apps/api/src/lib/port-tunnel-bridge.ts`) —
 *     reachable by anyone with full, authenticated access to the project,
 *     for ANY exposed port regardless of protocol or visibility.
 *   - the public per-port preview — reachable ONLY for an `http` port whose
 *     visibility is `'preview'`.
 *
 * A newly added port starts as `tunnel`. Switching it to `preview` is the
 * only step that makes the port reachable with no login, so that step needs
 * an explicit user action (Studio toggle, or an agent request the user
 * approves).
 *
 * Settings live at `Project.settings.exposedPorts`, keyed by port number.
 * Stack ports store a visibility override only. Project-added ports also
 * store `source: 'project'`, `protocol`, and an optional `label`.
 */

import { getDeclaredPorts } from '@shogo/shared-runtime'

export type PortVisibility = 'tunnel' | 'preview'
export type PortProtocol = 'http' | 'tcp'

export const MAX_EXPOSED_PORTS = 8

/**
 * Ports the platform itself listens on. A project must not publish these,
 * or the preview proxy becomes a way to reach the runtime and the host agent.
 */
export const DENIED_PORTS = new Set<number>([
  22, // ssh
  8002, // local API
  8012, // Knative queue-proxy
  8080, // agent runtime
  9900, // metal-agent
])

export interface ExposedPort {
  port: number
  label?: string
  protocol: PortProtocol
  visibility: PortVisibility
  /** `'project'` when the project added this port; omitted for stack defaults. */
  source?: 'project'
}

export interface ExposedPortSetting {
  visibility?: PortVisibility
  label?: string
  protocol?: PortProtocol
  source?: 'project'
}

/** The raw shape stored at `Project.settings.exposedPorts`. */
export type ExposedPortsSettings = Record<string, ExposedPortSetting>

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isProtocol(value: unknown): value is PortProtocol {
  return value === 'http' || value === 'tcp'
}

function isVisibility(value: unknown): value is PortVisibility {
  return value === 'tunnel' || value === 'preview'
}

/** Pull `settings.exposedPorts` out defensively — never throws on a malformed value. */
export function readExposedPortsSettings(settings: Record<string, unknown> | null | undefined): ExposedPortsSettings {
  const raw = settings?.exposedPorts
  if (!isPlainObject(raw)) return {}
  const out: ExposedPortsSettings = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!isPlainObject(value)) continue
    const entry: ExposedPortSetting = {}
    if (isVisibility(value.visibility)) entry.visibility = value.visibility
    if (isProtocol(value.protocol)) entry.protocol = value.protocol
    if (typeof value.label === 'string' && value.label.trim()) entry.label = value.label.trim().slice(0, 40)
    if (value.source === 'project') entry.source = 'project'
    if (!entry.visibility && !(entry.source === 'project' && entry.protocol)) continue
    out[key] = entry
  }
  return out
}

/**
 * Why a project-added port is rejected, or null when it is allowed.
 * Stack-declared ports are not passed through this check.
 */
export function projectPortError(port: number): string | null {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return 'Port must be an integer between 1024 and 65535'
  }
  if (DENIED_PORTS.has(port)) {
    return `Port ${port} is reserved by the Shogo runtime`
  }
  return null
}

/**
 * The project's exposed ports: every port its tech stack declares, plus
 * project-added ports (`source: 'project'`). Visibility falls back to the
 * stack default, or `tunnel` for a port the project added.
 */
export function resolveExposedPorts(
  techStackId: string | null | undefined,
  settings: Record<string, unknown> | null | undefined,
): ExposedPort[] {
  const declared = getDeclaredPorts(techStackId) ?? []
  const overrides = readExposedPortsSettings(settings)
  const ports: ExposedPort[] = declared.map((p) => ({
    port: p.port,
    label: overrides[String(p.port)]?.label ?? p.label,
    protocol: p.protocol,
    visibility: overrides[String(p.port)]?.visibility ?? p.defaultVisibility,
  }))
  const seen = new Set(ports.map((p) => p.port))
  for (const [key, entry] of Object.entries(overrides)) {
    if (entry.source !== 'project' || !entry.protocol) continue
    const port = Number(key)
    if (!Number.isInteger(port) || seen.has(port) || projectPortError(port)) continue
    if (entry.visibility === 'preview' && entry.protocol !== 'http') continue
    ports.push({
      port,
      label: entry.label,
      protocol: entry.protocol,
      visibility: entry.visibility ?? 'tunnel',
      source: 'project',
    })
    seen.add(port)
  }
  return ports.slice(0, MAX_EXPOSED_PORTS)
}

/** True if `port` is one this project's CURRENT tech stack actually declares. */
export function isDeclaredPort(techStackId: string | null | undefined, port: number): boolean {
  return (getDeclaredPorts(techStackId) ?? []).some((p) => p.port === port)
}

/** True if the port is exposed: a stack default or a port this project added. */
export function isExposedPort(
  techStackId: string | null | undefined,
  settings: Record<string, unknown> | null | undefined,
  port: number,
): boolean {
  return resolveExposedPorts(techStackId, settings).some((p) => p.port === port)
}

/** The declared entry for `port` (protocol + label), or null if undeclared. */
export function getDeclaredPort(
  techStackId: string | null | undefined,
  port: number,
): { port: number; label?: string; protocol: PortProtocol; defaultVisibility: PortVisibility } | null {
  return (getDeclaredPorts(techStackId) ?? []).find((p) => p.port === port) ?? null
}

/**
 * Build the new `settings.exposedPorts` object after toggling one port's
 * visibility. Preserves label/protocol/source on that port and does not
 * clobber overrides for other ports.
 */
export function withPortVisibility(
  settings: Record<string, unknown> | null | undefined,
  port: number,
  visibility: PortVisibility,
): ExposedPortsSettings {
  const overrides = readExposedPortsSettings(settings)
  const key = String(port)
  return { ...overrides, [key]: { ...overrides[key], visibility } }
}

export interface AddProjectPortInput {
  port: number
  protocol: PortProtocol
  label?: string
}

export function addProjectPort(
  techStackId: string | null | undefined,
  settings: Record<string, unknown> | null | undefined,
  input: AddProjectPortInput,
): { ok: true; exposedPorts: ExposedPortsSettings } | { ok: false; error: string } {
  const reason = projectPortError(input.port)
  if (reason) return { ok: false, error: reason }
  if (input.protocol !== 'http' && input.protocol !== 'tcp') {
    return { ok: false, error: "protocol must be 'http' or 'tcp'" }
  }
  const current = resolveExposedPorts(techStackId, settings)
  if (current.some((p) => p.port === input.port)) {
    return { ok: false, error: `Port ${input.port} is already exposed` }
  }
  if (current.length >= MAX_EXPOSED_PORTS) {
    return { ok: false, error: `A project can expose at most ${MAX_EXPOSED_PORTS} ports` }
  }
  const overrides = readExposedPortsSettings(settings)
  return {
    ok: true,
    exposedPorts: {
      ...overrides,
      [String(input.port)]: {
        visibility: 'tunnel',
        protocol: input.protocol,
        source: 'project',
        ...(input.label?.trim() ? { label: input.label.trim().slice(0, 40) } : {}),
      },
    },
  }
}

/** Remove a project-added port. Stack defaults cannot be removed. */
export function removeProjectPort(
  techStackId: string | null | undefined,
  settings: Record<string, unknown> | null | undefined,
  port: number,
): { ok: true; exposedPorts: ExposedPortsSettings } | { ok: false; error: string } {
  if (isDeclaredPort(techStackId, port)) {
    return { ok: false, error: 'Stack default ports cannot be removed. Set visibility to tunnel instead.' }
  }
  const overrides = readExposedPortsSettings(settings)
  const entry = overrides[String(port)]
  if (!entry || entry.source !== 'project') {
    return { ok: false, error: 'Port is not a project-added port' }
  }
  const next = { ...overrides }
  delete next[String(port)]
  return { ok: true, exposedPorts: next }
}
