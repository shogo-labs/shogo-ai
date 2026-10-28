// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-241 §D: a machine is one thing with several `instances` rows, and a status
 * poll is not a liveness test.
 *
 * The reported toast — "machine offline — stopped heartbeating" on a machine that
 * was heartbeating the whole time — came from two separate misses:
 *
 * 1. the cloud named whichever row of the machine heartbeated last, so a client
 *    that had stored any of the others stopped recognising its own machine, and
 * 2. a poll that could not reach the server (a 5xx, a cold relay) was read as
 *    "the machine is gone".
 *
 * These are the cases that were missing from the suite, including the one that
 * actually shipped broken: the same machine answered by two different rows, polled
 * ten times in a row.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'
import { installHappyDom, restoreHappyDom } from './happy-dom-setup.ts'
import {
  ActiveInstanceProvider,
  useActiveInstance,
  type ActiveInstance,
  type InstanceStorageAdapter,
} from '../useActiveInstance'

installHappyDom()

const STORAGE_KEY = 'shogo:activeInstance'

/** What an older build stored: the row that happened to heartbeat last. */
const MACHINE: ActiveInstance = {
  instanceId: 'i-team',
  name: 'Studio Mac',
  hostname: 'studio-mac',
  workspaceId: 'cloud-personal',
  kind: 'desktop',
  source: 'machine',
  localWorkspaceId: 'machine-team',
  localWorkspaceName: 'Studio Mac Team',
  localWorkspaceKind: 'team',
}

function Probe() {
  const { instance, instanceStatus } = useActiveInstance()
  return (
    <div>
      <span data-testid="id">{instance?.instanceId ?? 'none'}</span>
      <span data-testid="workspace">{instance?.localWorkspaceId ?? 'none'}</span>
      <span data-testid="status">{instanceStatus}</span>
    </div>
  )
}

function memoryStorage(initial: string | null): InstanceStorageAdapter & { value: () => string | null } {
  let value = initial
  return {
    value: () => value,
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
}

/** One `/api/machines` entry: one machine, every row it has, one representative id. */
function machineGroup(id: string, instanceIds: string[], status = 'online') {
  return new Response(
    JSON.stringify({
      machines: [
        {
          id,
          name: MACHINE.name,
          hostname: MACHINE.hostname,
          status,
          instanceIds,
          snapshot: {
            workspaces: [
              { id: 'machine-team', name: 'Studio Mac Team', kind: 'team' },
              { id: 'machine-personal', name: 'Studio Mac', kind: 'personal' },
            ],
          },
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

function emptyMachines() {
  return new Response(JSON.stringify({ machines: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function serverError() {
  return new Response(JSON.stringify({ error: { code: 'internal', message: 'boom' } }), {
    status: 503,
    headers: { 'content-type': 'application/json' },
  })
}

/** A fetch whose answer is chosen per call, counting the calls it served. */
function scriptedFetch(answer: (call: number) => Response | Promise<Response>) {
  let calls = 0
  const fn = (async () => {
    calls += 1
    return answer(calls)
  }) as unknown as typeof fetch
  return { fn, calls: () => calls }
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
    for (let i = 0; i < 8; i += 1) await Promise.resolve()
  })
}

/** One 15 s status poll. */
async function poll(): Promise<void> {
  // Advance, then flush: doing both inside one `act` leaves the tick's fetch
  // promise unflushed and `act` waits on it.
  await act(async () => {
    jest.advanceTimersByTime(15000)
  })
  await settle()
}

beforeEach(() => {
  cleanup()
  jest.useFakeTimers()
})

afterEach(() => {
  cleanup()
  jest.useRealTimers()
})

afterAll(() => {
  restoreHappyDom()
})

describe('a machine whose rows disagree about its id', () => {
  it('keeps the machine in view and stores the id the server names', async () => {
    // The stored row is a sibling: `i-team`. The server names the machine
    // `i-personal` and lists both rows.
    const { fn } = scriptedFetch(() => machineGroup('i-personal', ['i-personal', 'i-team']))
    const storage = memoryStorage(JSON.stringify(MACHINE))

    const view = renderProvider(storage, fn)
    await settle()

    expect(view.getByTestId('workspace').textContent).toBe('machine-team')
    expect(view.getByTestId('status').textContent).toBe('online')
    // Stored under the representative id, so the relay path and the next poll
    // both use the row the server will answer for.
    expect(view.getByTestId('id').textContent).toBe('i-personal')
    expect(JSON.parse(storage.value() as string).instanceId).toBe('i-personal')
  })

  it('stays online across ten polls that name the other row each time', async () => {
    // Two rows of one machine, alternating as the representative — the shape that
    // shipped broken. Matching on `instanceIds` makes every poll land.
    const { fn } = scriptedFetch((call) =>
      call % 2 === 1
        ? machineGroup('i-personal', ['i-personal', 'i-team'])
        : machineGroup('i-team', ['i-personal', 'i-team']),
    )
    const storage = memoryStorage(JSON.stringify(MACHINE))

    const view = renderProvider(storage, fn)
    await settle()
    expect(view.getByTestId('status').textContent).toBe('online')

    for (let tick = 0; tick < 10; tick += 1) {
      await poll()
      expect(view.getByTestId('status').textContent).toBe('online')
      expect(view.getByTestId('workspace').textContent).toBe('machine-team')
    }
  })
})

describe('a poll that could not reach the server', () => {
  it('leaves a live machine online instead of reporting it offline', async () => {
    // First answer is the restore, then the server starts failing.
    const { fn } = scriptedFetch((call) =>
      call === 1 ? machineGroup('i-personal', ['i-personal', 'i-team']) : serverError(),
    )
    const storage = memoryStorage(JSON.stringify(MACHINE))

    const view = renderProvider(storage, fn)
    await settle()
    expect(view.getByTestId('status').textContent).toBe('online')

    // Three failed polls in a row: a 5xx is not evidence the machine went away,
    // and this is exactly the toast SHO-241 was filed for.
    for (let tick = 0; tick < 3; tick += 1) {
      await poll()
      expect(view.getByTestId('status').textContent).toBe('online')
      expect(view.getByTestId('workspace').textContent).toBe('machine-team')
    }
  })

  it('recovers when the server answers again', async () => {
    const { fn } = scriptedFetch((call) => {
      if (call === 1) return machineGroup('i-personal', ['i-personal', 'i-team'])
      if (call <= 3) return serverError()
      return machineGroup('i-personal', ['i-personal', 'i-team'], 'online')
    })
    const storage = memoryStorage(JSON.stringify(MACHINE))

    const view = renderProvider(storage, fn)
    await settle()
    await poll()
    await poll()
    await poll()

    expect(view.getByTestId('status').textContent).toBe('online')
  })

  it('still reports offline when the machine is genuinely gone', async () => {
    // A conclusive answer (the machine is not in the list) is different from a
    // failed question, and must keep being reported.
    const { fn } = scriptedFetch((call) => (call === 1 ? emptyMachines() : emptyMachines()))
    const storage = memoryStorage(JSON.stringify(MACHINE))

    const view = renderProvider(storage, fn)
    await settle()

    expect(view.getByTestId('workspace').textContent).toBe('none')
  })
})
