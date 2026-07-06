// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it } from 'bun:test'
import { LatitudeClient, LatitudeApiError } from '../latitude-client'

describe('LatitudeClient', () => {
  it('is unconfigured without a token and refuses requests', async () => {
    const c = new LatitudeClient({ token: '' })
    expect(c.isConfigured()).toBe(false)
    await expect(c.listServers('proj')).rejects.toBeInstanceOf(LatitudeApiError)
  })

  it('creates a server with the JSON:API envelope and maps the response', async () => {
    let captured: any
    const fetchImpl = (async (url: string, init: any) => {
      captured = { url, init, body: JSON.parse(init.body) }
      return new Response(
        JSON.stringify({
          data: {
            id: 'sv_new',
            attributes: { hostname: 'shogo-fc-burst-us-1', status: 'deploying', primary_ipv4: null, billing: 'hourly', plan: { slug: 's3-large-x86' }, region: { site: { slug: 'DAL' } } },
          },
        }),
        { status: 201 },
      )
    }) as any
    const c = new LatitudeClient({ token: 'tok', fetchImpl })

    const server = await c.createServer({
      project: 'proj_1',
      plan: 's3-large-x86',
      site: 'DAL',
      operatingSystem: 'ubuntu_24_04_x64_lts',
      hostname: 'shogo-fc-burst-us-1',
      sshKeys: ['ssh_1'],
      billing: 'hourly',
    })

    expect(captured.init.method).toBe('POST')
    expect(captured.init.headers.Authorization).toBe('tok')
    expect(captured.body.data.attributes.billing).toBe('hourly')
    expect(captured.body.data.attributes.ssh_keys).toEqual(['ssh_1'])
    expect(server).toEqual({ id: 'sv_new', hostname: 'shogo-fc-burst-us-1', status: 'deploying', primaryIpv4: null, site: 'DAL', plan: 's3-large-x86', billing: 'hourly' })
  })

  it('surfaces the provider error detail on failure', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ errors: [{ detail: 'Your team can deploy only 2 bare metal servers.' }] }), {
        status: 422,
      })) as any
    const c = new LatitudeClient({ token: 'tok', fetchImpl })
    await expect(
      c.createServer({ project: 'p', plan: 's3-large-x86', site: 'FRA', operatingSystem: 'ubuntu_24_04_x64_lts', hostname: 'h', sshKeys: ['k'], billing: 'monthly' }),
    ).rejects.toThrow(/only 2 bare metal/)
  })

  it('deletes a server', async () => {
    let method = ''
    let path = ''
    const fetchImpl = (async (url: string, init: any) => {
      method = init.method
      path = new URL(url).pathname
      return new Response('', { status: 204 })
    }) as any
    const c = new LatitudeClient({ token: 'tok', fetchImpl })
    await c.deleteServer('sv_x')
    expect(method).toBe('DELETE')
    expect(path).toBe('/servers/sv_x')
  })
})
