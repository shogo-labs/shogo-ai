// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-239 — the runtime rewrites its OWN ports inside code spans and on `curl`
 * lines, so an agent's "verified" checklist can no longer hand the user an
 * address they cannot open.
 *
 * The scanner's own behaviour is covered by `preview-link-rewrite.test.ts`.
 * This file covers the seam that one cannot: `ownPreviewPorts()`, the gateway's
 * derivation of "the ports we told the agent to curl". If that derivation
 * drifts from the port the sandbox hands the agent, the rewrite silently stops
 * matching and the staging critical path goes red again on a fresh project.
 *
 * The staging spec asserts on the rendered page with `LOCALHOST_RE`; the mirror
 * below is that regex (`e2e/staging/agent-chat.ts`).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { ownPreviewPorts } from '../gateway'
import { rewriteLocalhostLinks } from '../preview-link-rewrite'
import { runtimePort } from '../sandbox-exec'

const LOCALHOST_RE =
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?|(?:\blocalhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{2,5}/i

const ORIGIN = 'https://bbfba086-1f2c-4a5b-9d31-6a0e3c2f7d10.preview.staging.shogo.ai'
const API_PORT = 8002

/** Stand-in for the runtime's PreviewManager: only `apiServerUrl` is read. */
const manager = (apiServerUrl: string | undefined) => ({ apiServerUrl }) as any

describe('ownPreviewPorts (SHO-239)', () => {
  let savedPort: string | undefined

  beforeEach(() => {
    savedPort = process.env.PORT
  })

  afterEach(() => {
    if (savedPort === undefined) delete process.env.PORT
    else process.env.PORT = savedPort
  })

  test('is the SPA port plus the API sidecar port', () => {
    process.env.PORT = '8080'
    expect(ownPreviewPorts(manager(`http://localhost:${API_PORT}`))).toEqual([8080, API_PORT])
  })

  test('follows PORT when the pod overrides it', () => {
    process.env.PORT = '4321'
    expect(ownPreviewPorts(manager('http://localhost:8002'))).toEqual([4321, 8002])
  })

  test('defaults to the port server.ts binds when PORT is unset', () => {
    delete process.env.PORT
    expect(ownPreviewPorts(manager(undefined))).toEqual([8080])
    expect(ownPreviewPorts(null)).toEqual([8080])
  })

  test('never repeats a port, and never yields NaN', () => {
    process.env.PORT = '8080'
    expect(ownPreviewPorts(manager('http://localhost:8080'))).toEqual([8080])
    expect(ownPreviewPorts(manager('http://localhost:undefined'))).toEqual([8080])
    expect(ownPreviewPorts(manager(''))).toEqual([8080])
  })

  test('covers the port sandbox-exec tells the agent to curl', () => {
    process.env.PORT = '8080'
    const told = Number(runtimePort())
    expect(ownPreviewPorts(manager(`http://localhost:${API_PORT}`))).toContain(told)
  })
})

describe('the reply the staging gate failed on (SHO-239)', () => {
  const ownPorts = [8080, API_PORT]

  test('no longer carries a localhost address and names the public URL', () => {
    // The literal reply from run 40570262637. The model wrote the address in a
    // code span, which the scanner skipped before this fix.
    const reply = [
      'Verified:',
      '  Build clean (built in 1337ms), no type/lint errors',
      '  `localhost:8080` → 200, public URL → 200',
      `  Preview URL: ${ORIGIN}`,
    ].join('\n')

    const out = rewriteLocalhostLinks(reply, ORIGIN, { ownPorts })

    expect(out).not.toMatch(LOCALHOST_RE)
    expect(out).toContain(ORIGIN)
    expect(out).toContain('`' + ORIGIN + '` → 200')
  })

  test('the sidecar curl line becomes one the user can actually run', () => {
    const reply = `Checked it with:\n\`\`\`\ncurl -s http://localhost:${API_PORT}/api/todos\n\`\`\``
    const out = rewriteLocalhostLinks(reply, ORIGIN, { ownPorts })
    expect(out).not.toMatch(LOCALHOST_RE)
    expect(out).toContain(`curl -s ${ORIGIN}/api/todos`)
  })

  test('a code sample on another port is still left alone', () => {
    const reply = "Point it at `postgres://u@localhost:5432/db` and you're done."
    expect(rewriteLocalhostLinks(reply, ORIGIN, { ownPorts })).toBe(reply)
  })

  test('locally (no public URL) the reply is returned byte-identical', () => {
    const reply = 'Verified:\n  `localhost:8080` → 200'
    expect(rewriteLocalhostLinks(reply, '', { ownPorts })).toBe(reply)
  })
})
