// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it } from 'bun:test'
import { MachinesApi } from '../index'
import type { HttpClient } from '../../http/client.js'
import type { ShogoResponse } from '../../types.js'

// ---------------------------------------------------------------------------
// Mini fake HttpClient — only implements what MachinesApi calls. We assert
// against the captured calls instead of starting a server, mirroring the
// existing SDK testing style (no fetch mocks, no network).
// ---------------------------------------------------------------------------

interface RecordedCall {
  method: string
  path: string
  body?: unknown
  searchParams?: Record<string, string>
}

function makeHttp(handler: (call: RecordedCall) => any): { http: HttpClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const respond = (call: RecordedCall): ShogoResponse<any> => ({
    data: handler(call),
    status: 200,
    error: null,
  })
  const http = {
    get(path: string, searchParams?: Record<string, string>) {
      const call = { method: 'GET', path, searchParams }
      calls.push(call)
      return Promise.resolve(respond(call))
    },
    post(path: string, body?: unknown) {
      const call = { method: 'POST', path, body }
      calls.push(call)
      return Promise.resolve(respond(call))
    },
    request(path: string, opts: { method?: string; body?: unknown } = {}) {
      const call = { method: opts.method ?? 'GET', path, body: opts.body }
      calls.push(call)
      return Promise.resolve(respond(call))
    },
    delete(path: string, searchParams?: Record<string, string>) {
      const call = { method: 'DELETE', path, searchParams }
      calls.push(call)
      return Promise.resolve(respond(call))
    },
  } as unknown as HttpClient
  return { http, calls }
}

describe('MachinesApi', () => {
  describe('list', () => {
    it('GETs /api/instances with workspaceId and unwraps `instances`', async () => {
      const fixture = [
        {
          id: 'inst-1',
          workspaceId: 'ws-1',
          name: 'prod-vps-1',
          hostname: 'prod-vps-1.fly.dev',
          kind: 'cli_worker',
          status: 'online',
          os: 'linux',
          arch: 'x86_64',
          lastSeenAt: '2026-05-15T00:00:00.000Z',
          createdAt: '2026-05-01T00:00:00.000Z',
          updatedAt: '2026-05-15T00:00:00.000Z',
        },
      ]
      const { http, calls } = makeHttp(() => ({ instances: fixture }))
      const api = new MachinesApi(http)

      const machines = await api.list({ workspaceId: 'ws-1' })

      expect(machines).toEqual(fixture as any)
      expect(calls).toEqual([{ method: 'GET', path: '/api/instances', searchParams: { workspaceId: 'ws-1' } }])
    })

    it('returns [] when the server omits `instances`', async () => {
      const { http } = makeHttp(() => ({}))
      const api = new MachinesApi(http)
      const machines = await api.list({ workspaceId: 'ws-1' })
      expect(machines).toEqual([])
    })
  })

  describe('listOnline', () => {
    it('GETs /api/instances/online with workspaceId and unwraps `instances`', async () => {
      const { http, calls } = makeHttp(() => ({
        instances: [{ id: 'inst-1', name: 'desk', hostname: 'desk.local', kind: 'desktop' }],
      }))
      const api = new MachinesApi(http)
      const online = await api.listOnline({ workspaceId: 'ws-1' })
      expect(online).toHaveLength(1)
      expect(calls[0]).toEqual({
        method: 'GET',
        path: '/api/instances/online',
        searchParams: { workspaceId: 'ws-1' },
      })
    })
  })

  describe('get', () => {
    it('URL-encodes the instance id', async () => {
      const { http, calls } = makeHttp(() => ({ id: 'weird id', name: 'x' } as any))
      const api = new MachinesApi(http)
      await api.get('weird id')
      expect(calls[0].path).toBe('/api/instances/weird%20id')
    })

    it('returns null when the server returns no body', async () => {
      // Reach in and force `data: null` to mirror a 404.
      const http = {
        get: async () => ({ data: null, status: 404, error: null }) as ShogoResponse<any>,
      } as unknown as HttpClient
      const api = new MachinesApi(http)
      const inst = await api.get('missing')
      expect(inst).toBeNull()
    })
  })

  describe('getProjectPin', () => {
    it('GETs /api/projects/:id/preferred-instance and URL-encodes the projectId', async () => {
      const { http, calls } = makeHttp(() => ({
        preferredInstanceId: 'inst-7',
        preferredInstancePolicy: 'pinned',
        instance: { id: 'inst-7', name: 'prod-vps-7' },
      }))
      const api = new MachinesApi(http)
      const pin = await api.getProjectPin('proj/with/slash')
      expect(pin.preferredInstanceId).toBe('inst-7')
      expect(calls[0]).toEqual({
        method: 'GET',
        path: '/api/projects/proj%2Fwith%2Fslash/preferred-instance',
      })
    })

    it('returns the cloud-routed default shape when response body is missing', async () => {
      const http = {
        get: async () => ({ data: null, status: 200, error: null }) as ShogoResponse<any>,
      } as unknown as HttpClient
      const api = new MachinesApi(http)
      const pin = await api.getProjectPin('proj-x')
      expect(pin).toEqual({
        preferredInstanceId: null,
        preferredInstancePolicy: 'pinned',
        instance: null,
      })
    })
  })

  describe('pinProject', () => {
    it('PUTs /api/projects/:id/preferred-instance with default policy omitted', async () => {
      const { http, calls } = makeHttp(() => ({
        ok: true,
        preferredInstanceId: 'inst-1',
        preferredInstancePolicy: 'pinned',
        instance: { id: 'inst-1', name: 'prod-vps-1' },
      }))
      const api = new MachinesApi(http)
      const res = await api.pinProject('proj-1', { instanceId: 'inst-1' })

      expect(res.ok).toBe(true)
      expect(calls).toEqual([
        {
          method: 'PUT',
          path: '/api/projects/proj-1/preferred-instance',
          body: { instanceId: 'inst-1' },
        },
      ])
    })

    it('forwards an explicit policy', async () => {
      const { http, calls } = makeHttp(() => ({
        ok: true,
        preferredInstanceId: 'inst-1',
        preferredInstancePolicy: 'prefer',
        instance: { id: 'inst-1', name: 'x' },
      }))
      const api = new MachinesApi(http)
      await api.pinProject('proj-1', { instanceId: 'inst-1', policy: 'prefer' })
      expect((calls[0].body as any).policy).toBe('prefer')
    })

    it('URL-encodes the projectId', async () => {
      const { http, calls } = makeHttp(() => ({
        ok: true,
        preferredInstanceId: 'inst-1',
        preferredInstancePolicy: 'pinned',
        instance: { id: 'inst-1', name: 'x' },
      }))
      const api = new MachinesApi(http)
      await api.pinProject('proj/with/slash', { instanceId: 'inst-1' })
      expect(calls[0].path).toBe('/api/projects/proj%2Fwith%2Fslash/preferred-instance')
    })

    it('throws when the server returns no body', async () => {
      const http = {
        request: async () => ({ data: null, status: 500, error: null }) as ShogoResponse<any>,
      } as unknown as HttpClient
      const api = new MachinesApi(http)
      await expect(api.pinProject('proj-1', { instanceId: 'inst-1' })).rejects.toThrow(
        /Failed to pin project/,
      )
    })
  })

  describe('unpinProject', () => {
    it('DELETEs /api/projects/:id/preferred-instance', async () => {
      const { http, calls } = makeHttp(() => ({}))
      const api = new MachinesApi(http)
      await api.unpinProject('proj-1')
      expect(calls).toEqual([
        { method: 'DELETE', path: '/api/projects/proj-1/preferred-instance', searchParams: undefined },
      ])
    })
  })
})
