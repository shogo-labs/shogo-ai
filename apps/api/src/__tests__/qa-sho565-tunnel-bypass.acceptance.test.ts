// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The desktop tunnel must never be routed back through queue-proxy (SHO-565).
 *
 * `api-tunnel-direct` reached the api pod on queue-proxy's port (8012), and
 * queue-proxy closes a hijacked WebSocket that has not written a response header
 * at `responseStartTimeoutSeconds` — every remote machine's tunnel was cut at
 * exactly 300 s, mid-turn. Raising that timeout only moved the cut to the
 * revision's `timeoutSeconds`, and every open tunnel still counted as an
 * in-flight request for the autoscaler.
 *
 * The fix targets the app container port instead, so there is no proxy in front
 * of the socket. That is a one-line YAML edit in three overlays, which nothing
 * else in the repo would notice: a new region copies an old file, someone
 * re-applies `main` over a hand-patched cluster, and the 5-minute cuts come
 * back with no test failing. This reads the overlays and holds the invariant.
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseAllDocuments } from 'yaml'

const OVERLAYS = join(import.meta.dir, '../../../../k8s/overlays')

/** queue-proxy's ingress port: the one the tunnel must not use. */
const QUEUE_PROXY_PORT = 8012

type Doc = any

function docsOf(dir: string, file: string): Doc[] {
  return parseAllDocuments(readFileSync(join(OVERLAYS, dir, file), 'utf8'))
    .map((doc) => doc.toJS())
    .filter(Boolean)
}

function find(docs: Doc[], kind: string, name: string): Doc | undefined {
  return docs.find((doc) => doc.kind === kind && doc.metadata?.name === name)
}

const tunnelOverlays = readdirSync(OVERLAYS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((dir) => existsSync(join(OVERLAYS, dir, 'api-tunnel-ingress.yaml')))

function targetPortOf(dir: string): number | undefined {
  const service = find(docsOf(dir, 'api-tunnel-ingress.yaml'), 'Service', 'api-tunnel-direct')
  return service?.spec?.ports?.[0]?.targetPort
}

/** Every container port the api pod in that overlay actually listens on. */
function apiContainerPorts(dir: string): number[] {
  const ports: number[] = []
  for (const doc of docsOf(dir, 'api-service.yaml')) {
    for (const container of doc.spec?.template?.spec?.containers ?? []) {
      for (const port of container.ports ?? []) {
        if (typeof port.containerPort === 'number') ports.push(port.containerPort)
      }
    }
  }
  return ports
}

describe('api-tunnel-direct bypasses queue-proxy (SHO-565)', () => {
  test('the overlays that define the tunnel Service are the ones expected', () => {
    // A new region that copies an old overlay must show up here, not slip by.
    expect(tunnelOverlays.sort()).toEqual(['production-eu', 'production-us', 'staging'])
  })

  test('every tunnel Service targets the app container port, not queue-proxy', () => {
    const wrong = tunnelOverlays
      .map((dir) => ({ dir, port: targetPortOf(dir) }))
      .filter(({ dir, port }) => port === undefined || port === QUEUE_PROXY_PORT || !apiContainerPorts(dir).includes(port))
    expect(wrong).toEqual([])
  })

  test('the Knative Ingress still routes the tunnel host at that Service', () => {
    for (const dir of tunnelOverlays) {
      const ingress = find(docsOf(dir, 'api-tunnel-ingress.yaml'), 'Ingress', 'api-tunnel')
      const splits = (ingress?.spec?.rules ?? []).flatMap((rule: Doc) =>
        (rule.http?.paths ?? []).flatMap((path: Doc) => path.splits ?? []),
      )
      expect({ dir, services: splits.map((split: Doc) => split.serviceName) }).toEqual({
        dir,
        services: ['api-tunnel-direct'],
      })
    }
  })

  test('no overlay re-raises the response-start timeout as a substitute', () => {
    // #2234 briefly set 1800 s here. It hid the symptom for 30 minutes instead
    // of removing it, so the annotation must stay gone.
    for (const dir of tunnelOverlays) {
      for (const doc of docsOf(dir, 'api-service.yaml')) {
        const annotations = doc.spec?.template?.metadata?.annotations ?? {}
        expect({ dir, responseStartTimeoutSeconds: annotations['queue.sidecar.serving.knative.dev/responseStartTimeoutSeconds'] })
          .toEqual({ dir, responseStartTimeoutSeconds: undefined })
      }
    }
  })
})
