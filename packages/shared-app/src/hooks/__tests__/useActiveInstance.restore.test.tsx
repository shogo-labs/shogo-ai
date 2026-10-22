// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-130: the machine workspace must be in view on the *first* paint of the
 * reload a switch ends in, and a transient failure to reach the machine must
 * not silently drop the user back into the cloud workspace.
 *
 * Both were the reason "select a machine workspace from the cloud" flashed and
 * then stayed in the cloud workspace while the sidebar said "Connected to …".
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'
import { installHappyDom, restoreHappyDom } from './happy-dom-setup.ts'
import {
  ActiveInstanceProvider,
  localStorageAdapter,
  useActiveInstance,
  type ActiveInstance,
  type InstanceStorageAdapter,
} from '../useActiveInstance'

installHappyDom()

const STORAGE_KEY = 'shogo:activeInstance'
const MACHINE: ActiveInstance = {
  instanceId: 'machine-1',
  name: 'Studio Mac',
  hostname: 'studio-mac',
  workspaceId: 'cloud-personal',
  kind: 'desktop',
  source: 'machine',
  localWorkspaceId: 'machine-team',
  localWorkspaceName: 'Studio Mac Team',
  localWorkspaceKind: 'team',
}

/** Renders the selected instance, so a test can read what is in view. */
function Probe() {
  const { instance, instanceStatus } = useActiveInstance()
  return (
    <div>
      <span data-testid="id">{instance?.localWorkspaceId ?? 'none'}</span>
      <span data-testid="status">{instanceStatus}</span>
    </div>
  )
}

function memoryStorage(initial: string | null, opts: { sync?: boolean } = {}): InstanceStorageAdapter {
  let value = initial
  const adapter: InstanceStorageAdapter = {
    async getItem() {
      return value
    },
    async setItem(_key, next) {
      value = next
    },
    async removeItem() {
      value = null
    },
  }
  if (opts.sync) adapter.peekItem = () => value
  return adapter
}

/** A `/api/machines` answer that still lists the machine. */
function machinesOk() {
  return new Response(
    JSON.stringify({
      machines: [
        {
          id: MACHINE.instanceId,
          name: MACHINE.name,
          status: 'online',
          snapshot: { workspaces: [{ id: 'machine-team', name: 'Studio Mac Team', kind: 'team' }] },
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

function renderProvider(storage: InstanceStorageAdapter, fetchFn: typeof fetch) {
  return render(
    <ActiveInstanceProvider apiUrl="https://studio.test" storage={storage} fetchFn={fetchFn}>
      <Probe />
    </ActiveInstanceProvider>,
  )
}

/** Let the storage promise and the validation settle. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve()
  })
}

beforeEach(() => {
  cleanup()
})

afterEach(() => {
  cleanup()
})

afterAll(() => {
  restoreHappyDom()
})

describe('ActiveInstanceProvider — restoring a machine workspace', () => {
  it('paints the stored machine workspace before the server has answered', async () => {
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fetchFn = (async () => {
      await gate
      return machinesOk()
    }) as unknown as typeof fetch

    const view = renderProvider(memoryStorage(JSON.stringify(MACHINE), { sync: true }), fetchFn)

    // First render, before `/api/machines` resolves: already the machine.
    expect(view.getByTestId('id').textContent).toBe('machine-team')

    await act(async () => {
      release?.()
      await gate
    })
    await settle()
    expect(view.getByTestId('id').textContent).toBe('machine-team')
  })

  it('keeps the machine when the machine list cannot be reached', async () => {
    const fetchFn = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch

    const view = renderProvider(memoryStorage(JSON.stringify(MACHINE)), fetchFn)
    await settle()

    // Not "unpaired" — just unreachable. Dropping to the cloud here is the
    // "flashes and stays in whatever workspace" half of the bug; the machine
    // stays in view and the status poll reports it as offline.
    expect(view.getByTestId('id').textContent).toBe('machine-team')
    expect(view.getByTestId('status').textContent).toBe('offline')
  })

  it('clears the selection when the machine is genuinely gone', async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ machines: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch

    const view = renderProvider(memoryStorage(JSON.stringify(MACHINE)), fetchFn)
    await settle()

    expect(view.getByTestId('id').textContent).toBe('none')
  })
})

describe('localStorageAdapter.peekItem', () => {
  it('reads the stored value synchronously', () => {
    const store = new Map<string, string>()
    const previousWindow = (globalThis as { window?: unknown }).window
    ;(globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      },
    }
    try {
      store.set(STORAGE_KEY, '{"instanceId":"machine-1"}')
      expect(localStorageAdapter.peekItem?.(STORAGE_KEY)).toBe('{"instanceId":"machine-1"}')
      expect(localStorageAdapter.peekItem?.('missing')).toBeNull()
    } finally {
      ;(globalThis as { window?: unknown }).window = previousWindow
    }
  })
})
