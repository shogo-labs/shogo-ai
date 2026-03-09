// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Loop Detector — Circuit Breaker for Agent Tool Loops
 *
 * Monitors tool call patterns within a single agent loop run and detects:
 * 1. Ping-pong: same tool called with identical inputs N times in a row
 * 2. No-progress: tool outputs are identical for N consecutive iterations
 * 3. Rapid cycling: a small set of tools called in a repeating cycle
 *
 * When a loop is detected, the detector signals the agent loop to break
 * early with a diagnostic message.
 */

export interface LoopDetectorConfig {
  /** Max times the same tool+input can repeat before triggering (default: 3) */
  maxIdenticalCalls: number
  /** Max times identical outputs can repeat before triggering (default: 3) */
  maxIdenticalOutputs: number
  /** Window size for cycle detection (default: 6) */
  cycleWindowSize: number
  /** Min cycle length to detect (default: 2, e.g. A→B→A→B) */
  minCycleLength: number
}

export interface LoopDetectorResult {
  loopDetected: boolean
  reason?: string
  pattern?: string
}

interface ToolCallEntry {
  name: string
  inputHash: string
  outputHash: string
}

const DEFAULT_CONFIG: LoopDetectorConfig = {
  maxIdenticalCalls: 3,
  maxIdenticalOutputs: 3,
  cycleWindowSize: 6,
  minCycleLength: 2,
}

export class LoopDetector {
  private config: LoopDetectorConfig
  private history: ToolCallEntry[] = []

  constructor(config: Partial<LoopDetectorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Record a tool call and check for loop patterns.
   * Call this after each tool execution with the tool name, input, and output.
   */
  recordAndCheck(
    name: string,
    input: Record<string, any>,
    output: any
  ): LoopDetectorResult {
    const entry: ToolCallEntry = {
      name,
      inputHash: stableHash(input),
      outputHash: stableHash(output),
    }
    this.history.push(entry)

    return this.detect()
  }

  /** Reset the detector (e.g. between agent loop runs) */
  reset(): void {
    this.history = []
  }

  /** Get the number of recorded tool calls */
  get callCount(): number {
    return this.history.length
  }

  private detect(): LoopDetectorResult {
    const identicalCallResult = this.checkIdenticalCalls()
    if (identicalCallResult.loopDetected) return identicalCallResult

    const identicalOutputResult = this.checkIdenticalOutputs()
    if (identicalOutputResult.loopDetected) return identicalOutputResult

    const cycleResult = this.checkCycles()
    if (cycleResult.loopDetected) return cycleResult

    return { loopDetected: false }
  }

  /**
   * Check if the same tool was called with identical inputs N times in a row.
   */
  private checkIdenticalCalls(): LoopDetectorResult {
    const { maxIdenticalCalls } = this.config
    if (this.history.length < maxIdenticalCalls) {
      return { loopDetected: false }
    }

    const tail = this.history.slice(-maxIdenticalCalls)
    const first = tail[0]
    const allSame = tail.every(
      (e) => e.name === first.name && e.inputHash === first.inputHash
    )

    if (allSame) {
      return {
        loopDetected: true,
        reason: 'identical_calls',
        pattern: `${first.name} called ${maxIdenticalCalls} times with identical input`,
      }
    }

    return { loopDetected: false }
  }

  /**
   * Check if consecutive tool calls produce identical outputs.
   * Only triggers when both the inputs AND outputs are identical — different
   * inputs producing similar success responses (e.g. seeding different data
   * models) is normal progress, not a loop.
   */
  private checkIdenticalOutputs(): LoopDetectorResult {
    const { maxIdenticalOutputs } = this.config
    if (this.history.length < maxIdenticalOutputs) {
      return { loopDetected: false }
    }

    const tail = this.history.slice(-maxIdenticalOutputs)
    const first = tail[0]
    const allSame = tail.every(
      (e) => e.inputHash === first.inputHash && e.outputHash === first.outputHash
    )

    if (allSame) {
      return {
        loopDetected: true,
        reason: 'identical_outputs',
        pattern: `Last ${maxIdenticalOutputs} tool calls produced identical input+output`,
      }
    }

    return { loopDetected: false }
  }

  /**
   * Check for repeating cycles (e.g. A→B→A→B or A→B→C→A→B→C).
   */
  private checkCycles(): LoopDetectorResult {
    const { cycleWindowSize, minCycleLength } = this.config
    if (this.history.length < cycleWindowSize) {
      return { loopDetected: false }
    }

    const window = this.history.slice(-cycleWindowSize)
    const keys = window.map((e) => `${e.name}:${e.inputHash}`)

    for (let cycleLen = minCycleLength; cycleLen <= Math.floor(keys.length / 2); cycleLen++) {
      const cycle = keys.slice(0, cycleLen)
      let isCycle = true

      for (let i = cycleLen; i < keys.length; i++) {
        if (keys[i] !== cycle[i % cycleLen]) {
          isCycle = false
          break
        }
      }

      if (isCycle) {
        const toolNames = window.slice(0, cycleLen).map((e) => e.name)
        return {
          loopDetected: true,
          reason: 'cycle',
          pattern: `Repeating cycle detected: ${toolNames.join(' → ')} (${Math.floor(keys.length / cycleLen)} repetitions)`,
        }
      }
    }

    return { loopDetected: false }
  }
}

/**
 * Produce a stable string hash of an object for comparison.
 * Uses sorted JSON stringification for deterministic output.
 */
function stableHash(value: any): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return value.length > 200 ? value.substring(0, 200) : value
  try {
    return JSON.stringify(value, Object.keys(value).sort())
  } catch {
    return String(value)
  }
}
