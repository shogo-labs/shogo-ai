// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * PortPool — the single in-process allocator for the runtime port range.
 *
 * Two managers hand out localhost ports inside one process: `apps/api`'s
 * `RuntimeManager` (Vite / remote-forward port, plus `+1000`/`+1001` for the
 * agent and its API server) and the `WorkerRuntimeManager` that api embeds
 * (a 16-port block per agent runtime). Each used to keep its own `Set` over
 * 37100–37900, so neither could see the other's reservations: api could hand
 * 37566 to a Vite server while the worker picked the block containing 37566
 * for an agent, and the child crash-looped on `EADDRINUSE` (SHO-335).
 *
 * The fix is one pool per process, passed into the worker by api. Disjoint
 * sub-ranges were the alternative; they would have halved capacity and left
 * the same bug for the next caller that picks a range.
 *
 * Occupancy probing is a kernel-level TCP connect, never an HTTP request:
 * a listener that is up but slow to answer (Vite mid-compile, a saturated
 * event loop, any non-HTTP socket) is still a busy port. A connect that is
 * refused means free; a connect that TIMES OUT means in use — an accept
 * queue that never completes is not a free port.
 */
import { connect, type Socket } from 'node:net';

/** Port range for random allocation (mirrors the desktop manager). */
export const DEFAULT_PORT_RANGE_START = 37100;
export const DEFAULT_PORT_RANGE_END = 37900;

/** Per-probe connect timeout. */
export const DEFAULT_PROBE_TIMEOUT_MS = 500;

/** How many random candidates one `allocate()` tries before giving up. */
const DEFAULT_MAX_ATTEMPTS = 50;

export type PortProbeResult = 'free' | 'in-use';

export type ConnectFactory = (options: { host: string; port: number }) => Socket;

export interface PortProbeOptions {
  /** Connect timeout in ms. Defaults to {@link DEFAULT_PROBE_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Interface to dial. Defaults to the IPv4 loopback literal. */
  host?: string;
  /** Test seam: dial with something other than `net.connect`. */
  connect?: ConnectFactory;
}

/**
 * Probe a port with a TCP connect.
 *
 * - `connect` → `'in-use'`
 * - `error` (ECONNREFUSED, EHOSTUNREACH, …) → `'free'`
 * - `timeout` → `'in-use'` (a listener whose accept queue is full is busy)
 */
export async function probeTcpPort(
  port: number,
  options: PortProbeOptions = {},
): Promise<PortProbeResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const host = options.host ?? '127.0.0.1';
  const dial: ConnectFactory = options.connect ?? ((target) => connect(target));

  return await new Promise<PortProbeResult>((resolve) => {
    let settled = false;
    const finish = (result: PortProbeResult) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* socket may already be torn down */
      }
      resolve(result);
    };
    const socket = dial({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish('in-use'));
    socket.once('error', () => finish('free'));
    socket.once('timeout', () => finish('in-use'));
  });
}

export interface PortPoolOptions {
  /** Override the occupancy probe (tests). */
  probe?: (port: number) => Promise<PortProbeResult>;
  /** Connect timeout for the default TCP probe. */
  probeTimeoutMs?: number;
  /** Override randomness (tests). Defaults to `Math.random`. */
  random?: () => number;
}

export interface PortBlockRequest {
  /** First candidate port. Defaults to {@link DEFAULT_PORT_RANGE_START}. */
  start?: number;
  /** Last port the candidate BLOCK may reach. Defaults to {@link DEFAULT_PORT_RANGE_END}. */
  end?: number;
  /**
   * Contiguous ports reserved at the candidate, starting with the candidate
   * itself. Defaults to 1.
   */
  blockSize?: number;
  /**
   * Offsets from the candidate that are reserved AND liveness-probed. Unlike
   * {@link blockSize} these are not bounded by `end`: the desktop manager's
   * agent port lives at `+1000`, well past its Vite port range.
   */
  probeOffsets?: readonly number[];
  maxAttempts?: number;
}

/**
 * Reservation pool over the runtime port range. One instance per process;
 * every allocator in that process must be handed the same one.
 */
export class PortPool {
  /**
   * Every port handed out and not yet released. Exposed so callers (and the
   * managers' `usedPorts` accessor used by tests) share one source of truth
   * instead of keeping a parallel set.
   */
  readonly reserved = new Set<number>();

  private readonly probe: (port: number) => Promise<PortProbeResult>;
  private readonly random: () => number;

  constructor(options: PortPoolOptions = {}) {
    this.probe =
      options.probe ??
      ((port) => probeTcpPort(port, { timeoutMs: options.probeTimeoutMs }));
    this.random = options.random ?? Math.random;
  }

  /** Reserve ports that something outside this pool already bound. */
  reserve(ports: Iterable<number>): void {
    for (const port of ports) if (port > 0) this.reserved.add(port);
  }

  release(ports: Iterable<number>): void {
    for (const port of ports) this.reserved.delete(port);
  }

  /** Release a contiguous block previously returned by {@link allocate}. */
  releaseBlock(start: number, size: number): void {
    if (!start) return;
    for (let offset = 0; offset < size; offset++) this.reserved.delete(start + offset);
  }

  isReserved(port: number): boolean {
    return this.reserved.has(port);
  }

  /** True when nothing is reserved in-process and nothing answers on the port. */
  async isPortAvailable(port: number): Promise<boolean> {
    if (port <= 0) return false;
    if (this.reserved.has(port)) return false;
    return await this.probeFree(port);
  }

  /**
   * Pick a random candidate block and reserve it.
   *
   * Reserves BEFORE probing: the probe awaits, and two concurrent allocations
   * must never both see the same block as free (the previous per-manager code
   * check-then-set across an `await`, so a burst of starts could collide).
   * The block is released again if any probed port turns out to be busy.
   */
  async allocate(request: PortBlockRequest = {}): Promise<number> {
    const start = request.start ?? DEFAULT_PORT_RANGE_START;
    const end = request.end ?? DEFAULT_PORT_RANGE_END;
    const blockSize = request.blockSize ?? 1;
    const probeOffsets = request.probeOffsets ?? [0];
    const candidates = end - start - blockSize + 2;
    if (candidates < 1) {
      throw new Error(`Port range ${start}-${end} cannot hold a ${blockSize}-port block`);
    }
    const maxAttempts = request.maxAttempts ?? Math.min(candidates, DEFAULT_MAX_ATTEMPTS);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const candidate = start + Math.floor(this.random() * candidates);
      const ports = this.candidatePorts(candidate, blockSize, probeOffsets);
      if (ports.some((port) => this.reserved.has(port))) continue;

      this.reserve(ports);
      let free = true;
      for (const offset of probeOffsets) {
        if (!(await this.probeFree(candidate + offset))) {
          free = false;
          break;
        }
      }
      if (!free) {
        this.release(ports);
        continue;
      }
      return candidate;
    }

    throw new Error(
      `Cannot allocate port after ${maxAttempts} attempts in range ${start}-${end}`,
    );
  }

  private candidatePorts(
    start: number,
    blockSize: number,
    probeOffsets: readonly number[],
  ): number[] {
    const ports = new Set<number>();
    for (let offset = 0; offset < blockSize; offset++) ports.add(start + offset);
    for (const offset of probeOffsets) ports.add(start + offset);
    return [...ports].filter((port) => port > 0);
  }

  private async probeFree(port: number): Promise<boolean> {
    if (port <= 0) return false;
    return (await this.probe(port)) === 'free';
  }
}
