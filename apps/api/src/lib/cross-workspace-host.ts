// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The cloud half of `forwardToHost` (SHO-493), in its own module.
 *
 * It reaches the instance-tunnel transport in `routes/instances`, which drags
 * `proxy-billing-session` and Prisma along with it — cloud-only code the
 * desktop's `resources/bundle/api.js` must not contain
 * (`local-bundle-integrity.test.ts` guards that). `forwardToHost` therefore
 * loads this module only in cloud mode, and never on a desktop.
 */

import {
  CROSS_WORKSPACE_HOSTED_FROM_HEADER,
  CROSS_WORKSPACE_REQUESTER_HEADER,
  CROSS_WORKSPACE_TOOL_HEADER,
} from './cross-workspace-headers'
import type { ForwardToHostInput, ForwardToHostOptions } from './cross-workspace'
import type { TunnelTransport } from './host-tunnel'
import { prisma } from './prisma'
import { wakeRefusal } from './host-wake'

/**
 * Forward one cross-workspace call to the desktop that hosts the workspace, and
 * pass its answer back unchanged.
 *
 * The tunnel is woken first, and the refusal says which of the two things went
 * wrong (SHO-506): `503 device_offline` for a machine whose heartbeat is stale,
 * `503 device_connecting` (retryable, with the seconds to wait) for one that is
 * online but whose tunnel missed the wake window. Never a 200 with an empty body.
 * A tunnel that dies mid-request is `503 device_offline` when it says the machine
 * is offline and `502 device_tunnel_error` otherwise.
 */
export async function forwardToHostOnHost(
  c: any,
  input: ForwardToHostInput,
  opts: ForwardToHostOptions = {},
): Promise<Response> {
  const instance = await prisma.instance
    .findUnique({
      where: { id: input.hostInstanceId },
      select: { id: true, name: true, userId: true, lastSeenAt: true },
    })
    .catch(() => null)
  const offline = () =>
    deviceOffline(c, input.hostInstanceId, instance?.name ?? null, instance?.lastSeenAt ?? null)

  if (!instance?.userId) return offline()

  let tunnel: TunnelTransport
  try {
    tunnel = opts._tunnel ?? ((await import('../routes/instances')) as unknown as TunnelTransport)
  } catch {
    return offline()
  }
  const { hostWakeDeadlineMs, hostWakeInteractiveMs } = await import('./host-tunnel')
  const staleProbeMs = opts._wakeDeadlineMs ?? hostWakeDeadlineMs()
  // Capped like the host tunnel itself (SHO-538): an unbounded wake waits out an
  // idle desktop's whole heartbeat (up to 75 s) and then forwards on top of it,
  // which is past the edge's 100 s. `hostWakeInteractiveMs()` + the proxy timeout
  // this forward runs under stays inside one edge budget.
  const wake = tunnel.wakeHostTunnel
    ? await tunnel
        .wakeHostTunnel(input.hostInstanceId, { staleProbeMs, maxWaitMs: hostWakeInteractiveMs() })
        .catch(() => ({ state: 'offline' as const, instanceId: input.hostInstanceId, name: instance.name, lastSeenAt: instance.lastSeenAt, retryAfterSeconds: 0 }))
    : {
        state: (await tunnel.ensureTunnelConnected(input.hostInstanceId, Math.min(staleProbeMs, hostWakeInteractiveMs())).catch(() => false))
          ? ('connected' as const)
          : ('offline' as const),
        instanceId: input.hostInstanceId,
        name: instance.name,
        lastSeenAt: instance.lastSeenAt,
        retryAfterSeconds: 0,
      }
  if (wake.state !== 'connected') {
    return c.json({ error: wakeRefusal(wake, 'device', { subject: instance.name }) }, 503)
  }

  const method = c.req.method
  const body = method === 'GET' || method === 'HEAD' ? undefined : await c.req.text()
  const headers: Record<string, string> = {
    // One user: the desktop belongs to the person whose tunnel this is.
    'x-tunnel-auth-user-id': instance.userId,
    [CROSS_WORKSPACE_HOSTED_FROM_HEADER]: input.callerWorkspaceId,
    [CROSS_WORKSPACE_REQUESTER_HEADER]: input.requesterUserId,
  }
  if (input.tool) headers[CROSS_WORKSPACE_TOOL_HEADER] = input.tool
  if (body !== undefined) headers['content-type'] = c.req.header('content-type') ?? 'application/json'

  try {
    const resp = await tunnel.sendTunnelRequest(input.hostInstanceId, {
      type: 'request',
      requestId: tunnel.generateRequestId(),
      method,
      path: c.req.path + new URL(c.req.url).search,
      headers,
      body,
    })
    const { DROP_RESPONSE_HEADERS } = await import('./host-tunnel')
    const out = new Headers()
    for (const [key, value] of Object.entries(resp.headers ?? {})) {
      if (value && !DROP_RESPONSE_HEADERS.has(key.toLowerCase())) out.set(key, value)
    }
    if (!out.has('content-type')) out.set('content-type', 'application/json')
    return new Response(resp.body || '', { status: resp.status, headers: out })
  } catch (err: any) {
    if (/offline/i.test(err?.message ?? '')) return offline()
    return c.json(
      {
        error: {
          code: 'device_tunnel_error',
          message: err?.message ?? 'The desktop hosting that workspace could not be reached',
          instanceId: input.hostInstanceId,
          retryable: true,
        },
      },
      502,
    )
  }
}

/**
 * `device_offline` for the cases where there is no wake to ask: the host row is
 * gone, or the tunnel transport could not be loaded. A wake that ran answers
 * through `wakeRefusal` instead, which can say `device_connecting`.
 */
function deviceOffline(c: any, instanceId: string, name: string | null, lastSeenAt: Date | null): Response {
  const seen = lastSeenAt ? new Date(lastSeenAt).toISOString() : null
  return c.json(
    {
      error: {
        code: 'device_offline',
        message: `${name || 'The desktop hosting that workspace'} is offline${seen ? ` (last seen ${seen})` : ''}`,
        instanceId,
        lastSeenAt: seen,
      },
    },
    503,
  )
}
