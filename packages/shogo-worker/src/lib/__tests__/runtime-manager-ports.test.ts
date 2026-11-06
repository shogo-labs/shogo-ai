// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-335 — port allocation must never hand out a busy port.
 *
 * The worker's `allocatePort` used to probe with an HTTP `HEAD`: a listener
 * that accepted the connection but never answered (Vite mid-compile, a
 * saturated event loop, any non-HTTP socket) read as FREE, and the agent
 * runtime then died at `Bun.serve` with `EADDRINUSE` and crash-looped.
 *
 * These tests pin the two behaviours the fix depends on:
 *   1. a busy-but-silent TCP listener is skipped (red on the HTTP probe), and
 *   2. a probe that TIMES OUT counts as in use, never as free.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { createServer, type Server, type Socket } from 'node:net';
import {
  DEFAULT_PORT_RANGE_END,
  DEFAULT_PORT_RANGE_START,
  PortPool,
  probeTcpPort,
} from '../port-pool.ts';
import { WorkerRuntimeManager } from '../runtime-manager.ts';

const RUNTIME_PORT_BLOCK = 16;

/** A manager whose pool draws candidates from `random`. */
function managerWithPool(pool: PortPool, logs: string[] = []): any {
  return new WorkerRuntimeManager({
    env: {} as NodeJS.ProcessEnv,
    ports: pool,
    logger: { log: (line: string) => logs.push(line), warn: () => {}, error: () => {} },
  }) as any;
}

/** Random value that makes `allocate` start its candidate search at `port`. */
function randomTargeting(port: number, blockSize: number): () => number {
  const candidates = DEFAULT_PORT_RANGE_END - DEFAULT_PORT_RANGE_START - blockSize + 2;
  const index = port - DEFAULT_PORT_RANGE_START;
  // +0.5 keeps the floor() away from float error at either edge of the bucket.
  return () => (index + 0.5) / candidates;
}

const servers: Server[] = [];
const sockets: Socket[] = [];

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) server.close();
});

/**
 * Listen on `port`, accepting connections and never writing a byte — exactly
 * what an HTTP HEAD probe misreads as free.
 */
async function silentListener(port: number): Promise<Server> {
  const server = createServer((socket) => {
    sockets.push(socket);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  return server;
}

/** True when `port` can be bound right now (the probe is released again). */
async function portIsFree(port: number): Promise<boolean> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve());
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return true;
  } catch {
    return false;
  }
}

/** First port in the allocatable range that will accept a listener. */
async function parkSilentListenerInRange(): Promise<number> {
  for (let port = DEFAULT_PORT_RANGE_END - RUNTIME_PORT_BLOCK + 1; port > DEFAULT_PORT_RANGE_START; port--) {
    try {
      await silentListener(port);
      return port;
    } catch {
      /* this one is taken by a real runtime (or another test) — try the next */
    }
  }
  throw new Error('no free port in the allocatable range');
}

/** A candidate port outside `port`'s block whose eagerly-bound ports are free. */
async function freeCandidateAwayFrom(port: number): Promise<number> {
  for (let candidate = DEFAULT_PORT_RANGE_START; candidate <= DEFAULT_PORT_RANGE_END - RUNTIME_PORT_BLOCK + 1; candidate++) {
    if (candidate >= port - RUNTIME_PORT_BLOCK && candidate <= port + RUNTIME_PORT_BLOCK) continue;
    if ((await portIsFree(candidate)) && (await portIsFree(candidate + 1))) return candidate;
  }
  throw new Error('no free candidate port in the allocatable range');
}

describe('WorkerRuntimeManager.allocatePort — occupancy probe', () => {
  it('skips a listener that accepts but never answers (HTTP HEAD reads it as free)', async () => {
    const busyPort = await parkSilentListenerInRange();
    const free = await freeCandidateAwayFrom(busyPort);

    const pool = new PortPool();
    // First candidate lands on the busy port; every later attempt lands on a
    // port nothing is listening on.
    const picks = [
      randomTargeting(busyPort, RUNTIME_PORT_BLOCK),
      randomTargeting(free, RUNTIME_PORT_BLOCK),
    ];
    (pool as any).random = () => (picks.length ? picks.shift()! : randomTargeting(free, RUNTIME_PORT_BLOCK))();

    const block = await managerWithPool(pool).allocatePort();

    expect(block).not.toBe(busyPort);
    expect(block).toBe(free);
    // The busy port is not claimed, in this block or any other.
    expect(pool.isReserved(busyPort)).toBe(false);
  });
});

describe('probeTcpPort — timeout semantics', () => {
  function fakeSocket(emit: 'connect' | 'error' | 'timeout') {
    const handlers = new Map<string, Array<(...args: any[]) => void>>();
    const socket = {
      setTimeout: () => socket,
      destroy: () => socket,
      once(event: string, listener: (...args: any[]) => void) {
        handlers.set(event, [...(handlers.get(event) ?? []), listener]);
        if (event === emit) queueMicrotask(() => listener(new Error('probe')));
        return socket;
      },
    };
    return socket as any;
  }

  it('treats a timed-out connect as in use', async () => {
    await expect(
      probeTcpPort(12345, { connect: (() => fakeSocket('timeout')) as any }),
    ).resolves.toBe('in-use');
  });

  it('treats a completed connect as in use', async () => {
    await expect(
      probeTcpPort(12345, { connect: (() => fakeSocket('connect')) as any }),
    ).resolves.toBe('in-use');
  });

  it('treats a refused connect as free', async () => {
    await expect(
      probeTcpPort(12345, { connect: (() => fakeSocket('error')) as any }),
    ).resolves.toBe('free');
  });

  it('never allocates a port whose probe did not answer', async () => {
    const timedOut = DEFAULT_PORT_RANGE_START + 10;
    const free = DEFAULT_PORT_RANGE_START + 40;
    const pool = new PortPool({
      probe: async (port) => (port === timedOut ? 'in-use' : 'free'),
    });
    const picks = [randomTargeting(timedOut, RUNTIME_PORT_BLOCK), randomTargeting(free, RUNTIME_PORT_BLOCK)];
    (pool as any).random = () => (picks.length ? picks.shift()! : randomTargeting(free, RUNTIME_PORT_BLOCK))();

    const block = await pool.allocate({
      start: DEFAULT_PORT_RANGE_START,
      end: DEFAULT_PORT_RANGE_END,
      blockSize: RUNTIME_PORT_BLOCK,
      probeOffsets: [0, 1],
    });

    expect(block).toBe(free);
    expect(pool.isReserved(timedOut)).toBe(false);
  });
});

describe('WorkerRuntimeManager.allocatePort — shared pool', () => {
  it('reserves a block in the pool it was given and releases it again', async () => {
    const pool = new PortPool({ probe: async () => 'free' });
    const logs: string[] = [];
    const mgr = managerWithPool(pool, logs);

    const block = await mgr.allocatePort();
    expect(pool.isReserved(block)).toBe(true);
    expect(pool.isReserved(block + RUNTIME_PORT_BLOCK - 1)).toBe(true);
    // A host log must be able to attribute the next EADDRINUSE without a trace.
    expect(logs.some((line) => line.includes(
      `[WorkerRuntimeManager] Allocated agent block ${block}-${block + RUNTIME_PORT_BLOCK - 1}`,
    ))).toBe(true);

    mgr.releasePort(block);
    for (let offset = 0; offset < RUNTIME_PORT_BLOCK; offset++) {
      expect(pool.isReserved(block + offset)).toBe(false);
    }
  });
});
