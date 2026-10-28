// SPDX-License-Identifier: MIT
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
  /** Max times the same tool+input can repeat before triggering (default: 10) */
  maxIdenticalCalls: number
  /** Max times identical outputs can repeat before triggering (default: 10) */
  maxIdenticalOutputs: number
  /** Window size for cycle detection (default: 10) */
  cycleWindowSize: number
  /** Min cycle length to detect (default: 2, e.g. A→B→A→B) */
  minCycleLength: number
  /**
   * Max consecutive *unproductive* turns before triggering the no-progress
   * breaker. A turn is unproductive only when every tool call it made failed,
   * so one parallel batch of failures (one mistake) counts once.
   *
   * **0 (default) = off.** Nothing stops a turn for making no progress unless a
   * caller opts in: `loopDetection: { maxConsecutiveNoProgress: 5 }`. When it is
   * on, it catches an agent thrashing at one unreachable goal with many
   * *different* calls, which the identical/cycle heuristics never see.
   */
  maxConsecutiveNoProgress: number
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
  /** True when the output looks like a failure / error (no forward progress). */
  unproductive: boolean
  /** Index of the turn that issued this call; parallel calls share one. */
  turnIndex: number
}

const DEFAULT_CONFIG: LoopDetectorConfig = {
  maxIdenticalCalls: 10,
  maxIdenticalOutputs: 10,
  cycleWindowSize: 10,
  minCycleLength: 2,
  maxConsecutiveNoProgress: 0,
}

export class LoopDetector {
  private config: LoopDetectorConfig
  private history: ToolCallEntry[] = []
  /** Index of the turn currently collecting calls; advanced by `recordTurnEnd`. */
  private turnIndex = 0
  /** Per closed turn that made at least one call: true when every call failed. */
  private closedTurns: boolean[] = []

  constructor(config: Partial<LoopDetectorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Record a tool call and check for loop patterns.
   * Call this after each tool execution with the tool name, input, and output.
   * Every call from one model turn shares a turn index, so a parallel batch is
   * one turn — not N retries.
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
      unproductive: isUnproductiveOutput(output),
      turnIndex: this.turnIndex,
    }
    this.history.push(entry)

    return this.detect()
  }

  /**
   * Close the current turn and check whether the agent is making no progress
   * across turns. Call this once per model turn, after its tool calls have all
   * been recorded.
   *
   * A turn counts as unproductive only when it made at least one tool call and
   * *every* call failed: five failures from one parallel batch are one mistake,
   * not five retries. A turn with a single success is progress and resets the
   * streak. Turns that made no tool calls are not counted either way.
   */
  recordTurnEnd(): LoopDetectorResult {
    const calls = this.history.filter((e) => e.turnIndex === this.turnIndex)
    if (calls.length > 0) {
      this.closedTurns.push(calls.every((e) => e.unproductive))
    }
    this.turnIndex++

    return this.checkNoProgress()
  }

  /** Reset the detector (e.g. between agent loop runs) */
  reset(): void {
    this.history = []
    this.closedTurns = []
    this.turnIndex = 0
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
   * Check for a run of consecutive unproductive *turns* — the agent is
   * hammering one goal with varied calls but getting nowhere. This is the gap
   * the identical/cycle detectors miss: every call is different, yet no
   * progress is made.
   *
   * Counted per turn, not per call: one turn that fires five failing calls in
   * parallel is a single mistake the model has not even been told about yet, so
   * it must not fill the window by itself.
   *
   * Off by default. `0` means off, and so does `Infinity` — the guard below has
   * to come first, because `slice(-0)` is the whole array and would otherwise
   * trip on the first failed turn.
   */
  private checkNoProgress(): LoopDetectorResult {
    const { maxConsecutiveNoProgress } = this.config
    if (!Number.isFinite(maxConsecutiveNoProgress) || maxConsecutiveNoProgress <= 0) {
      return { loopDetected: false }
    }
    if (this.closedTurns.length < maxConsecutiveNoProgress) {
      return { loopDetected: false }
    }

    const tail = this.closedTurns.slice(-maxConsecutiveNoProgress)
    if (tail.every(Boolean)) {
      return {
        loopDetected: true,
        reason: 'no_progress',
        pattern: `${maxConsecutiveNoProgress} turns in a row where every tool call failed — stop and ask for help instead of retrying`,
      }
    }

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
   * Uses tool name + input + output as the key so that cycles where the
   * output is changing (e.g. edit→test→edit→test with different test results)
   * are treated as progress, not loops.
   */
  private checkCycles(): LoopDetectorResult {
    const { cycleWindowSize, minCycleLength } = this.config
    if (this.history.length < cycleWindowSize) {
      return { loopDetected: false }
    }

    const window = this.history.slice(-cycleWindowSize)
    const keys = window.map((e) => `${e.name}:${e.inputHash}:${e.outputHash}`)

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

const ERROR_TEXT_RE =
  /\b(error|failed|failure|refused|unreachable|denied|forbidden|not\s*found|cannot|could\s*not|couldn'?t|unable|timed\s*out|timeout)\b|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|EAI_AGAIN|\b[45]\d\d\b/i

/**
 * Only the head of free-form text is scanned: tool failures lead with the
 * error, while successful payloads (emails, logs, alerts, CI output) routinely
 * contain words like "error" or numbers like 404 deep in their content.
 */
const ERROR_SCAN_CHARS = 300

function textLooksLikeError(text: string): boolean {
  return ERROR_TEXT_RE.test(text.slice(0, ERROR_SCAN_CHARS))
}

/**
 * Classify whether a tool output represents a failure / lack of progress.
 * Structured signals (exit code, ok/success flags, HTTP status, error field)
 * win; otherwise we scan the head of failure-ish text. Explicit success
 * signals short-circuit to "productive" so we never count a successful step
 * against the agent.
 */
function isUnproductiveOutput(output: any): boolean {
  if (output == null) return false

  if (typeof output === 'string') {
    const trimmed = output.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed)
        if (parsed !== null && typeof parsed === 'object') return isUnproductiveObject(parsed)
      } catch {
        // Not JSON — classify as plain text.
      }
    }
    return textLooksLikeError(trimmed)
  }

  if (typeof output === 'object') return isUnproductiveObject(output)

  return false
}

function isUnproductiveObject(output: any): boolean {
  if (Array.isArray(output)) return false

  // Killed before it could answer (timeout, signal) — a failure whatever it
  // managed to print first.
  if (output.timedOut === true || output.killed === true) return true

  // Explicit success → definitely productive.
  if (output.ok === true || output.success === true || output.successful === true) return false
  if (typeof output.exitCode === 'number' && output.exitCode === 0) return false

  if (typeof output.exitCode === 'number' && output.exitCode !== 0) {
    // SIGPIPE: `cmd | head` closes the pipe once it has enough lines, and the
    // writer reports 141. The command did its job.
    if (output.exitCode === 141) return false
    // Data came back, so the agent learned something whatever the exit code.
    if (typeof output.stdout === 'string' && output.stdout.trim()) return false
    // `grep`/`rg` with no match, `test`, `diff`, `git diff --quiet`: exit 1 with
    // nothing on either stream is a definite "no", not a failure.
    if (output.exitCode === 1 && !(typeof output.stderr === 'string' && output.stderr.trim())) return false
    // 127 command-not-found, a usage error on stderr, grep's exit 2 with a message.
    return true
  }

  // Explicit failure signals.
  if (output.ok === false || output.success === false || output.successful === false) return true
  if (typeof output.status === 'number' && output.status >= 400) return true
  if (output.error != null && output.error !== false && output.error !== '') return true

  // Fall back to scanning the usual error-bearing fields.
  if (typeof output.stderr === 'string' && output.stderr.trim() && ERROR_TEXT_RE.test(output.stderr)) return true
  const text = `${output.message ?? ''} ${output.stdout ?? ''}`.trim()
  if (text) return textLooksLikeError(text)

  return false
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
