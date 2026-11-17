// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Detects shell commands that detach part of themselves (`cmd &`,
 * `nohup cmd > log &`, `setsid -f`, `disown`).
 *
 * Every exec becomes a task, and the task follows the shell it started. A job
 * the shell sends off with `&` keeps running after that shell exits, so the
 * task reports "completed" at once while the real work carries on unseen. The
 * agent then polls with sleep loops or starts the job a second time. `exec`
 * rejects these and points at `background: true`, which keeps the job inside
 * the task: it gets a task_id, an output file, and a completion notification.
 *
 * `cmd1 & cmd2 & wait` is allowed, since the shell waits for its jobs.
 */

export interface Segment {
  words: string[]
  /** Operator that ended the segment (`&`, `&&`, `||`, `;`, `|`, `\n`), or '' at the end. */
  terminator: string
}

export interface DetachCheck {
  detached: boolean
  /** What the command does to detach, for the error message. */
  how?: string
  /** The detached job writes its output to a file of its own. */
  ownLog?: boolean
  /** The same job as a single command to run with `background: true`, when there is one. */
  suggestion?: string
}

function readHeredocDelimiter(command: string, index: number): { delimiter: string; end: number } | null {
  let i = index
  if (command[i] === '-') i += 1
  while (command[i] === ' ' || command[i] === '\t') i += 1
  let delimiter = ''
  while (i < command.length && !/[\s;&|<>()]/.test(command[i]!)) {
    const ch = command[i]!
    if (ch === "'" || ch === '"') {
      const close = command.indexOf(ch, i + 1)
      if (close === -1) return null
      delimiter += command.slice(i + 1, close)
      i = close + 1
      continue
    }
    if (ch === '\\') {
      i += 1
      continue
    }
    delimiter += ch
    i += 1
  }
  return delimiter ? { delimiter, end: i } : null
}

/** Splits a command into simple commands at top-level operators, skipping quotes, comments and heredoc bodies. */
export function segmentsOf(command: string): Segment[] {
  const segments: Segment[] = []
  let words: string[] = []
  let word = ''
  const heredocs: string[] = []

  const endWord = () => {
    if (word) words.push(word)
    word = ''
  }
  const endSegment = (terminator: string) => {
    endWord()
    if (words.length > 0) segments.push({ words, terminator })
    words = []
  }

  let i = 0
  while (i < command.length) {
    const ch = command[i]!
    const next = command[i + 1]

    if (ch === '\\') {
      word += next ?? ''
      i += 2
      continue
    }
    if (ch === "'" || ch === '"') {
      const close = command.indexOf(ch, i + 1)
      const stop = close === -1 ? command.length : close
      word += command.slice(i + 1, stop)
      i = stop + 1
      continue
    }
    if (ch === '#' && !word) {
      while (i < command.length && command[i] !== '\n') i += 1
      continue
    }
    if (ch === '\n') {
      endSegment('\n')
      i += 1
      for (const delimiter of heredocs.splice(0)) {
        while (i < command.length) {
          const lineEnd = command.indexOf('\n', i)
          const line = command.slice(i, lineEnd === -1 ? command.length : lineEnd)
          i = lineEnd === -1 ? command.length : lineEnd + 1
          if (line.replace(/^\t+/, '') === delimiter) break
        }
      }
      continue
    }
    if (ch === '<' && next === '<' && command[i + 2] !== '<') {
      const heredoc = readHeredocDelimiter(command, i + 2)
      if (heredoc) {
        endWord()
        heredocs.push(heredoc.delimiter)
        i = heredoc.end
        continue
      }
    }
    if (ch === '&' && next === '&') {
      endSegment('&&')
      i += 2
      continue
    }
    if (ch === '|' && next === '|') {
      endSegment('||')
      i += 2
      continue
    }
    if (ch === '&') {
      const prev = command[i - 1]
      // `2>&1`, `>&2`, `<&3`, `&>file`, `&>>file` are redirections, not jobs.
      if (prev === '>' || prev === '<' || next === '>') {
        word += ch
        i += 1
        continue
      }
      if (command[i - 1] === '|') {
        i += 1
        continue
      }
      endSegment('&')
      i += 1
      continue
    }
    if (ch === ';' || ch === '|') {
      endSegment(ch)
      i += 1
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '(' || ch === ')' || ch === '{' || ch === '}') {
      endWord()
      i += 1
      continue
    }
    word += ch
    i += 1
  }
  endSegment('')
  return segments
}

/** The command name of a simple command, past `VAR=value` assignments. */
export function commandName(words: string[]): string | undefined {
  return words.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w))
}

const REDIRECT = /^(\d*>>?|&>>?)$/
const ATTACHED_REDIRECT = /^(\d*>>?|&>>?)([^&>].*)$/

/** Whether the job sends its output to a file of its own (not /dev/null, not another fd). */
function redirectsToFile(words: string[]): boolean {
  return words.some((w, i) => {
    const target = REDIRECT.test(w) ? words[i + 1] : w.match(ATTACHED_REDIRECT)?.[2]
    return !!target && target !== '/dev/null'
  })
}

export function checkSelfDetach(command: string): DetachCheck {
  const segments = segmentsOf(command)

  for (const [index, segment] of segments.entries()) {
    const name = commandName(segment.words)
    if (name === 'disown') return { detached: true, how: '`disown`' }
    if (name === 'setsid' && segment.words.some((w) => w === '-f' || w === '--fork')) {
      return { detached: true, how: '`setsid -f`' }
    }
    if (segment.terminator !== '&') continue

    const waitedOn = segments.slice(index + 1).some((s) => commandName(s.words) === 'wait')
    if (waitedOn) continue

    const how = name === 'nohup' ? '`nohup … &`' : '`&`'
    return {
      detached: true,
      how,
      ownLog: redirectsToFile(segment.words),
      suggestion:
        segments.length === 1 ? command.replace(/\s*&\s*$/, '').replace(/^\s*nohup\s+/, '').trim() : undefined,
    }
  }
  return { detached: false }
}

export interface PatternSelfMatch {
  /** `pgrep` or `pkill`. */
  program: string
  /** The `-f` pattern that also matches this command's own shell. */
  pattern: string
}

/**
 * Detect `pgrep -f` / `pkill -f` with a pattern that matches the command's own
 * command line (SHO-399).
 *
 * This is the accident that pinned a production VM for 19 hours:
 *
 *   while pgrep -f "…render.ts…"; do sleep 30; done
 *
 * The shell running this command has that pattern in its own argv, so `pgrep -f`
 * finds it every time and the loop never ends. It is not a refusal — the command
 * is legitimate and `pkill -f` legitimately targets other processes — so exec
 * runs it and adds a note steering the agent to `wait` or the bracket trick.
 *
 * A pattern is tested as the regex `pgrep` itself would apply (`-f` matches the
 * whole command line), which is also why `"[r]ender.ts"` comes back clean: that
 * regex needs the text `render.ts`, and the command line has `[r]ender.ts`.
 * `-x`/exact matches never self-match, so only `-f` invocations are considered.
 */
export function findSelfMatchingPattern(command: string): PatternSelfMatch | undefined {
  for (const segment of segmentsOf(command)) {
    // Scan words, not just the first one: `while pgrep -f …; do …; done` puts a
    // shell keyword (and possibly `!` / `time`) in front of the program.
    const start = segment.words.findIndex((w) => {
      const name = w.includes('/') ? w.slice(w.lastIndexOf('/') + 1) : w
      return name === 'pgrep' || name === 'pkill'
    })
    if (start === -1) continue
    const rawName = segment.words[start]!
    const program = rawName.includes('/') ? rawName.slice(rawName.lastIndexOf('/') + 1) : rawName

    let fullLine = false
    const operands: string[] = []
    for (const word of segment.words.slice(start + 1)) {
      if (word === '--') continue
      if (/^-[A-Za-z]+$/.test(word)) {
        if (word.includes('f')) fullLine = true
        continue
      }
      if (word.startsWith('-')) continue
      operands.push(word)
    }
    if (!fullLine) continue
    const pattern = operands[0]
    if (!pattern) continue
    let re: RegExp
    try {
      re = new RegExp(pattern)
    } catch {
      continue // an invalid regex makes pgrep complain; not our business
    }
    if (re.test(command)) return { program, pattern }
  }
  return undefined
}

/** What exec says when the pattern in the command also matches its own shell. */
export function patternSelfMatchHint(match: PatternSelfMatch, taskId?: string): string {
  const waitCall = taskId
    ? `wait({ task_ids: ["${taskId}"], until: '<the output you are waiting for>' })`
    : `wait({ task_ids: [task_id], until: '<the output you are waiting for>' })`
  return (
    `\`${match.program} -f ${match.pattern}\` also matches the shell running this very command, so a loop around it ` +
    'never ends. Wait on the task instead: ' + waitCall + '. If you must poll, use the bracket trick — ' +
    `\`"[${match.pattern[0]}]${match.pattern.slice(1)}"\` — so the pattern no longer matches its own command line.`
  )
}

export function selfDetachRefusal(check: DetachCheck): string {
  const lines = [
    `Not run: this command detaches itself (${check.how}). The task would only follow the launcher, which exits at once, ` +
      'so you would lose track of the job: no completion notice, no exit code, and wait would return immediately.',
  ]
  if (check.suggestion) {
    lines.push(
      `Run it as a background task instead: exec({ command: ${JSON.stringify(check.suggestion)}, background: true }).`,
    )
    if (check.ownLog) {
      lines.push('Its output goes to the task output_file, so drop any redirect that only exists to keep a log.')
    }
  } else {
    lines.push(
      'Split it up: start the long-running part on its own with exec({ command, background: true }) (no `&`, no `nohup`, ' +
        'no redirect to your own log; output goes to the task output_file), then run the rest as separate exec calls. ' +
        'To continue once a server is up, use wait({ task_ids: [id], until: "<ready text>" }).',
    )
  }
  lines.push('Then either wait on the task_id or end your turn; you get a [Task update] when it finishes.')
  return lines.join('\n')
}
