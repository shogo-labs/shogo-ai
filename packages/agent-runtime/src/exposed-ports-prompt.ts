// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Tells the agent which guest ports the Studio preview can reach, and that
 * a port it isn't listed for stays invisible until `expose_port`.
 */
export function buildExposedPortsPrompt(env: Record<string, string | undefined>): string | null {
  const raw = env.SHOGO_EXPOSED_PORTS
  if (!raw?.trim()) return null
  const ports = raw
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isInteger(n) && n > 0 && n <= 65535)
  if (ports.length === 0) return null

  const lines = ports.map((port) => {
    const preview = portPreviewOrigin(env.PUBLIC_PREVIEW_URL, port)
    return preview ? `- ${port}: ${preview}` : `- ${port}: reachable inside the project at http://127.0.0.1:${port}`
  })

  return [
    '## Exposed ports',
    'Studio shows a port only when it is in this list and its visibility is preview. These ports are exposed:',
    ...lines,
    'The Studio preview iframe loads the first preview-visibility port. If the app listens somewhere else (`docker compose ps`), call `expose_port` with that port and protocol "http".',
    'A new port starts as tunnel-only, which project members can open. visibility "preview" asks the user before the port is reachable with no login.',
    'A project can expose at most 8 ports, between 1024 and 65535. Ports 8080 and 9900 are reserved.',
  ].join('\n')
}

export function portPreviewOrigin(publicPreviewUrl: string | undefined, port: number): string | null {
  if (!publicPreviewUrl) return null
  try {
    const url = new URL(publicPreviewUrl)
    url.hostname = `${port}--${url.hostname}`
    url.pathname = '/'
    url.search = ''
    url.hash = ''
    return url.origin
  } catch {
    return null
  }
}
