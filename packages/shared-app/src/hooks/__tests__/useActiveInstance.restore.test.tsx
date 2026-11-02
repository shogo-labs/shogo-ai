// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-285: a paired desktop's workspace is a normal cloud workspace now, so a
 * selection an older build stored as `source: 'machine'` (SHO-130/185) must be
 * dropped on restore — never painted, never validated, removed from storage.
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
/** What a pre-SHO-285 build stored when a machine workspace was open. */
const RETIRED_SELECTION = JSON.stringify({
  instanceId: 'machine-1',
  name: 'Studio Mac',
  hostname: 'studio-mac',
  workspaceId: 'cloud-personal',
  kind: 'desktop',
  source: 'machine',
  localWorkspaceId: 'machine-team',
})

const REMOTE: ActiveInstance = {
  instanceId: 'inst-remote',
  name: 'Office Mac',
  hostname: 'office-mac',
  workspaceId: 'cloud-personal',
  kind: 'desktop',
}

/** Renders the selected instance, so a test can read what is in view. */
function Probe() {
  const { instance } = useActiveInstance()
  return <span data-testid="id">{instance?.instanceId ?? 'none'}</span>
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

function instancesOk() {
  return new Response(
    JSON.stringify({ instances: [{ id: REMOTE.instanceId, name: REMOTE.name, status: 'online', kind: 'desktop' }] }),
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

describe('ActiveInstanceProvider — a retired machine selection (SHO-285)', () => {
  it('does not paint a stored machine selection on the first render', async () => {
    const storage = memoryStorage(RETIRED_SELECTION, { sync: true })
    let fetched = 0
    const view = renderProvider(storage, (async () => {
      fetched += 1
      return instancesOk()
    }) as unknown as typeof fetch)
    expect(view.getByTestId('id').textContent).toBe('none')
    await settle()
    expect(view.getByTestId('id').textContent).toBe('none')
    expect(fetched).toBe(0)
  })

  it('removes the stored machine selection', async () => {
    const storage = memoryStorage(RETIRED_SELECTION)
    renderProvider(storage, (async () => instancesOk()) as unknown as typeof fetch)
    await settle()
    expect(await storage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('still restores an ordinary Remote Control selection', async () => {
    const storage = memoryStorage(JSON.stringify(REMOTE), { sync: true })
    const view = renderProvider(storage, (async () => instancesOk()) as unknown as typeof fetch)
    expect(view.getByTestId('id').textContent).toBe(REMOTE.instanceId)
    await settle()
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
