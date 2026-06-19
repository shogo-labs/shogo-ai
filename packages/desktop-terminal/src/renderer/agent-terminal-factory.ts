// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AgentTerminalFactory — creates and manages hidden terminal instances
 * that the agent uses to execute commands without disrupting the user's
 * visible terminal.
 *
 * When the agent needs to run commands, it creates a dedicated "agent
 * terminal" that:
 *   - Runs in the background (not visible to the user unless toggled)
 *   - Has its own Osc633Tracker for output capture
 *   - Can be polled for results
 *   - Gets cleaned up when no longer needed
 *
 * On desktop, this uses the preload IPC to spawn new PTY sessions.
 * On non-desktop (web/mobile), this falls back to the exec tool.
 *
 * Usage:
 *   const factory = createAgentTerminalFactory({ ptyClient })
 *   const instance = await factory.spawn({ cwd: '/path/to/project' })
 *   const result = await instance.sendCommand('npm test')
 *   await instance.dispose()
 */

import { OscDecoder } from '@shogo/pty-core'
import { Osc633Tracker } from './osc633-tracker'
import { AgentTerminalBridge } from './agent-terminal-bridge'
import { backgroundTaskManager } from './background-task-manager'

// ─── types ──────────────────────────────────────────────────────────────

export interface AgentTerminalInstance {
  /** Unique ID for this agent terminal. */
  id: string
  /** The tracker for this terminal's output. */
  tracker: Osc633Tracker
  /** The bridge for sending commands. */
  bridge: AgentTerminalBridge
  /** Current working directory. */
  cwd: string | null
  /** Whether the terminal is still alive. */
  alive: boolean
  /** The command that was sent (last or current). */
  command?: string
  /** Result of the last completed command, if any. */
  commandResult?: import('./agent-terminal-bridge').CommandResult | null
  /** Elapsed time in ms since the command started (for running commands). */
  elapsedMs?: number
  /** Whether this instance has been disposed. */
  disposed?: boolean
  /** Send a command and wait for completion. */
  sendCommand(command: string): Promise<{
    command: string
    exitCode: number | null
    cwd: string | null
    durationMs: number | null
    timedOut: boolean
  }>
  /** Send a command without waiting (background). */
  sendCommandBackground(command: string): import('./agent-terminal-bridge').BackgroundTask | null
  /** Get recent commands from this terminal. */
  getRecentCommands(limit?: number): import('./osc633-tracker').Command[]
  /** Dispose of this terminal and clean up resources. */
  dispose(): Promise<void>
}

export interface AgentTerminalFactoryOptions {
  /**
   * The write function for sending data to the PTY.
   * In desktop mode, this is `window.shogoDesktopTerminal.write(id, data)`.
   * In tests, this can be a mock.
   */
  writeToPty: (sessionId: string, data: string) => Promise<void>
  /**
   * Spawn a new PTY session. Returns the session ID.
   * In desktop mode, this calls `window.shogoDesktopTerminal.spawn(opts)`.
   */
  spawnPty: (opts: {
    cwd?: string
    shell?: string
    cols?: number
    rows?: number
  }) => Promise<{ id: string }>
  /**
   * Kill a PTY session.
   */
  killPty: (sessionId: string) => Promise<void>
  /**
   * Attach to a PTY session to receive data events.
   * Returns a message port for streaming data.
   */
  attachToPty: (sessionId: string) => Promise<{
    onData: (listener: (data: string) => void) => () => void
  }>
  /** Max wait time for commands. Default: 120000. */
  defaultTimeoutMs?: number
}

// ─── factory ────────────────────────────────────────────────────────────

let instanceCounter = 0

export class AgentTerminalFactory {
  private opts: AgentTerminalFactoryOptions
  private instances = new Map<string, AgentTerminalInstance>()

  constructor(opts: AgentTerminalFactoryOptions) {
    this.opts = opts
  }

  /**
   * Spawn a new agent terminal instance. Each instance gets its own
   * PTY session, tracker, and bridge.
   */
  async spawn(opts?: {
    cwd?: string
    shell?: string
  }): Promise<AgentTerminalInstance> {
    const id = `agent-term-${++instanceCounter}`
    const { id: sessionId } = await this.opts.spawnPty({
      cwd: opts?.cwd,
      shell: opts?.shell,
      cols: 120,
      rows: 30,
    })

    const tracker = new Osc633Tracker({
      registerMarker: () => undefined,
    })

    const sendFn = async (data: string) => {
      await this.opts.writeToPty(sessionId, data)
    }

    const bridge = new AgentTerminalBridge({
      tracker,
      send: (data: string) => {
        sendFn(data).catch(() => {})
      },
      commandTimeoutMs: this.opts.defaultTimeoutMs ?? 120_000,
    })

    // Attach to receive PTY data, decode OSC sequences for the tracker, AND
    // feed the human-visible bytes to the bridge so the active command's
    // CommandResult.output is populated (without this, hidden agent terminals
    // detect command boundaries but capture no output).
    const decoder = new OscDecoder()
    const encoder = new TextEncoder()
    const textDecoder = new TextDecoder()
    // The session id of the in-flight background task, so its raw output can be
    // routed to the BackgroundTaskManager's ready-signal/URL detector.
    let activeBgSessionId: string | null = null
    const { onData } = await this.opts.attachToPty(sessionId)
    const offData = onData((data) => {
      const text = typeof data === 'string' ? data : textDecoder.decode(data)
      bridge.feedOutput(text)
      if (activeBgSessionId) backgroundTaskManager.feedOutput(activeBgSessionId, text)
      try {
        const bytes = typeof data === 'string' ? encoder.encode(data) : data
        const decoded = decoder.feed(bytes)
        if (decoded.events.length > 0) {
          tracker.feedAll(decoded.events)
        }
      } catch {
        // Non-OSC data — ignore
      }
    })

    let alive = true

    const instance: AgentTerminalInstance = {
      id,
      tracker,
      bridge,
      cwd: opts?.cwd ?? null,
      get alive() { return alive },
      command: undefined,
      commandResult: null,
      elapsedMs: undefined,
      // Wrap the bridge calls so the instance carries enough state for
      // AgentTerminalPanel to render command + status + elapsed time.
      sendCommand: async (command) => {
        instance.command = command
        instance.commandResult = null
        const startedAt = Date.now()
        instance.elapsedMs = 0
        try {
          const result = await bridge.sendCommand(command)
          instance.commandResult = result
          return result
        } finally {
          instance.elapsedMs = Date.now() - startedAt
        }
      },
      sendCommandBackground: (command) => {
        instance.command = command
        instance.commandResult = null
        const startedAt = Date.now()
        const task = bridge.sendCommandBackground(command)
        // Give the background task a production home in the BackgroundTaskManager
        // so the "N background terminals" UI + ready-signal/URL detection work.
        const bgSessionId = `${id}:${task.id}`
        activeBgSessionId = bgSessionId
        backgroundTaskManager.registerTask({
          sessionId: bgSessionId,
          label: `Agent (${command.slice(0, 48)}${command.length > 48 ? '…' : ''})`,
          command,
          cwd: instance.cwd ?? '',
        })
        void task.promise
          .then((result) => {
            instance.commandResult = result
            instance.elapsedMs = Date.now() - startedAt
            backgroundTaskManager.completeTask(bgSessionId, result.exitCode)
          })
          .catch(() => {
            backgroundTaskManager.completeTask(bgSessionId, null)
          })
          .finally(() => {
            if (activeBgSessionId === bgSessionId) activeBgSessionId = null
          })
        return task
      },
      getRecentCommands: (limit) => bridge.getRecentCommands(limit),
      dispose: async () => {
        alive = false
        instance.disposed = true
        offData()
        bridge.dispose()
        try {
          await this.opts.killPty(sessionId)
        } catch {
          // Session may already be dead
        }
        this.instances.delete(id)
      },
    }

    this.instances.set(id, instance)
    return instance
  }

  /**
   * Get all active agent terminal instances.
   */
  getAll(): AgentTerminalInstance[] {
    return [...this.instances.values()].filter((i) => i.alive)
  }

  /**
   * Get a specific instance by ID.
   */
  get(id: string): AgentTerminalInstance | undefined {
    return this.instances.get(id)
  }

  /**
   * Dispose of all agent terminal instances.
   */
  async disposeAll(): Promise<void> {
    const instances = [...this.instances.values()]
    this.instances.clear()
    await Promise.all(instances.map((i) => i.dispose().catch(() => {})))
  }

  /**
   * Get the number of active agent terminals.
   */
  get count(): number {
    return this.getAll().length
  }
}

// ─── factory function ───────────────────────────────────────────────────

/**
 * Create an AgentTerminalFactory with the given PTY functions.
 *
 * In a real desktop app:
 *
 *   const factory = createAgentTerminalFactory({
 *     writeToPty: (id, data) => window.shogoDesktopTerminal.write(id, data),
 *     spawnPty: (opts) => window.shogoDesktopTerminal.spawn(opts),
 *     killPty: (id) => window.shogoDesktopTerminal.kill(id),
 *     attachToPty: async (id) => {
 *       const { port } = await window.shogoDesktopTerminal.attach(id, 0)
 *       return {
 *         onData: (listener) => {
 *           port.onmessage = (ev) => listener(ev.data)
 *           return () => { port.onmessage = null }
 *         },
 *       }
 *     },
 *   })
 */
export function createAgentTerminalFactory(opts: AgentTerminalFactoryOptions): AgentTerminalFactory {
  return new AgentTerminalFactory(opts)
}
