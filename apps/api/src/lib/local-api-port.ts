// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

const DEFAULT_LOCAL_API_PORT = 39100

/** The port the desktop API listens on (see local-server.ts). */
export function resolveLocalApiPort(): number {
  const raw = process.env.API_PORT || process.env.PORT || String(DEFAULT_LOCAL_API_PORT)
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Local API port is invalid: ${raw}`)
  }
  return port
}
