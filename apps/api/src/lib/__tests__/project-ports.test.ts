// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  resolveExposedPorts,
  isDeclaredPort,
  isExposedPort,
  getDeclaredPort,
  withPortVisibility,
  readExposedPortsSettings,
  addProjectPort,
  removeProjectPort,
  projectPortError,
} from '../project-ports'

describe('resolveExposedPorts', () => {
  test('returns the stack default visibility with no settings override', () => {
    const ports = resolveExposedPorts('docker-compose', {})
    expect(ports).toEqual([
      { port: 8000, label: 'app', protocol: 'http', visibility: 'preview' },
      { port: 5432, label: 'postgres', protocol: 'tcp', visibility: 'tunnel' },
    ])
  })

  test('a settings override wins over the stack default', () => {
    const ports = resolveExposedPorts('docker-compose', {
      exposedPorts: { '8000': { visibility: 'tunnel' } },
    })
    expect(ports.find((p) => p.port === 8000)?.visibility).toBe('tunnel')
    // Unrelated port keeps its default.
    expect(ports.find((p) => p.port === 5432)?.visibility).toBe('tunnel')
  })

  test('returns an empty list for a stack that declares no ports', () => {
    expect(resolveExposedPorts('vite-react', {})).toEqual([])
    expect(resolveExposedPorts(null, {})).toEqual([])
    expect(resolveExposedPorts(undefined, undefined)).toEqual([])
  })

  test('drops a settings override for a port the stack no longer declares', () => {
    const ports = resolveExposedPorts('docker-compose', {
      exposedPorts: { '9999': { visibility: 'preview' } },
    })
    expect(ports.find((p) => p.port === 9999)).toBeUndefined()
    expect(ports).toHaveLength(2)
  })
})

describe('isDeclaredPort / getDeclaredPort', () => {
  test('true/entry for a port the stack declares', () => {
    expect(isDeclaredPort('docker-compose', 8000)).toBe(true)
    expect(getDeclaredPort('docker-compose', 8000)).toMatchObject({ protocol: 'http', defaultVisibility: 'preview' })
  })

  test('false/null for an undeclared port — this is the security-relevant allowlist check', () => {
    expect(isDeclaredPort('docker-compose', 22)).toBe(false)
    expect(isDeclaredPort('docker-compose', 5433)).toBe(false)
    expect(getDeclaredPort('docker-compose', 22)).toBeNull()
    expect(isDeclaredPort('vite-react', 8000)).toBe(false)
    expect(isDeclaredPort(null, 8000)).toBe(false)
  })
})

describe('readExposedPortsSettings', () => {
  test('returns {} for absent/malformed values without throwing', () => {
    expect(readExposedPortsSettings(null)).toEqual({})
    expect(readExposedPortsSettings({})).toEqual({})
    expect(readExposedPortsSettings({ exposedPorts: 'not-an-object' } as any)).toEqual({})
    expect(readExposedPortsSettings({ exposedPorts: { '8000': 'bogus' } } as any)).toEqual({})
    expect(readExposedPortsSettings({ exposedPorts: { '8000': { visibility: 'nope' } } } as any)).toEqual({})
  })

  test('passes through only well-shaped entries', () => {
    expect(
      readExposedPortsSettings({
        exposedPorts: { '8000': { visibility: 'preview' }, '5432': { visibility: 'tunnel' }, '1': {} },
      }),
    ).toEqual({ '8000': { visibility: 'preview' }, '5432': { visibility: 'tunnel' } })
  })
})

describe('withPortVisibility', () => {
  test('sets a fresh override', () => {
    expect(withPortVisibility({}, 8000, 'preview')).toEqual({ '8000': { visibility: 'preview' } })
  })

  test('merges without clobbering an unrelated existing override', () => {
    const settings = { exposedPorts: { '5432': { visibility: 'tunnel' } } }
    expect(withPortVisibility(settings, 8000, 'preview')).toEqual({
      '5432': { visibility: 'tunnel' },
      '8000': { visibility: 'preview' },
    })
  })

  test('overwrites a prior override for the same port', () => {
    const settings = { exposedPorts: { '8000': { visibility: 'preview' } } }
    expect(withPortVisibility(settings, 8000, 'tunnel')).toEqual({ '8000': { visibility: 'tunnel' } })
  })

  test('keeps protocol and source when toggling a project-added port', () => {
    const settings = {
      exposedPorts: { '3000': { visibility: 'tunnel', protocol: 'http', source: 'project', label: 'vite' } },
    }
    expect(withPortVisibility(settings, 3000, 'preview')).toEqual({
      '3000': { visibility: 'preview', protocol: 'http', source: 'project', label: 'vite' },
    })
  })
})

describe('project-added ports', () => {
  test('a project can add an http port, which starts as tunnel-only', () => {
    const added = addProjectPort('docker-compose', {}, { port: 3000, protocol: 'http', label: 'vite' })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    const ports = resolveExposedPorts('docker-compose', { exposedPorts: added.exposedPorts })
    expect(ports.find((p) => p.port === 3000)).toMatchObject({
      protocol: 'http',
      visibility: 'tunnel',
      source: 'project',
      label: 'vite',
    })
    expect(isExposedPort('docker-compose', { exposedPorts: added.exposedPorts }, 3000)).toBe(true)
    expect(isDeclaredPort('docker-compose', 3000)).toBe(false)
  })

  test('rejects reserved, privileged, and duplicate ports, and caps the list', () => {
    expect(projectPortError(80)).toMatch(/1024/)
    expect(projectPortError(8080)).toMatch(/reserved/)
    expect(addProjectPort('docker-compose', {}, { port: 8000, protocol: 'http' })).toMatchObject({
      ok: false,
    })
    let settings: Record<string, unknown> = {}
    for (const port of [3000, 3001, 4000, 4001, 5000, 5001]) {
      const added = addProjectPort('docker-compose', settings, { port, protocol: 'http' })
      expect(added.ok).toBe(true)
      if (added.ok) settings = { exposedPorts: added.exposedPorts }
    }
    expect(addProjectPort('docker-compose', settings, { port: 6000, protocol: 'http' })).toMatchObject({
      ok: false,
    })
  })

  test('remove drops a project port and refuses a stack default', () => {
    const added = addProjectPort('docker-compose', {}, { port: 3001, protocol: 'http' })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    const settings = { exposedPorts: added.exposedPorts }
    expect(removeProjectPort('docker-compose', settings, 8000)).toMatchObject({ ok: false })
    const removed = removeProjectPort('docker-compose', settings, 3001)
    expect(removed.ok).toBe(true)
    if (!removed.ok) return
    expect(resolveExposedPorts('docker-compose', { exposedPorts: removed.exposedPorts })).toHaveLength(2)
  })
})
